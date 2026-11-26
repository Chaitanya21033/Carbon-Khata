"""Live plant + SSE, production events, energy (EMS), emissions & reports, public QR pages, credits, FMCG, cluster."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import threading
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from .. import events
from ..db import get_db, session_scope
from ..domain import cluster as CL
from ..domain import fmcg as FM
from ..domain.emissions import period_totals
from ..domain.exports import brsr_csv, brsr_p6, canonical, cbam_file, lender_pack, oem_csv, passport_json, to_csv
from ..domain.grid import CEA_EF, GENSET_EF, SOURCES, market_day
from ..domain.ledger import now_iso, uid, value
from ..domain.measures import MEASURE_SEED, portfolio
from ..domain.util import fy_months
from ..live import registry
from ..live.twin import iso_to_plant_ms, month_of, plant_ms_to_iso
from ..models import (Batch, BatchLotUsage, BatchTest, ClusterFeed, ClusterMember, ClusterNeed, CreditAllocation, CreditVintage, EmsDecision, EmsSettings, ExchangeAccrual,
                      ExchangeAgreement, ExchangeLine, MarketBlock, MaterialLot, OemSupplierLink, Passport, PoolBlock, PoolDay, ProductionEvent, Recall, Tenant, TenantSetting,
                      VerificationRequest)
from ..security import Ctx, PLANT_ROLES, audit, current, plant_tenant_for, require
from ..services import integrations, ledger as svc

r = APIRouter(prefix="/api/v1")
CUSTODY = ("custodian", "owner")
PLANT_VIEW = ("operator", "custodian", "owner", "admin")
BUFFER = 0.1
CLUSTER_ID = "adityapur"


# ======================================================================== live plant + stream
@r.get("/live/state", tags=["live"])
def live_state(ctx: Ctx = Depends(require(*PLANT_VIEW, "cluster", "device")), db: Session = Depends(get_db)):
    tid = "vbw" if ctx.role in ("admin", "cluster") else ctx.tenant_id
    tw = registry.get_twin(tid)
    if tw is None:
        raise HTTPException(404, "No live feed for this plant")
    return tw.snapshot()


@r.get("/stream", tags=["live"])
async def stream(request: Request, ctx: Ctx = Depends(current)):
    """Server-Sent Events: twin snapshots, data-flow packets, ledger changes, EMS decisions, passports, batches, cluster."""
    tenants = None if ctx.role in ("admin", "cluster") else {ctx.tenant_id, CLUSTER_ID, "afl"}
    if ctx.role == "oem":
        tenants = {CLUSTER_ID, "afl", "vbw"} if ctx.tenant_kind == "brand" else {"vbw"}
    kinds = {"passport", "batch"} if ctx.role == "oem" else None
    sub = events.subscribe(tenants, kinds)

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    kind, data = await asyncio.wait_for(sub.q.get(), timeout=15)
                    yield f"event: {kind}\ndata: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            events.unsubscribe(sub)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ProdEvent(BaseModel):
    kind: str
    serial: int
    ts: Any
    oem: Optional[str] = None
    order: Optional[str] = None
    steelKg: Optional[float] = None
    station: Optional[int] = None


@r.post("/production/events", tags=["live"])
def production_event(body: ProdEvent, ctx: Ctx = Depends(require("device", "operator", "custodian")), db: Session = Depends(get_db)):
    """Line events (body started / moved station / finished). Idempotent on (serial, kind, station)."""
    clock = iso_to_plant_ms(body.ts)
    ex = db.scalars(select(ProductionEvent.id).where(ProductionEvent.tenant_id == ctx.tenant_id, ProductionEvent.serial == body.serial, ProductionEvent.kind == body.kind,
                                                     ProductionEvent.station == body.station)).first()
    if ex:
        return {"duplicate": True}
    db.add(ProductionEvent(tenant_id=ctx.tenant_id, serial=body.serial, kind=body.kind, station=body.station, payload=body.model_dump(exclude={"ts"}), ts=dt.datetime.fromisoformat(plant_ms_to_iso(clock))))
    db.commit()
    tw = registry.get_twin(ctx.tenant_id)
    if tw:
        with registry._lock:
            tw.production({**body.model_dump(), "ts": clock})
        registry.push_snapshot(tw)
    return {"ok": True}


class IngestIn(BaseModel):
    messages: list[dict]


@r.post("/ingest/messages", tags=["live"])
def ingest_messages(body: IngestIn, ctx: Ctx = Depends(require("device"))):
    """HTTP alternative to MQTT for gateways that cannot reach a broker: the same topics and payloads
    (plant/{plantId}/meter/…, asset/…, ems/request, device/…/status). Returns the EMS setpoint when one was requested."""
    return registry.handle_http(ctx.tenant_id, body.messages)


# ======================================================================== energy
def _twin(ctx: Ctx):
    tw = registry.get_twin("vbw" if ctx.role == "admin" else ctx.tenant_id)
    if tw is None:
        raise HTTPException(404, "No energy system for this plant")
    return tw


@r.get("/energy/market", tags=["energy"])
def energy_market(date: Optional[str] = None, ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    """96 fifteen-minute blocks: DAM, G-DAM, RTM, DISCOM ToD tariff, regional net demand, marginal EF, stress."""
    d = dt.date.fromisoformat(date) if date else (dt.date(1970, 1, 1) + dt.timedelta(days=registry.plant_now_ms() // 86_400_000))
    di = (d - dt.date(1970, 1, 1)).days
    rows = db.scalars(select(MarketBlock).where(MarketBlock.date == d.isoformat()).order_by(MarketBlock.block)).all()
    if len(rows) != 96:
        ad = integrations.market_adapter()
        blocks = ad.day(di)
        for b in blocks:
            db.merge(MarketBlock(date=d.isoformat(), block=b["block"], dam=b["dam"], gdam=b["gdam"], rtm=b["rtm"], discom=b["discom"], grid_demand_gw=b["gridDemandGW"],
                                 solar_gw=b["solarGW"], net_demand_gw=b["netDemandGW"], marginal_ef=b["marginalEf"], stress=b["stress"], source=ad.name))
        db.commit()
        return {"date": d.isoformat(), "source": ad.name, "blocks": blocks}
    return {"date": d.isoformat(), "source": rows[0].source, "blocks": [{"block": x.block, "dam": x.dam, "gdam": x.gdam, "rtm": x.rtm, "discom": x.discom, "gridDemandGW": x.grid_demand_gw,
                                                                         "solarGW": x.solar_gw, "netDemandGW": x.net_demand_gw, "marginalEf": x.marginal_ef, "stress": x.stress} for x in rows]}


@r.get("/energy/forecast", tags=["energy"])
def energy_forecast(ctx: Ctx = Depends(current)):
    f = integrations.solar_forecast()
    return {**f, "expectedKwh48h": integrations.pv_kwh(f["hours"], 250), "kwp": 250}


@r.get("/energy/grid-intensity", tags=["energy"])
def grid_intensity(ctx: Ctx = Depends(current)):
    return integrations.grid_carbon(CEA_EF * 1000)


@r.get("/energy/plan", tags=["energy"])
def energy_plan(ctx: Ctx = Depends(require(*PLANT_VIEW))):
    tw = _twin(ctx)
    e = tw.ems
    return {"plan": e.plan, "settings": vars(e.settings), "soc": e.soc, "market": e.market, "tomorrow": e.tomorrow, "block": tw.block}


@r.get("/energy/decisions", tags=["energy"])
def energy_decisions(limit: int = 60, ctx: Ctx = Depends(require(*PLANT_VIEW)), db: Session = Depends(get_db)):
    tid = "vbw" if ctx.role == "admin" else ctx.tenant_id
    rows = db.scalars(select(EmsDecision).where(EmsDecision.tenant_id == tid).order_by(desc(EmsDecision.id)).limit(min(limit, 500))).all()
    return [{"ts": d.ts.isoformat(), "block": d.block, "mode": d.mode, "reason": d.reason, "savedInr": d.saved_inr, "avoidedKg": d.avoided_kg, "plan": d.plan} for d in rows]


@r.get("/energy/twin", tags=["energy"])
def energy_twin(ctx: Ctx = Depends(require(*PLANT_VIEW))):
    """Optimised plant vs the naive twin (same load, no optimiser): today and the rolling last 24 h."""
    e = _twin(ctx).ems
    t, n = e.today, e.naive
    return {"today": t, "naive": n, "savingPct": (1 - t["costInr"] / n["costInr"]) * 100 if n["costInr"] else None,
            "eveningCutPct": (t["peakEveningImportKwh"] / n["peakEveningKwh"] - 1) * 100 if n["peakEveningKwh"] else None, "last24": e.last24() if e.block_log else None, "totals": e.totals}


class SettingsIn(BaseModel):
    enabled: Optional[bool] = None
    carbonPrice: Optional[float] = None
    greenCapKw: Optional[float] = None
    reserveSoc: Optional[float] = None
    solver: Optional[str] = None


@r.get("/energy/settings", tags=["energy"])
def get_settings(ctx: Ctx = Depends(require(*PLANT_VIEW))):
    return vars(_twin(ctx).ems.settings)


@r.put("/energy/settings", tags=["energy"])
def put_settings(body: SettingsIn, ctx: Ctx = Depends(require(*CUSTODY, "device")), db: Session = Depends(get_db)):
    tw = _twin(ctx)
    s = registry.ems_settings_of(db, tw.tenant_id)
    patch = body.model_dump(exclude_none=True)
    if "solver" in patch and patch["solver"] not in ("rules", "lp"):
        raise HTTPException(422, "solver must be rules or lp")
    for k, v in patch.items():
        setattr(tw.ems.settings, k, v)
    s.enabled, s.carbon_price, s.green_cap_kw, s.reserve_soc, s.solver = tw.ems.settings.enabled, tw.ems.settings.carbonPrice, tw.ems.settings.greenCapKw, tw.ems.settings.reserveSoc, tw.ems.settings.solver
    audit(db, ctx.actor, ctx.role, "ems_settings", "EMS", json.dumps(patch), tw.tenant_id, commit=False)
    db.commit()
    if "enabled" in patch:
        tw.log("info", "Grid-aware optimiser ON." if patch["enabled"] else "Optimiser OFF: plant buys everything from the DISCOM (comparison mode).")
    registry.replan(tw.tenant_id)
    registry.push_snapshot(tw, True)
    return vars(tw.ems.settings)


class MarketEvent(BaseModel):
    kind: str  # priceSpike | cloud | drCall | clear
    ts: Any
    minutes: Optional[int] = None
    value: Optional[float] = None


@r.post("/energy/market/events", tags=["energy"])
def market_event(body: MarketEvent, ctx: Ctx = Depends(require("device")), db: Session = Depends(get_db)):
    """Feed events from the market-data / DISCOM adapters: RTM price spike, RTM uplift under cloud, demand-response call."""
    tw = registry.get_twin("vbw")
    clock = iso_to_plant_ms(body.ts)
    with registry._lock:
        if body.kind == "priceSpike":
            tw.ems.spike_until = clock + (body.minutes or 30) * 60_000
            tw.log("warn", "IEX real-time price hit the ₹10/kWh ceiling. EMS re-planning the block.")
        elif body.kind == "cloud":
            tw.ems.cloud = body.value or 0
            tw.log("info", "Heavy cloud: solar output falling, EMS shifts to battery and green power." if tw.ems.cloud else "Cloud cleared: solar recovering.")
        elif body.kind == "drCall":
            tw.ems.stress_event_until = clock + (body.minutes or 45) * 60_000
            tw.ems.dr_events += 1
            tw.log("warn", "DISCOM demand-response call: grid under stress, load-shedding risk. EMS: battery + genset on, non-critical loads paused, exporting surplus.")
        registry.replan(tw.tenant_id)
    registry.push_snapshot(tw, True)
    return {"ok": True}


@r.get("/energy/compare-lp", tags=["energy"])
def compare_lp(ctx: Ctx = Depends(require(*PLANT_VIEW))):
    """Day-ahead linear programme (PuLP/CBC) on yesterday's metered load and solar, vs the rule-based dispatch actually run."""
    from ..services.lp import optimise
    tw = _twin(ctx)
    return optimise(tw.ems)


