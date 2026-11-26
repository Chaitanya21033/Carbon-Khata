"""Live twins per plant + the MQTT ingestion loop (smart-meter frames, EMS plan requests, device status).

Topics (plantId = tenant id):
  plant/{plantId}/meter/{meterId}        1-minute readings; `incomer` closes the minute's frame
  plant/{plantId}/asset/{assetId}        solar, bess, genset, flex controller readings
  plant/{plantId}/ems/request            site controller asks for the block plan   → API replies on ems/setpoint
  plant/{plantId}/ems/replan             API → site controller: settings or grid event changed, ask again
  plant/{plantId}/device/{deviceId}/status   phones / gateways online-offline
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import threading
import time
from typing import Optional

from sqlalchemy import select

from .. import events
from ..config import settings
from ..db import session_scope
from ..models import EmsDecision, EmsSettings, LedgerEntry, MeterReading, OemSteelFactor, Passport, PlantState, Tenant
from .twin import IST, PlantTwin, iso_to_plant_ms, plant_ms_to_iso

log = logging.getLogger("carbonkhata.live")
TWINS: dict[str, PlantTwin] = {}
_lock = threading.RLock()
_mqtt = None
_last_push: dict[str, float] = {}


def wall_plant_ms() -> int:
    n = dt.datetime.now(IST).replace(tzinfo=None)
    return int((n - dt.datetime(1970, 1, 1)).total_seconds() * 1000)


def plant_now_ms() -> int:
    clocks = [t.clock for t in TWINS.values() if t.clock]
    return max(clocks) if clocks else wall_plant_ms()


def plant_now_utc_ms() -> int:
    return plant_now_ms() - int(5.5 * 3_600_000)


def _to_dt(clock: int) -> dt.datetime:
    return dt.datetime.fromisoformat(plant_ms_to_iso(clock))


# ---------------- persistence hooks ----------------
def _post_ledger(tenant_id: str):
    def fn(req: dict):
        from ..security import Ctx
        from ..services import ledger as ledger_svc
        twin = TWINS.get(tenant_id)
        ctx = Ctx(user_id="gateway", name=req.get("by", "Meter gateway"), email="", role="device", tenant_id=tenant_id, tenant_kind="plant", device=True)
        try:
            with session_scope() as db:
                res = ledger_svc.post(db, ctx, tenant_id, req)
        except Exception as e:  # closed month etc. – meter roll-ups are skipped, not lost: interval data stays in meter_reading
            log.warning("roll-up not posted: %s", e)
            return
        if twin and res["result"] in ("posted", "held"):
            twin.entry_result(req, res["result"], (res.get("hold") or {}).get("rule"), (res.get("hold") or {}).get("reason"), _held_item(res, req))
    return fn


def _held_item(res: dict, req: dict) -> Optional[dict]:
    if res["result"] != "held":
        return None
    e = res["entry"]
    return {"id": e["id"], "t": e.get("at"), "device": req.get("_device") or "stores", "registerId": e["registerId"], "line": e["line"], "qty": e["qty"],
            "suggested": res["hold"].get("suggested"), "rule": res["hold"]["rule"], "reason": res["hold"]["reason"], "docRef": e.get("docRef"), "month": e["month"]}


def _on_passport(p: dict):
    with session_scope() as db:
        exists = db.scalars(select(Passport.id).where(Passport.tenant_id == p["tenant"], Passport.serial == p["id"])).first()
        if exists:
            return
        db.add(Passport(tenant_id=p["tenant"], serial=p["id"], oem_code=p["oem"], order_no=p["order"], started_at=_to_dt(p["started"]), finished_at=_to_dt(p["t"]), kwh=p["kwh"],
                        s1=p["s1"], s2=p["s2"], steel=p["steel"], steel_kg=p["steelKg"], renewable_share=p["renewableShare"], total=p["total"],
                        public_code=f"P{p['tenant'].upper()}{p['id']:05d}", factor_versions={"grid": "EF_GRID_IN", "genset": "EF_PNG/3.3", "steel": f"OEM {p['oem']}"}))
    events.publish(p["tenant"], "passport", {"serial": p["id"], "oem": p["oem"]})


def _on_block(rec: dict):
    with session_scope() as db:
        db.add(EmsDecision(tenant_id=rec["tenant"], ts=_to_dt(rec["t"]), block=rec["block"], mode=rec["mode"], reason=rec["text"], plan=rec["plan"], log=rec["log"],
                           saved_inr=rec["savedInr"], avoided_kg=rec["avoidedKg"]))


def _on_interval(rec: dict):
    ts = _to_dt(rec["ts"])
    v = rec["values"]
    with session_scope() as db:
        for mid in ("comp", "weld", "paint", "light", "util"):
            db.merge(MeterReading(tenant_id=rec["tenant"], meter_id=mid, ts=ts, kwh=v[mid], kw=v[mid] * 4))
        db.merge(MeterReading(tenant_id=rec["tenant"], meter_id="incomer", ts=ts, kwh=v["import"], kw=v["import"] * 4, kva=rec["kvaAvg"], pf=rec["pf"]))
        db.merge(MeterReading(tenant_id=rec["tenant"], meter_id="export", ts=ts, kwh=v["export"], kw=v["export"] * 4))
        db.merge(MeterReading(tenant_id=rec["tenant"], meter_id="solar", ts=ts, kwh=v["solar"], kw=v["solar"] * 4))


def _emit(tenant_id: str):
    def fn(kind: str, payload: dict):
        events.publish(tenant_id, kind, payload)
    return fn


def ems_settings_of(db, tenant_id: str) -> EmsSettings:
    s = db.get(EmsSettings, tenant_id)
    if s is None:
        s = EmsSettings(tenant_id=tenant_id)
        db.add(s); db.commit()
    return s


def get_twin(tenant_id: str) -> Optional[PlantTwin]:
    with _lock:
        if tenant_id in TWINS:
            return TWINS[tenant_id]
        with session_scope() as db:
            t = db.get(Tenant, tenant_id)
            if not t or t.kind != "plant" or not (t.meta or {}).get("live"):
                return None
            steel = {f.oem_code: f.kg_per_kg for f in db.scalars(select(OemSteelFactor).order_by(OemSteelFactor.version)).all()}
            tw = PlantTwin(tenant_id, t.contract_kva or 450, steel, post_ledger=_post_ledger(tenant_id), emit=_emit(tenant_id), on_passport=_on_passport, on_block=_on_block,
                           on_meter_interval=_on_interval)
            s = ems_settings_of(db, tenant_id)
            tw.ems.settings.enabled, tw.ems.settings.carbonPrice, tw.ems.settings.greenCapKw, tw.ems.settings.reserveSoc, tw.ems.settings.solver = s.enabled, s.carbon_price, s.green_cap_kw, s.reserve_soc, s.solver
            _restore(db, tw)
            from ..services import integrations
            tw.ems.market_source = integrations.market_adapter().day
        TWINS[tenant_id] = tw
        return tw


def _restore(db, tw: PlantTwin):
    ps = db.get(PlantState, tw.tenant_id)
    if ps and ps.state:
        s = ps.state
        tw.clock = s.get("clock", 0)
        tw.day_index = tw.clock // 86_400_000 if tw.clock else -1
        tw.today.update(s.get("today", {}))
        tw.totals.update(s.get("totals", {}))
        tw.meter_cum = s.get("meterCum", tw.meter_cum)
        tw.ems.soc = s.get("soc", tw.ems.soc)
        for k in ("today", "naive", "totals"):
            if s.get(f"ems_{k}"):
                getattr(tw.ems, k).update(s[f"ems_{k}"])
        tw.ems.block_log = s.get("blockLog", [])
        tw.tokens = s.get("tokens", [])
        tw.events = s.get("events", [])
        tw.series = s.get("series", [])
        tw.machine_alerts = s.get("machineAlerts", [])
    rows = db.scalars(select(Passport).where(Passport.tenant_id == tw.tenant_id).order_by(Passport.finished_at.desc()).limit(300)).all()
    tw.passports = [passport_json(p) for p in rows]
    dec = db.scalars(select(EmsDecision).where(EmsDecision.tenant_id == tw.tenant_id).order_by(EmsDecision.id.desc()).limit(60)).all()
    tw.ems.decisions = [{"t": d.log.get("t"), "block": d.block, "text": d.reason, "mode": d.mode, "savedInr": d.saved_inr, "avoidedKg": d.avoided_kg} for d in dec]
    from ..services.ledger import held_items
    tw.quarantine = held_items(db, tw.tenant_id)


def passport_json(p: Passport) -> dict:
    from .twin import iso_to_plant_ms
    return {"id": p.serial, "oem": p.oem_code, "order": p.order_no, "t": iso_to_plant_ms(p.finished_at.isoformat()), "started": iso_to_plant_ms(p.started_at.isoformat()), "kwh": p.kwh,
            "s1": p.s1, "s2": p.s2, "steel": p.steel, "steelKg": p.steel_kg, "total": p.total, "renewableShare": p.renewable_share, "publicCode": p.public_code,
            "finishedAt": p.finished_at.isoformat()}


def save_state(tw: PlantTwin):
    s = {"clock": tw.clock, "today": tw.today, "totals": tw.totals, "meterCum": tw.meter_cum, "soc": tw.ems.soc, "ems_today": tw.ems.today, "ems_naive": tw.ems.naive,
         "ems_totals": tw.ems.totals, "blockLog": tw.ems.block_log, "tokens": tw.tokens, "events": tw.events[:60], "series": tw.series[-120:], "machineAlerts": tw.machine_alerts}
    with session_scope() as db:
        db.merge(PlantState(tenant_id=tw.tenant_id, state=json.loads(json.dumps(s, default=float)), updated_at=dt.datetime.now(dt.timezone.utc)))


def push_snapshot(tw: PlantTwin, force: bool = False):
    nowt = time.monotonic()
    if not force and nowt - _last_push.get(tw.tenant_id, 0) < 1.0:
        return
    _last_push[tw.tenant_id] = nowt
    events.publish(tw.tenant_id, "twin", tw.snapshot(passports=False))


def reset_twin(tenant_id: str):
    with _lock:
        TWINS.pop(tenant_id, None)


# ---------------- MQTT ----------------
_frames: dict[tuple, dict] = {}
_last_save: dict[str, float] = {}


def _handle(topic: str, payload: dict):
    parts = topic.split("/")
    if len(parts) < 3 or parts[0] != "plant":
        return None
    tenant = parts[1]
    tw = get_twin(tenant)
    if tw is None:
        return None
    kind = parts[2]
    with _lock:
        result = None
        if kind == "ems" and parts[3] == "request":
            sp = tw.request_plan(payload)
            result = {**sp, "reqId": payload.get("reqId")}
            publish(f"plant/{tenant}/ems/setpoint", result)
        elif kind in ("meter", "asset"):
            ts = iso_to_plant_ms(payload["ts"])
            fr = _frames.setdefault((tenant, ts), {"meters": {}, "assets": {}})
            if kind == "meter" and parts[3] == "incomer":
                if payload.get("glitch"):
                    tw.telemetry({"ts": ts, "glitch": payload["glitch"]})
                    _frames.pop((tenant, ts), None)
                else:
                    _frames.pop((tenant, ts), None)
                    tw.telemetry(assemble(ts, fr, payload))
            elif kind == "meter":
                fr["meters"][parts[3]] = payload.get("kw", 0)
            else:
                fr["assets"][parts[3]] = payload
            for k in [k for k in _frames if k[0] == tenant and k[1] < ts - 10 * 60_000]:
                _frames.pop(k, None)
        elif kind == "device":
            tw.device_status(parts[3], bool(payload.get("online")), int(payload.get("queued", 0)))
    push_snapshot(tw)
    if time.monotonic() - _last_save.get(tenant, 0) > 15:
        _last_save[tenant] = time.monotonic()
        save_state(tw)
    return result


_replan_pending: dict[str, bool] = {}


def handle_http(tenant: str, messages: list[dict]) -> dict:
    """No-broker mode: the same messages as MQTT, posted over HTTP by a gateway. Replies carry the setpoint
    (for an ems/request) and whether the controller must ask for a new plan."""
    sp = None
    for m in messages:
        topic = m["topic"]
        if topic.split("/")[1:2] != [tenant]:
            continue
        r = _handle(topic, m["payload"])
        if r is not None:
            sp = r
    return {"setpoint": sp, "replan": _replan_pending.pop(tenant, False)}


def assemble(ts: int, fr: dict, inc: dict) -> dict:
    """Smart-meter minute frame → flows the twin accounts. Base load = Σ sub-meters (flexible load metered separately)."""
    m = fr["meters"]
    a = fr["assets"]
    sol, bess, gen, flex = a.get("solar", {}), a.get("bess", {}), a.get("genset", {}), a.get("flex", {})
    imp = inc.get("importBySource", {})
    flows = {"load": inc.get("loadKw", 0), "flexRun": flex.get("runKw", 0), "solar": sol.get("kw", 0), "bessOut": bess.get("outKw", 0), "bessIn": bess.get("inKw", 0),
             "genset": gen.get("kw", 0), "green": imp.get("green", 0), "rtm": imp.get("rtm", 0), "dam": imp.get("dam", 0), "discom": imp.get("discom", 0),
             "export": inc.get("exportKw", 0), "curtail": sol.get("curtailKw", 0), "shed": inc.get("shedKw", 0)}
    base = sum(m.get(k, 0) for k in ("comp", "weld", "paint", "light", "util"))
    return {"ts": ts, "meters": m, "flows": flows, "baseKw": base, "flexGenKw": flex.get("demandKw", 0), "flexPendingKwh": flex.get("pendingKwh", 0), "gridDown": bool(inc.get("gridDown")),
            "soc": bess.get("soc"), "pf": inc.get("pf", 0.945), "kva": inc.get("kva"), "dgKw": inc.get("dgKw", 0)}


def publish(topic: str, payload: dict):
    if _mqtt is not None:
        _mqtt.publish(topic, json.dumps(payload, default=float), qos=0)


def replan(tenant_id: str):
    tw = TWINS.get(tenant_id)
    if tw:
        tw.ems.replan()
    _replan_pending[tenant_id] = True
    publish(f"plant/{tenant_id}/ems/replan", {"at": time.time()})


def start_mqtt():
    global _mqtt
    if not settings.mqtt_enabled:
        return
    import paho.mqtt.client as mqtt

    def on_connect(c, userdata, flags, rc, props=None):
        c.subscribe([("plant/+/meter/+", 0), ("plant/+/asset/+", 0), ("plant/+/ems/request", 0), ("plant/+/device/+/status", 0)])
        log.info("MQTT connected to %s:%s", settings.mqtt_host, settings.mqtt_port)

    def on_message(c, userdata, msg):
        try:
            _handle(msg.topic, json.loads(msg.payload))
        except Exception:
            log.exception("MQTT message failed on %s", msg.topic)

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"carbonkhata-api-{int(time.time())}")
    c.on_connect = on_connect
    c.on_message = on_message
    c.reconnect_delay_set(1, 10)
    try:
        c.connect_async(settings.mqtt_host, settings.mqtt_port, keepalive=30)
        c.loop_start()
        _mqtt = c
    except Exception as e:
        log.warning("MQTT not available (%s); meter feed disabled until the broker is up", e)


def stop_mqtt():
    if _mqtt is not None:
        _mqtt.loop_stop()
        _mqtt.disconnect()
    for tw in list(TWINS.values()):
        try:
            save_state(tw)
        except Exception:
            pass