# ======================================================================== emissions & reports
def _inp(db: Session, tid: str, months: list[str]) -> dict:
    st = svc.state(db, tid)
    t = db.get(Tenant, tid)
    return {"supplier": t.name, "plant": t.plant_name, "product": (t.meta or {}).get("product", {}).get("name", "unit"), "oemVendorCode": "VBW-0412", "registers": st["registers"],
            "idx": st["repIdx"], "factors": st["factors"], "months": months, "dq": st["dq"], "issues": st["issues"], "issueStates": st["issueStates"],
            "closed": {m: c["status"] == "closed" for m, c in st["closes"].items()}}


@r.get("/emissions/summary", tags=["reports"])
def emissions_summary(period: Optional[str] = None, supplier: Optional[str] = None, ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    """period: YYYY-MM, 'FY2025' (Apr 2025–Mar 2026) or omitted for the last 12 months. Held lines are excluded."""
    tid = plant_tenant_for(db, ctx, supplier)
    st = svc.state(db, tid)
    rows = st["emissions"]
    if period and period.startswith("FY"):
        ms = set(fy_months(int(period[2:])))
        rows = [r for r in rows if r["month"] in ms]
    elif period:
        rows = [r for r in rows if r["month"] == period]
    else:
        rows = rows[-12:]
    return {"months": rows, "totals": period_totals(rows), "dqAvg": st["dqAvg"]}


def _pp(p: Passport) -> dict:
    return registry.passport_json(p)


@r.get("/passports", tags=["reports"])
def passports(oem: Optional[str] = None, limit: int = 300, ctx: Ctx = Depends(require(*PLANT_VIEW, "oem")), db: Session = Depends(get_db)):
    """Per-part carbon passports. An OEM sees only its own parts from suppliers that granted access."""
    q = select(Passport).order_by(desc(Passport.finished_at)).limit(min(limit, 2000))
    if ctx.role == "oem":
        if ctx.tenant_kind != "oem":
            raise HTTPException(403, "Part passports are for vehicle OEMs")
        sid = plant_tenant_for(db, ctx)
        q = q.where(Passport.oem_code == ctx.tenant_code, Passport.tenant_id == sid)
        others = db.scalar(select(func.count()).select_from(Passport).where(Passport.tenant_id == sid, Passport.oem_code != ctx.tenant_code))
    else:
        tid = plant_tenant_for(db, ctx)
        q = q.where(Passport.tenant_id == tid)
        if oem:
            q = q.where(Passport.oem_code == oem)
        others = 0
    return {"passports": [_pp(p) for p in db.scalars(q).all()], "hiddenOtherOems": others}


@r.get("/passports/{serial}", tags=["reports"])
def passport(serial: int, ctx: Ctx = Depends(require(*PLANT_VIEW, "oem")), db: Session = Depends(get_db)):
    p = db.scalars(select(Passport).where(Passport.serial == serial)).first()
    if not p:
        raise HTTPException(404, "No passport")
    if ctx.role == "oem" and p.oem_code != ctx.tenant_code:
        raise HTTPException(403, "This part was made for another OEM")
    if ctx.role in PLANT_ROLES and p.tenant_id != ctx.tenant_id:
        raise HTTPException(403, "Other tenants' data is not visible")
    return _pp(p)


@r.get("/reports/oem/{oem}", tags=["reports"])
def oem_report(oem: str, format: str = "json", ctx: Ctx = Depends(require(*CUSTODY, "oem", "admin")), db: Session = Depends(get_db)):
    """OEM supplier file (json | csv | passports | cbam). Built from the ledger and the passports issued to that OEM."""
    oem = oem.upper()
    if ctx.role == "oem" and ctx.tenant_code != oem:
        raise HTTPException(403, "You can only download your own file")
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    months = st["plantMonths"][-12:]
    c = canonical(_inp(db, tid, months))
    ps = [_pp(p) for p in db.scalars(select(Passport).where(Passport.tenant_id == tid, Passport.oem_code == oem).order_by(Passport.finished_at)).all()]
    audit(db, ctx.actor, ctx.role, "export", f"OEM {oem} file", format, tid)
    if format == "csv":
        return PlainTextResponse(oem_csv(c), media_type="text/csv")
    if format == "passports":
        return PlainTextResponse(to_csv([["serial", "order", "finished_at", "kwh", "scope1_kg", "scope2_kg", "steel_kg_co2e", "steel_kg", "renewable_share", "total_kg"],
                                         *[[p["id"], p["order"], p["finishedAt"], round(p["kwh"], 1), round(p["s1"], 2), round(p["s2"], 2), round(p["steel"], 1), p["steelKg"], round(p["renewableShare"], 3), round(p["total"], 1)] for p in ps]]), media_type="text/csv")
    if format == "cbam":
        from ..live.twin import OEMS
        tw = registry.get_twin(tid)
        return cbam_file(ps, db.get(Tenant, tid).name, (tw.oems if tw else OEMS)[oem], st["gridEf"])
    return {**c, "passports": {"count": len(ps), "avg_total_kg": sum(p["total"] for p in ps) / len(ps) if ps else None}}


@r.get("/reports/brsr/p6", tags=["reports"])
def brsr(fy: Optional[int] = None, format: str = "json", ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    """BRSR Principle 6 indicators for a financial year (default: the last 12 closed-or-open history months)."""
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    months = [m for m in st["plantMonths"] if m in set(fy_months(fy))] if fy else st["plantMonths"][-12:]
    if not months:
        raise HTTPException(404, "No data for that year")
    inp = _inp(db, tid, months)
    c = canonical(inp)
    turnover = sum(value(st["idx"], "TURNOVER_INR", m, "reading") or 0 for m in months) or None
    rows = brsr_p6(c, inp, turnover)
    audit(db, ctx.actor, ctx.role, "export", "BRSR P6", f"{months[0]}–{months[-1]}", tid)
    if format == "csv":
        return PlainTextResponse(brsr_csv(rows), media_type="text/csv")
    return {"period": {"from": months[0], "to": months[-1]}, "rows": rows, "totals": c["totals"]}


@r.get("/reports/pcf", tags=["reports"])
def pcf(ctx: Ctx = Depends(require(*CUSTODY, "oem", "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    return passport_json(canonical(_inp(db, tid, st["plantMonths"][-12:])), st["dqAvg"])


@r.get("/reports/lender-pack", tags=["reports"])
def lender(ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    ms = (db.get(TenantSetting, (tid, "measures")) or TenantSetting(value=MEASURE_SEED)).value
    return lender_pack(canonical(_inp(db, tid, st["plantMonths"][-12:])), portfolio(ms, st["tariff"], st["gridEf"]), st["tariff"], st["dqAvg"])


# ======================================================================== public QR pages (no login)
@r.get("/public/part/{code}", tags=["public"])
def public_part(code: str, db: Session = Depends(get_db)):
    p = db.scalars(select(Passport).where(Passport.public_code == code)).first()
    if not p:
        raise HTTPException(404, "Unknown code")
    t = db.get(Tenant, p.tenant_id)
    return {"kind": "part", "code": code, "product": "Tipper body", "maker": t.name, "plant": t.plant_name, "serial": f"VBW-{p.serial:05d}", "finished": p.finished_at.isoformat(),
            "inspection": "Passed final inspection", "carbon": {"plant_kg": round(p.s1 + p.s2, 1), "steel_kg": round(p.steel), "total_kg": round(p.total), "renewable_share": round(p.renewable_share, 3)},
            "note": "Gate-to-gate plant emissions plus purchased steel. Demo data; fictional company."}


@r.get("/public/batch/{code}", tags=["public"])
def public_batch(code: str, db: Session = Depends(get_db)):
    b = db.scalars(select(Batch).where(Batch.public_code == code)).first()
    if not b:
        raise HTTPException(404, "Unknown code")
    ev = _eval_batches(db, b.tenant_id, [b])[0]
    st = ev["status"]
    return {"kind": "batch", "code": code, "batch": ev["id"], "product": ev["product"]["name"], "brand": FM.BRANDS[ev["product"]["brand"]]["name"], "maker": FM.CO_PACKER["name"],
            "fssai": FM.CO_PACKER["fssai"], "mfg": ev["mfg"], "exp": ev["exp"], "mrp": ev["product"]["mrp"],
            "status": "RECALLED – do not eat. Return to the shop for a refund." if st == "recalled" else "Released after quality checks" if st == "released" else "Not yet released",
            "recalled": st == "recalled", "tests": [{"name": t["name"], "result": t["status"]} for t in ev["tests"] if t["stage"] != "in-process"],
            "carbon_g_per_pack": round(ev["carbon"]["perPackG"]), "note": "Demo data; fictional brands and company."}


# ======================================================================== credits
def credits_state(db: Session, tid: str) -> dict:
    alloc = db.scalars(select(CreditAllocation).where(CreditAllocation.tenant_id == tid, CreditAllocation.project == "SOLAR").order_by(desc(CreditAllocation.version))).first()
    vint = {v.month: {"status": v.status, "history": v.history, "serials": v.serials, "tonnes": v.tonnes, "buyer": v.buyer}
            for v in db.scalars(select(CreditVintage).where(CreditVintage.tenant_id == tid)).all()}
    price = db.get(TenantSetting, (tid, "creditPrice"))
    return {"alloc": {"SOLAR": alloc.credits_share if alloc else 0.6, "EE": 0.0}, "vintages": vint, "pricePerT": price.value if price else 900, "bufferPct": BUFFER}


@r.get("/credits/vintages", tags=["credits"])
def vintages(ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    """Monthly solar vintages: net tonnes = solar kWh × grid EF × (1 − 10 % buffer), split credits / OEM claim."""
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    cs = credits_state(db, tid)
    share = cs["alloc"]["SOLAR"]
    out = []
    for m in [*st["plantMonths"], st["openMonth"]]:
        kwh = value(st["idx"], "SOLAR_KWH", m, "reading") or 0
        if kwh <= 0:
            continue
        gross = kwh * st["gridEf"] / 1000
        net = gross * (1 - BUFFER)
        out.append({"month": m, "kwh": kwh, "gross": gross, "net": net, "credit": net * share, "oem": net * (1 - share), "dq": st["dq"].get(m), **cs["vintages"].get(m, {"status": "monitoring", "history": []})})
    return {"rows": out, "share": share, "gridEf": st["gridEf"]}


class AllocIn(BaseModel):
    share: float
    project: str = "SOLAR"


@r.put("/credits/allocation", tags=["credits"])
def set_alloc(body: AllocIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    """Credits share + OEM-claim share always sum to 1 (double-counting guard)."""
    if not 0 <= body.share <= 1:
        raise HTTPException(422, "Share must be between 0 and 1")
    last = db.scalars(select(CreditAllocation).where(CreditAllocation.tenant_id == ctx.tenant_id, CreditAllocation.project == body.project).order_by(desc(CreditAllocation.version))).first()
    db.add(CreditAllocation(tenant_id=ctx.tenant_id, project=body.project, credits_share=body.share, oem_claim_share=round(1 - body.share, 6), version=(last.version + 1) if last else 1, set_by=ctx.actor))
    audit(db, ctx.actor, ctx.role, "claim_allocation", body.project, f"{round(body.share * 100)}% to carbon credits, {round((1 - body.share) * 100)}% to OEM value-chain claim", ctx.tenant_id, commit=False)
    db.commit()
    events.publish(ctx.tenant_id, "ledger", {"credits": True})
    return credits_state(db, ctx.tenant_id)


class PriceIn(BaseModel):
    price: float


@r.put("/credits/price", tags=["credits"])
def set_price(body: PriceIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    db.merge(TenantSetting(tenant_id=ctx.tenant_id, key="creditPrice", value=body.price)); db.commit()
    return credits_state(db, ctx.tenant_id)


class VerifyIn(BaseModel):
    month: str
    tonnes: float


STEPS = [("submitted", "ESG custodian", 0), ("validated", "Verifier desk review (demo verifier adapter)", 2.5), ("verified", "Accredited verifier site check (demo verifier adapter)", 5.5), ("issued", "Registry (demo adapter)", 8)]


def _advance(tid: str, month: str, status: str, by: str, tonnes: float):
    with session_scope() as db:
        v = db.get(CreditVintage, (tid, month)) or CreditVintage(tenant_id=tid, month=month, status="monitoring", history=[])
        v.status = status
        v.history = [*v.history, {"status": status, "at": now_iso(), "by": by}]
        if status == "issued":
            n = max(1, int(tonnes))
            v.tonnes, v.serials = float(int(tonnes)), f"CK-DEMO-{month.replace('-', '')}-000001 … {n:06d}"
        db.merge(v)
        audit(db, by, "verifier", f"credit_{status}", f"Vintage {month}", f"{int(tonnes)} t issued (demo serials)" if status == "issued" else by, tid, commit=False)
    events.publish(tid, "ledger", {"credits": month, "status": status})


@r.post("/credits/verify", tags=["credits"])
def verify(body: VerifyIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    """Submit a vintage: submitted → validated → verified → issued (demo verifier/registry adapter, a few seconds apart)."""
    db.add(VerificationRequest(id=uid("vr"), tenant_id=ctx.tenant_id, month=body.month, tonnes=body.tonnes, verifier="Demo verifier", status="submitted")); db.commit()
    for status, by, delay in STEPS:
        threading.Timer(delay, _advance, args=(ctx.tenant_id, body.month, status, by if status != "submitted" else ctx.actor, body.tonnes)).start()
    return {"ok": True}


class RetireIn(BaseModel):
    month: str
    buyer: str


@r.post("/credits/transfer", tags=["credits"])
def transfer(body: RetireIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    v = db.get(CreditVintage, (ctx.tenant_id, body.month))
    if not v or v.status != "issued":
        raise HTTPException(409, "Only issued vintages can be transferred")
    v.buyer = body.buyer
    audit(db, ctx.actor, ctx.role, "credit_transfer", f"Vintage {body.month}", f"Transferred to {body.buyer}", ctx.tenant_id, commit=False)
    db.commit()
    return credits_state(db, ctx.tenant_id)


# ======================================================================== FMCG
def fmcg_state(db: Session, tid: str) -> dict:
    return {"recalledLots": [l.code for l in db.scalars(select(MaterialLot).where(MaterialLot.tenant_id == tid, MaterialLot.flagged.is_(True))).all()],
            "overrides": {f"{t.batch_code}|{t.name}": t.override for t in db.scalars(select(BatchTest).where(BatchTest.tenant_id == tid, BatchTest.override.is_not(None))).all()},
            "notified": sorted({l for rc in db.scalars(select(Recall).where(Recall.tenant_id == tid)).all() if rc.notified for l in [rc.lot]})}


def _fmcg_tenant(ctx: Ctx) -> tuple[str, Optional[str]]:
    if ctx.tenant_kind == "brand":
        return "afl", ctx.tenant_code
    if ctx.role == "admin":
        return "afl", None
    if ctx.tenant_id == "afl":
        return "afl", None
    raise HTTPException(403, "Batch tracing is for the co-packer and its brand owners")


def _eval_batches(db: Session, tid: str, rows: list[Batch]) -> list[dict]:
    st = fmcg_state(db, tid)
    flagged = set(st["recalledLots"])
    clock = registry.plant_now_utc_ms()
    grid = svc.factor_for(svc.factors(db), "EF_GRID_IN", month_of(registry.plant_now_ms()))["kgco2e_per_unit"] if hasattr(svc, "factor_for") else CEA_EF
    codes = [b.code for b in rows]
    res: dict = {}
    for t in db.scalars(select(BatchTest).where(BatchTest.tenant_id == tid, BatchTest.batch_code.in_(codes))).all():
        res.setdefault(t.batch_code, {})[t.name] = t
    out = []
    for b in rows:
        rec = dict(b.record)
        got = res.get(b.code, {})
        rec["tests"] = [{**t, "value": got[t["name"]].value if t["name"] in got and got[t["name"]].value is not None else "—", "ok": bool(got[t["name"]].ok) if t["name"] in got else True} for t in rec["tests"]]
        results = {n: 1 for n, t in got.items() if t.value is not None}
        ev = FM.evaluate(rec, clock, flagged, st["overrides"], grid, 0.0, results)
        ev["publicCode"] = b.public_code
        out.append(ev)
    return out


@r.get("/fmcg/batches", tags=["fmcg"])
def batches(limit: int = 48, ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    tid, brand = _fmcg_tenant(ctx)
    q = select(Batch).where(Batch.tenant_id == tid, Batch.start <= registry.plant_now_utc_ms()).order_by(desc(Batch.idx)).limit(min(limit, 500))
    if brand:
        q = q.where(Batch.brand_code == brand)
    return {"batches": _eval_batches(db, tid, list(db.scalars(q).all())), "coPacker": FM.CO_PACKER, "brands": FM.BRANDS, "materials": FM.MATERIALS, "distributors": FM.DISTRIBUTORS,
            "state": fmcg_state(db, tid), "clock": registry.plant_now_utc_ms()}


@r.get("/fmcg/lots", tags=["fmcg"])
def lots(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    tid, brand = _fmcg_tenant(ctx)
    q = select(Batch).where(Batch.tenant_id == tid, Batch.start <= registry.plant_now_utc_ms()).order_by(desc(Batch.idx)).limit(200)
    if brand:
        q = q.where(Batch.brand_code == brand)
    ev = _eval_batches(db, tid, list(db.scalars(q).all()))
    flagged = {l.code: l for l in db.scalars(select(MaterialLot).where(MaterialLot.tenant_id == tid)).all()}
    return [{**l, "flagged": bool(flagged.get(l["lot"]) and flagged[l["lot"]].flagged), "supplier": FM.MATERIALS[l["material"]]["supplier"]} for l in FM.lot_index(ev)]


class BatchIn(BaseModel):
    code: str
    index: int
    productId: str
    line: str
    start: int
    end: int
    microAt: int
    lots: list[dict]
    tests: list[dict]
    outputKg: float
    inputKg: float
    yieldPct: float


@r.post("/fmcg/batches", tags=["fmcg"])
def post_batch(body: BatchIn, ctx: Ctx = Depends(require("device")), db: Session = Depends(get_db)):
    """Line MES reports a batch: product, slot, ingredient lots used and the QC test plan. Idempotent on code."""
    tid = ctx.tenant_id
    if db.get(Batch, (tid, body.code)):
        return {"duplicate": True}
    rec = body.model_dump()
    rec["tests"] = [{k: t[k] for k in ("stage", "name", "spec", "by", "at")} for t in body.tests]
    db.add(Batch(tenant_id=tid, code=body.code, idx=body.index, product_id=body.productId, brand_code=FM.PRODUCTS[body.productId]["brand"], start=body.start, end=body.end, record=rec,
                 public_code=f"Q{tid.upper()}{body.code.replace('-', '')}"))
    for l in body.lots:
        db.merge(BatchLotUsage(tenant_id=tid, batch_code=body.code, lot=l["lot"], kg=l["kg"]))
        if not db.get(MaterialLot, (tid, l["lot"])):
            db.add(MaterialLot(tenant_id=tid, code=l["lot"], material=l["material"], supplier=FM.MATERIALS[l["material"]]["supplier"]))
            db.flush()
    db.commit()
    events.publish(tid, "batch", {"code": body.code})
    return {"ok": True}


class TestIn(BaseModel):
    name: str
    value: str
    ok: bool
    at: int
    by: Optional[str] = None


@r.post("/fmcg/batches/{code}/tests", tags=["fmcg"])
def post_test(code: str, body: TestIn, ctx: Ctx = Depends(require("device", "custodian", "owner")), db: Session = Depends(get_db)):
    """QC lab / line result. A failed test holds the batch (release gate) and blocks dispatch."""
    tid = "afl" if not ctx.device else ctx.tenant_id
    t = db.get(BatchTest, (tid, code, body.name)) or BatchTest(tenant_id=tid, batch_code=code, name=body.name)
    t.value, t.ok, t.at, t.by = body.value, body.ok, body.at, body.by or ctx.actor
    db.merge(t); db.commit()
    events.publish(tid, "batch", {"code": code})
    return {"ok": True}


class OverrideIn(BaseModel):
    status: str


@r.post("/fmcg/batches/{code}/tests/{name}/override", tags=["fmcg"])
def override_test(code: str, name: str, body: OverrideIn, ctx: Ctx = Depends(require("custodian", "owner")), db: Session = Depends(get_db)):
    tid, _ = _fmcg_tenant(ctx)
    t = db.get(BatchTest, (tid, code, name)) or BatchTest(tenant_id=tid, batch_code=code, name=name)
    t.override = body.status
    db.merge(t)
    audit(db, ctx.actor, ctx.role, "qc_result", code, f"{name}: {body.status}", tid, commit=False)
    db.commit()
    events.publish(tid, "batch", {"code": code})
    return fmcg_state(db, tid)


class RecallIn(BaseModel):
    lot: str
    reason: str = "Supplier reported a contaminated lot"


def _recall(db: Session, tid: str, lot: str, reason: str, by: str) -> dict:
    ml = db.get(MaterialLot, (tid, lot))
    if not ml:
        raise HTTPException(404, "Unknown lot")
    ml.flagged, ml.flag_reason = True, reason
    used = [u.batch_code for u in db.scalars(select(BatchLotUsage).where(BatchLotUsage.tenant_id == tid, BatchLotUsage.lot == lot)).all()]
    rc = Recall(id=uid("rc"), tenant_id=tid, lot=lot, reason=reason, created_by=by, batches=used)
    db.add(rc)
    audit(db, by, "custodian", "lot_recall", lot, reason, tid, commit=False)
    db.commit()
    events.publish(tid, "batch", {"recall": lot})
    return {"recall": rc.id, "lot": lot, "batches": used}


@r.post("/fmcg/recall", tags=["fmcg"])
def recall(body: RecallIn, ctx: Ctx = Depends(require("custodian", "owner", "device")), db: Session = Depends(get_db)):
    """Flag a lot: every finished batch that used it becomes RECALLED (traced through lot usage), packs and distributors listed."""
    tid = ctx.tenant_id if ctx.device else _fmcg_tenant(ctx)[0]
    if body.lot == "auto-spice":  # supplier notice for "the seasoning lot in the latest batches" (simulated supplier feed)
        b = db.scalars(select(Batch).where(Batch.tenant_id == tid, Batch.product_id == "MC50", Batch.end <= registry.plant_now_utc_ms()).order_by(desc(Batch.idx))).first()
        if not b:
            raise HTTPException(404, "No finished batch with a seasoning lot yet")
        body.lot = next(l["lot"] for l in b.record["lots"] if l["material"] == "spice")
    return _recall(db, tid, body.lot, body.reason, ctx.actor)


@r.get("/fmcg/recall", tags=["fmcg"])
def recalls(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    tid, _ = _fmcg_tenant(ctx)
    out = []
    for rc in db.scalars(select(Recall).where(Recall.tenant_id == tid).order_by(desc(Recall.created_at))).all():
        bs = _eval_batches(db, tid, [db.get(Batch, (tid, c)) for c in rc.batches if db.get(Batch, (tid, c))])
        out.append({"id": rc.id, "lot": rc.lot, "reason": rc.reason, "closed": rc.closed, "notified": rc.notified, "batches": [b["id"] for b in bs if b["status"] == "recalled"],
                    "packs": sum(d["packs"] for b in bs if b["status"] == "recalled" for d in b["dispatch"]), "distributors": sorted({d["to"] for b in bs if b["status"] == "recalled" for d in b["dispatch"]})})
    return out


class NotifyIn(BaseModel):
    lot: str
    who: list[str]


@r.post("/fmcg/recall/notify", tags=["fmcg"])
def notify(body: NotifyIn, ctx: Ctx = Depends(require("custodian", "owner")), db: Session = Depends(get_db)):
    tid, _ = _fmcg_tenant(ctx)
    for rc in db.scalars(select(Recall).where(Recall.tenant_id == tid, Recall.lot == body.lot)).all():
        rc.notified = [*rc.notified, *body.who]
    audit(db, ctx.actor, ctx.role, "recall_notice", body.lot, f"Notified: {', '.join(body.who)}", tid, commit=False)
    db.commit()
    return fmcg_state(db, tid)


@r.post("/fmcg/lots/{lot}/clear", tags=["fmcg"])
def clear_lot(lot: str, ctx: Ctx = Depends(require("custodian", "owner")), db: Session = Depends(get_db)):
    tid, _ = _fmcg_tenant(ctx)
    ml = db.get(MaterialLot, (tid, lot))
    if ml:
        ml.flagged = False
    for rc in db.scalars(select(Recall).where(Recall.tenant_id == tid, Recall.lot == lot)).all():
        rc.closed, rc.notified = True, []
    audit(db, ctx.actor, ctx.role, "lot_recall_closed", lot, "Cleared after investigation", tid, commit=False)
    db.commit()
    events.publish(tid, "batch", {"cleared": lot})
    return fmcg_state(db, tid)


# ======================================================================== cluster
def cluster_note(db: Session, t: int, tone: str, text: str):
    db.add(ClusterFeed(cluster_id=CLUSTER_ID, t=t, tone=tone, text=text))
    events.publish(CLUSTER_ID, "cluster", {"note": text})


def _members(db: Session) -> list[dict]:
    return [{**m.data, "active": m.active, "tenantId": m.tenant_id} for m in db.scalars(select(ClusterMember).where(ClusterMember.cluster_id == CLUSTER_ID)).all()]


def _agreements(db: Session, clock: int) -> list[dict]:
    out = []
    for a in db.scalars(select(ExchangeAgreement).where(ExchangeAgreement.cluster_id == CLUSTER_ID)).all():
        out.append({**a.data, "status": a.status, "senderShare": a.sender_share, "claim": a.claim, "paused": clock < (a.paused_until or 0), "active": a.status == "agreed"})
    return out


def _cluster_view(ctx: Ctx):
    if ctx.role not in ("cluster", "owner", "custodian", "admin") and not ctx.device:
        raise HTTPException(403, "Cluster view is for members and the coordinator")


@r.get("/cluster/members", tags=["cluster"])
def cluster_members(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    _cluster_view(ctx)
    return {"cluster": CL.CLUSTER_NAME, "members": _members(db), "pool": CL.POOL_NODE, "you": ctx.tenant_id if ctx.role in PLANT_ROLES else None, "oaThresholdKw": CL.OA_THRESHOLD_KW,
            "constants": {"traderMargin": CL.TRADER_MARGIN, "dsmTol": CL.DSM_TOL, "dsmRate": CL.DSM_RATE, "hedgeShare": CL.HEDGE_SHARE, "hedgeRate": CL.HEDGE_RATE, "solarKwp": CL.SOLAR_KWP, "solarTariff": CL.SOLAR_TARIFF}}


@r.get("/cluster/pool/today", tags=["cluster"])
def pool_today(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    """Block-by-block pool settlement for today: schedule vs actual, individual vs pooled deviation and DSM charges, cost vs going alone."""
    _cluster_view(ctx)
    clock = registry.plant_now_ms()
    d = (dt.date(1970, 1, 1) + dt.timedelta(days=clock // 86_400_000)).isoformat()
    rows = db.scalars(select(PoolBlock).where(PoolBlock.cluster_id == CLUSTER_ID, PoolBlock.date == d).order_by(PoolBlock.block)).all()
    return {"date": d, "rows": [{**x.settlement, "readings": x.readings} for x in rows], "market": market_day(clock // 86_400_000, 0.6 if any((x.flags or {}).get("cloud") for x in rows[-1:]) else 0),
            "flags": rows[-1].flags if rows else {}}


@r.get("/cluster/exchanges", tags=["cluster"])
def cluster_exchanges(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    _cluster_view(ctx)
    clock = registry.plant_now_ms()
    ag = _agreements(db, clock)
    needs = db.scalars(select(ClusterNeed).where(ClusterNeed.cluster_id == CLUSTER_ID, ClusterNeed.open.is_(True))).all()
    need_props = {n.match_proposal for n in needs}
    props = [a for a in ag if a["status"] == "proposed" and (a["id"] != "p-offcut" or "p-offcut" in need_props)]
    lines = db.scalars(select(ExchangeLine).where(ExchangeLine.cluster_id == CLUSTER_ID).order_by(desc(ExchangeLine.t)).limit(60)).all()
    feed = db.scalars(select(ClusterFeed).where(ClusterFeed.cluster_id == CLUSTER_ID).order_by(desc(ClusterFeed.id)).limit(30)).all()
    return {"exchanges": [a for a in ag if a["status"] == "agreed"], "proposals": props,
            "ledger": [{"id": l.id, "t": l.t, "exchange": l.agreement_id, "what": next((a["what"] for a in ag if a["id"] == l.agreement_id), ""), "from": l.sender, "to": l.receiver, "sent": l.sent_qty,
                        "received": l.received_qty, "unit": l.unit, "status": l.status} for l in lines],
            "feed": [{"t": f.t, "tone": f.tone, "text": f.text} for f in feed], "flowColor": CL.FLOW_COLOR, "flowLabel": CL.FLOW_LABEL}


def _post_line(db: Session, clock: int, a: dict, sent: float, received: float) -> ExchangeLine:
    st = CL.reconcile(sent, received)
    ln = ExchangeLine(id=f"cx-{clock}-{a['id']}-{uid('l')[-4:]}", cluster_id=CLUSTER_ID, agreement_id=a["id"], t=clock, sender=a["from"], receiver=a["to"][0], sent_qty=sent, received_qty=received,
                      unit=a["unit"], status=st, confirmed_by=["sender-weighbridge", "receiver-weighbridge"] if st == "reconciled" else ["sender-weighbridge"])
    db.add(ln)
    if st == "mismatch":
        cluster_note(db, clock, "bad", f"Weighbridge mismatch on {a['what'].lower()}: sent {sent} {a['unit']}, received {received} {a['unit']}. Held until both sides confirm.")
    return ln


@r.post("/cluster/exchanges/{xid}/agree", tags=["cluster"])
def agree(xid: str, ctx: Ctx = Depends(require("cluster", "owner", "custodian", "admin")), db: Session = Depends(get_db)):
    a = db.get(ExchangeAgreement, (CLUSTER_ID, xid))
    if not a or a.status != "proposed":
        raise HTTPException(404, "No open proposal")
    clock = registry.plant_now_ms()
    a.status, a.agreed_at = "agreed", dt.datetime.now(dt.timezone.utc)
    for n in db.scalars(select(ClusterNeed).where(ClusterNeed.match_proposal == xid)).all():
        n.open = False
    cluster_note(db, clock, "ok", f"Exchange agreed: {a.data['what']}. Both plants' registers now carry a paired dispatch and receipt line.")
    q = round(a.data["qty"] / 30, 2)
    _post_line(db, clock, {**a.data}, q, q)
    audit(db, ctx.actor, ctx.role, "exchange_agree", xid, a.data["what"], CLUSTER_ID, commit=False)
    db.commit()
    return {"ok": True}


class SplitIn(BaseModel):
    senderShare: Optional[float] = None
    claim: Optional[str] = None


@r.put("/cluster/exchanges/{xid}/split", tags=["cluster"])
def set_split(xid: str, body: SplitIn, ctx: Ctx = Depends(require("cluster", "admin")), db: Session = Depends(get_db)):
    a = db.get(ExchangeAgreement, (CLUSTER_ID, xid))
    if not a:
        raise HTTPException(404, "No exchange")
    if body.senderShare is not None:
        a.sender_share = max(0.0, min(1.0, body.senderShare))
    if body.claim:
        if body.claim not in ("receiver", "sender", "split", "consumption"):
            raise HTTPException(422, "claim must be receiver | sender | split | consumption")
        a.claim = body.claim
    audit(db, ctx.actor, ctx.role, "exchange_split", xid, f"sender {a.sender_share:.2f}, claim {a.claim}", CLUSTER_ID, commit=False)
    db.commit()
    return {"ok": True}


@r.post("/cluster/exchange-lines/{lid}/confirm", tags=["cluster"])
def confirm_line(lid: str, ctx: Ctx = Depends(require("cluster", "owner", "custodian", "admin")), db: Session = Depends(get_db)):
    """Both sides agree on the corrected weight: the held line becomes 'resolved' with received = sent."""
    ln = db.get(ExchangeLine, lid)
    if not ln:
        raise HTTPException(404, "No line")
    ln.status, ln.received_qty = "resolved", ln.sent_qty
    ln.confirmed_by = [*ln.confirmed_by, ctx.actor]
    audit(db, ctx.actor, ctx.role, "exchange_line_confirm", lid, f"{ln.sent_qty} {ln.unit}", CLUSTER_ID, commit=False)
    db.commit()
    return {"ok": True}


@r.get("/cluster/scoreboard", tags=["cluster"])
def scoreboard(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    """Year-to-date (from 1 April): sums of exchange accrual rows and daily pool settlements."""
    _cluster_view(ctx)
    fy = CL.FY_START_ISO
    acc = db.execute(select(func.sum(ExchangeAccrual.inr), func.sum(ExchangeAccrual.tco2), func.sum(ExchangeAccrual.m3), func.sum(ExchangeAccrual.mwh), func.sum(ExchangeAccrual.t_mat))
                     .where(ExchangeAccrual.cluster_id == CLUSTER_ID, ExchangeAccrual.date >= fy)).one()
    pool = db.execute(select(func.sum(PoolDay.solo_cost - PoolDay.pooled_cost), func.sum(PoolDay.indiv_pen - PoolDay.pooled_pen)).where(PoolDay.cluster_id == CLUSTER_ID, PoolDay.date >= fy)).one()
    by_x = {x: (inr, t) for x, inr, t in db.execute(select(ExchangeAccrual.agreement_id, func.sum(ExchangeAccrual.inr), func.sum(ExchangeAccrual.tco2))
                                                    .where(ExchangeAccrual.cluster_id == CLUSTER_ID, ExchangeAccrual.date >= fy).group_by(ExchangeAccrual.agreement_id)).all()}
    return {"inr": acc[0] or 0, "t": acc[1] or 0, "m3": acc[2] or 0, "mwh": acc[3] or 0, "tMat": acc[4] or 0, "poolInr": pool[0] or 0, "penAvoided": pool[1] or 0, "since": fy,
            "byExchange": {k: {"inr": v[0], "t": v[1]} for k, v in by_x.items()}}


@r.get("/cluster/split", tags=["cluster"])
def benefit_split(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    """Gain-sharing (₹) and carbon-claim owner per exchange: every tonne is claimed exactly once."""
    _cluster_view(ctx)
    sb = scoreboard(ctx, db)
    out = []
    for a in _agreements(db, registry.plant_now_ms()):
        if a["status"] != "agreed":
            continue
        inr, t = sb["byExchange"].get(a["id"], {"inr": 0, "t": 0}).values()
        claim = a["claim"]
        owners = {"receiver": a["to"], "sender": [a["from"]], "split": [a["from"], *a["to"]], "consumption": a["to"]}[claim]
        out.append({"id": a["id"], "what": a["what"], "from": a["from"], "to": a["to"], "inr": inr, "senderInr": inr * a["senderShare"], "receiverInr": inr * (1 - a["senderShare"]),
                    "tco2": t, "claim": claim, "claimOwners": owners, "claimPerOwner": t / len(owners) if owners else 0, "claimNote": a["claimNote"]})
    return {"rows": out, "totalClaimed": sum(r["claimPerOwner"] * len(r["claimOwners"]) for r in out), "totalAvoided": sum(r["tco2"] for r in out)}


# ---- cluster data feed (member meters, weighbridges, member notices) ----
class PoolIn(BaseModel):
    date: str
    block: int
    readings: dict[str, list[float]]
    cloud: bool = False
    spike: bool = False
    ts: int


def accrue(db: Session, date: str, clock: int, minutes: float):
    for a in _agreements(db, clock):
        if a["status"] != "agreed" or a["paused"]:
            continue
        months = minutes / (30.4 * 24 * 60)
        row = db.get(ExchangeAccrual, (CLUSTER_ID, a["id"], date)) or ExchangeAccrual(cluster_id=CLUSTER_ID, agreement_id=a["id"], date=date, inr=0, tco2=0, m3=0, mwh=0, t_mat=0)
        row.inr += a["inrPerMonth"] * months; row.tco2 += a["tco2PerMonth"] * months
        row.m3 += a.get("m3PerMonth", 0) * months; row.mwh += a.get("mwhPerMonth", 0) * months; row.t_mat += a.get("tMatPerMonth", 0) * months
        db.merge(row)


@r.post("/cluster/feed/pool", tags=["cluster"])
def feed_pool(body: PoolIn, ctx: Ctx = Depends(require("device")), db: Session = Depends(get_db)):
    """One 15-minute block of member meter data (schedule, actual kW). Settles the block and accrues exchanges."""
    if db.get(PoolBlock, (CLUSTER_ID, body.date, body.block)):
        return {"duplicate": True}
    di = (dt.date.fromisoformat(body.date) - dt.date(1970, 1, 1)).days
    mb = market_day(di, 0.6 if body.cloud else 0)[body.block]
    s = CL.settle_block(body.block, {k: (v[0], v[1]) for k, v in body.readings.items()}, mb, body.cloud, body.spike)
    db.add(PoolBlock(cluster_id=CLUSTER_ID, date=body.date, block=body.block, readings=body.readings, settlement=s, flags={"cloud": body.cloud, "spike": body.spike}))
    pd = db.get(PoolDay, (CLUSTER_ID, body.date)) or PoolDay(cluster_id=CLUSTER_ID, date=body.date, solo_cost=0, pooled_cost=0, indiv_pen=0, pooled_pen=0, blocks=0)
    pd.solo_cost += s["soloCost"]; pd.pooled_cost += s["pooledCost"]; pd.indiv_pen += s["indivPen"]; pd.pooled_pen += s["pooledPen"]; pd.blocks += 1
    db.merge(pd)
    accrue(db, body.date, body.ts, 15)
    db.commit()
    events.publish(CLUSTER_ID, "cluster", {"block": body.block})
    return {"ok": True, "settlement": s}


class LineIn(BaseModel):
    agreementId: str
    sent: float
    received: float
    ts: int


@r.post("/cluster/feed/weighbridge", tags=["cluster"])
def feed_weighbridge(body: LineIn, ctx: Ctx = Depends(require("device")), db: Session = Depends(get_db)):
    """Sender and receiver weighbridge tickets for one load. >2 % apart → held as a mismatch."""
    a = next((x for x in _agreements(db, body.ts) if x["id"] == body.agreementId), None)
    if not a:
        raise HTTPException(404, "No agreement")
    ln = _post_line(db, body.ts, a, body.sent, body.received)
    db.commit()
    events.publish(CLUSTER_ID, "cluster", {"line": ln.id})
    return {"id": ln.id, "status": ln.status}


class ClusterEventIn(BaseModel):
    kind: str
    ts: int


@r.post("/cluster/feed/event", tags=["cluster"])
def feed_event(body: ClusterEventIn, ctx: Ctx = Depends(require("device")), db: Session = Depends(get_db)):
    """Member notices: over-draw, join / leave, a material need, heat-exchanger trip / restore."""
    k, t = body.kind, body.ts
    if k == "overdraw":
        cluster_note(db, t, "warn", "Shakti Engineering is drawing 45% above its schedule (unplanned second shift). The pool absorbs it against members running under.")
    elif k in ("join", "leave"):
        m = db.get(ClusterMember, (CLUSTER_ID, "tool"))
        m.active = k == "join"
        cluster_note(db, t, "ok" if m.active else "info", "Precision Tool Room joined (160 kW). Too small for open access alone; it buys through the pool from the next block." if m.active else "Precision Tool Room left the pool.")
    elif k == "scrapShort":
        db.add(ClusterNeed(cluster_id=CLUSTER_ID, member_id="fdy", what="14 t/month more steel scrap", match_proposal="p-offcut"))
        cluster_note(db, t, "warn", "Subarnarekha Castings posted a need: 14 t/month more steel scrap. One match found inside the cluster.")
    elif k in ("heatTrip", "heatRestore"):
        for a in db.scalars(select(ExchangeAgreement).where(ExchangeAgreement.cluster_id == CLUSTER_ID)).all():
            if a.data["kind"] == "heat":
                a.paused_until = t + 180 * 60_000 if k == "heatTrip" else 0
        cluster_note(db, t, "bad" if k == "heatTrip" else "ok", "Heat exchanger at Dalma Forgings tripped. Heat flows paused; the paint shop falls back to its PNG burner." if k == "heatTrip" else "Heat exchanger back in service.")
    else:
        raise HTTPException(422, "Unknown event")
    db.commit()
    events.publish(CLUSTER_ID, "cluster", {"event": k})
    return {"ok": True}


# ======================================================================== ops (demo reset; disabled in production by config)
@r.post("/ops/reset-demo", tags=["ops"], include_in_schema=False)
def reset_demo(ctx: Ctx = Depends(require("device", "admin")), db: Session = Depends(get_db)):
    from ..config import settings
    if not settings.demo_reset_enabled:
        raise HTTPException(403, "Demo reset is disabled on this server")
    db.rollback()  # release this request's own read locks before TRUNCATE
    db.close()
    from ..seed.run import reset_all
    reset_all()
    return {"ok": True}
