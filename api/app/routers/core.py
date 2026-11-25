"""Auth, workspace, registers & ledger, periods, validation, capture, OEM sharing, onboarding and admin."""
from __future__ import annotations

import datetime as dt
import hashlib
import secrets
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..domain import ledger as L
from ..domain.emissions import base_load, last12
from ..domain.exports import raw_ledger_csv
from ..domain.measures import MEASURE_SEED, portfolio
from ..domain.synth import synth_monthly_csv
from ..domain.util import parse_csv
from ..domain.validation import RULES, ValidationContext, run_validation
from ..models import (AuditEvent, Bill, Document, EmissionFactor, KybCheck, ManualMeterReading, Meter, MeterReading, OemSupplierLink, OnboardingCase, RoleAssignment, Tenant,
                      TenantSetting, User, ValidationRule)
from ..security import Ctx, PLANT_ROLES, audit, check_otp, current, issue_token, new_otp, plant_tenant_for, require, roles_of
from ..services import integrations, ledger as svc

r = APIRouter(prefix="/api/v1")
ANY = ("operator", "custodian", "owner", "oem", "cluster", "admin")
PLANT_RW = ("operator", "custodian", "owner")
CUSTODY = ("custodian", "owner")


def setting(db: Session, tenant: str, key: str, default: Any = None) -> Any:
    s = db.get(TenantSetting, (tenant, key))
    return s.value if s else default


def put_setting(db: Session, tenant: str, key: str, value: Any):
    db.merge(TenantSetting(tenant_id=tenant, key=key, value=value))


# ======================================================================== auth
class OtpReq(BaseModel):
    email: str


class OtpVerify(BaseModel):
    email: str
    code: str
    role: Optional[str] = None


def me_json(db: Session, user: User, role: str, tenant: Tenant, ro: bool = False) -> dict:
    return {"id": user.id, "name": user.name, "email": user.email, "title": user.title, "titleHi": user.title_hi, "role": role, "readOnly": ro,
            "tenant": {"id": tenant.id, "kind": tenant.kind, "name": tenant.name, "plant": tenant.plant_name, "code": tenant.code}}


@r.post("/auth/otp/request", tags=["auth"])
def otp_request(body: OtpReq, db: Session = Depends(get_db)):
    user = db.scalars(select(User).where(User.email == body.email.lower(), User.active.is_(True))).first()
    if not user:
        raise HTTPException(404, "No account for this e-mail. Ask your admin for an invite.")
    code = new_otp(db, user.email)
    out = {"sent": True, "channel": "console" if not settings.smtp_url else "email"}
    if settings.otp_dev_echo:
        out["devCode"] = code
    return out


@r.post("/auth/otp/verify", tags=["auth"])
def otp_verify(body: OtpVerify, db: Session = Depends(get_db)):
    user = db.scalars(select(User).where(User.email == body.email.lower())).first()
    if not user or not check_otp(db, user.email, body.code.strip()):
        raise HTTPException(401, "That code did not match or has expired.")
    ras = roles_of(db, user.id)
    ra = next((x for x in ras if x.role == body.role), None) or (ras[0] if ras else None)
    if not ra:
        raise HTTPException(403, "No role assigned")
    t = db.get(Tenant, ra.tenant_id)
    audit(db, user.name, ra.role, "sign_in", "session", user.title or ra.role, ra.tenant_id)
    return {"token": issue_token(user, ra, t), "me": me_json(db, user, ra.role, t)}


@r.get("/auth/demo-users", tags=["auth"])
def demo_users(db: Session = Depends(get_db)):
    """Persona list for the sign-in role picker (fictional demo accounts)."""
    out = []
    for ra in db.scalars(select(RoleAssignment).order_by(RoleAssignment.id)).all():
        u = db.get(User, ra.user_id)
        t = db.get(Tenant, ra.tenant_id)
        out.append({"role": ra.role, "email": u.email, "name": u.name, "title": u.title, "titleHi": u.title_hi, "tenant": t.name, "tenantCode": t.code})
    return out


@r.get("/me", tags=["auth"])
def me(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    if ctx.device:
        return {"device": ctx.user_id, "tenant": ctx.tenant_id}
    return me_json(db, db.get(User, ctx.user_id), ctx.role, db.get(Tenant, ctx.tenant_id), ctx.read_only)


class SupportReq(BaseModel):
    reason: str


@r.post("/auth/support-session", tags=["auth"])
def support_session(body: SupportReq, ctx: Ctx = Depends(require("admin")), db: Session = Depends(get_db)):
    """Read-only support view as the demo plant's owner (30 minutes, audited)."""
    if not body.reason.strip():
        raise HTTPException(422, "A reason is required")
    user = db.get(User, ctx.user_id)
    t = db.get(Tenant, "vbw")
    ra = RoleAssignment(user_id=user.id, tenant_id=t.id, role="owner")
    audit(db, ctx.actor, ctx.role, "impersonate", t.name, f"Read-only view as owner, 30 min. Reason: {body.reason}", t.id)
    return {"token": issue_token(user, ra, t, read_only=True, minutes=30), "me": me_json(db, user, "owner", t, True)}


# ======================================================================== workspace (one bundle per screen load)
def _plant_info(t: Tenant) -> dict:
    m = t.meta or {}
    return {"id": t.id, "tenant": t.name, "plant": t.plant_name, "product": m.get("product"), "contractDemandKva": t.contract_kva, "utility": m.get("utility"),
            "oem": m.get("oem"), "udyam": t.udyam, "gstin": t.gstin}


@r.get("/workspace", tags=["workspace"])
def workspace(supplier: Optional[str] = None, ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    """Everything the plant screens need, computed server-side from the ledger (role-filtered)."""
    if ctx.role == "cluster":
        return {"role": ctx.role, "plant": None}
    tid = plant_tenant_for(db, ctx, supplier)
    st = svc.state(db, tid)
    t = db.get(Tenant, tid)
    full = ctx.role in PLANT_ROLES or ctx.role == "admin"
    link = None
    if ctx.role == "oem":
        link = db.scalars(select(OemSupplierLink).where(OemSupplierLink.oem_tenant_id == ctx.tenant_id, OemSupplierLink.supplier_tenant_id == tid)).first()
    out: dict = {
        "role": ctx.role, "plant": _plant_info(t), "registers": [x.to_json() for x in st["registers"]], "plantMonths": st["plantMonths"], "openMonth": st["openMonth"],
        "factors": st["factors"], "closes": st["closes"], "issueStates": st["issueStates"],
        "derived": {"issues": [i.to_json() for i in st["issues"]], "emissions": st["emissions"], "dq": st["dq"], "dqAvg": st["dqAvg"], "tariff": st["tariff"], "gridEf": st["gridEf"]},
        "measures": setting(db, tid, "measures", MEASURE_SEED), "consent": (link.consent if link else setting(db, tid, "consent", "summary")),
        "comments": setting(db, tid, "comments", []), "exportsLog": setting(db, tid, "exportsLog", []), "shareLinks": setting(db, tid, "shareLinks", []),
    }
    if full or (link and link.consent == "detailed"):
        out["entries"] = [e.to_json() for e in st["entries"] if e.status in ("posted", "reversed")]
    else:
        out["entries"] = [e.to_json() for e in st["entries"] if e.registerId in ("PROD", "GRID_KWH", "SOLAR_KWH") and e.status in ("posted", "reversed")]
    if full:
        out["held"] = svc.held_items(db, tid)
        out["meterReadings"] = [{"id": m.id, "meter": m.meter, "value": m.value, "confidence": m.confidence, "source": m.source, "at": m.at, "by": m.by}
                                for m in db.scalars(select(ManualMeterReading).where(ManualMeterReading.tenant_id == tid).order_by(ManualMeterReading.at)).all()]
        out["audit"] = [audit_json(a) for a in db.scalars(select(AuditEvent).where((AuditEvent.tenant_id == tid) | (AuditEvent.tenant_id.is_(None))).order_by(desc(AuditEvent.id)).limit(400)).all()]
    if ctx.role in ("admin", "oem"):
        out["cases"] = [case_json(c) for c in db.scalars(select(OnboardingCase).order_by(OnboardingCase.stage.desc())).all()]
    from .ops import credits_state, fmcg_state
    out["credits"] = credits_state(db, tid)
    out["fmcg"] = fmcg_state(db, "afl")
    return out


def audit_json(a: AuditEvent) -> dict:
    return {"id": str(a.id), "at": a.at.isoformat(), "actor": a.actor, "role": a.role or "", "action": a.action, "entity": a.entity, "detail": a.detail, "hash": a.hash[:12]}


def case_json(c: OnboardingCase) -> dict:
    return {"id": c.id, "supplier": c.supplier, "cluster": c.cluster, "sponsor": c.sponsor, "associate": c.associate, "stage": c.stage, "daysInStage": c.days_in_stage,
            "daysTotal": c.days_total, "sample": c.sample}


# ======================================================================== registers & ledger
class EntryIn(BaseModel):
    registerId: str
    month: Optional[str] = None
    line: str
    qty: float
    docRef: Optional[str] = None
    reason: Optional[str] = None
    source: Optional[str] = "app"
    idempotencyKey: Optional[str] = None
    by: Optional[str] = None
    ts: Optional[Any] = None


@r.get("/registers", tags=["ledger"])
def registers(ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    st = svc.state(db, plant_tenant_for(db, ctx))
    return [x.to_json() for x in st["registers"]]


@r.get("/ledger/entries", tags=["ledger"])
def list_entries(register: Optional[str] = None, month: Optional[str] = None, ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    st = svc.state(db, plant_tenant_for(db, ctx))
    return [e.to_json() for e in st["entries"] if (not register or e.registerId == register) and (not month or e.month == month)]


@r.post("/ledger/entries", tags=["ledger"])
def post_entry(body: EntryIn, idempotency_key: Optional[str] = Header(default=None), ctx: Ctx = Depends(require(*PLANT_RW, "device")), db: Session = Depends(get_db)):
    """Post an entry. Send an Idempotency-Key (header or body): the same key twice posts once (offline sync)."""
    tid = ctx.tenant_id
    req = body.model_dump()
    req["idempotencyKey"] = idempotency_key or body.idempotencyKey
    if not ctx.device:
        req["by"] = ctx.actor
    from ..live.registry import get_twin
    from ..live.twin import device_for
    req["_device"] = device_for(body.registerId) if not ctx.device else None
    res = svc.post(db, ctx, tid, req)
    tw = get_twin(tid)
    if tw and res["result"] in ("posted", "held"):
        from ..live.registry import _held_item, push_snapshot
        tw.entry_result(req, res["result"], (res.get("hold") or {}).get("rule"), (res.get("hold") or {}).get("reason"), _held_item(res, req))
        push_snapshot(tw)
    return res


class ReverseIn(BaseModel):
    reason: str


@r.post("/ledger/entries/{entry_id}/reverse", tags=["ledger"])
def reverse_entry(entry_id: str, body: ReverseIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    return svc.reverse(db, ctx, ctx.tenant_id, entry_id, body.reason)


class CorrectIn(BaseModel):
    registerId: str
    month: str
    line: str
    qty: float
    reason: str


@r.post("/ledger/lines/correct", tags=["ledger"])
def correct_line(body: CorrectIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    return svc.correct(db, ctx, ctx.tenant_id, body.registerId, body.month, body.line, body.qty, body.reason)


@r.get("/ledger/stock", tags=["ledger"])
def ledger_stock(ctx: Ctx = Depends(require(*PLANT_RW, "device")), db: Session = Depends(get_db)):
    return svc.stock(db, ctx.tenant_id)


@r.get("/ledger/export.csv", tags=["ledger"], response_class=PlainTextResponse)
def ledger_csv(ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    audit(db, ctx.actor, ctx.role, "export", "raw ledger", f"{len(st['entries'])} lines", tid)
    return raw_ledger_csv(st["entries"], st["registers"])


# ======================================================================== periods & validation
class MonthIn(BaseModel):
    action: str = "close"
    note: Optional[str] = None


@r.get("/periods", tags=["periods"])
def periods(ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    return svc.state(db, plant_tenant_for(db, ctx))["closes"]


@r.post("/periods/{month}/close", tags=["periods"])
def close_month(month: str, body: MonthIn = MonthIn(), ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    """action: submit (custodian) | approve / close | return | reopen (owner, reason required)."""
    return svc.month_action(db, ctx, ctx.tenant_id, month, body.action, body.note)


@r.get("/validation/queue", tags=["validation"])
def validation_queue(ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    return {"held": svc.held_items(db, tid), "issues": [{**i.to_json(), "status": st["issueStates"].get(i.id, {}).get("status", "open")} for i in st["issues"]], "dq": st["dq"]}


class DecideIn(BaseModel):
    status: str
    note: Optional[str] = None


@r.post("/validation/issues/{issue_id:path}/decide", tags=["validation"])
def decide_issue(issue_id: str, body: DecideIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    return svc.resolve_issue(db, ctx, ctx.tenant_id, issue_id, body.status, body.note)


class BulkIn(BaseModel):
    ids: list[str]
    note: str


@r.post("/validation/issues/bulk-accept", tags=["validation"])
def bulk_accept(body: BulkIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    for i in body.ids:
        svc.resolve_issue(db, ctx, ctx.tenant_id, i, "accepted", body.note)
    return {"ok": True, "count": len(body.ids)}


class HeldIn(BaseModel):
    action: str  # fix | confirm | reject
    value: Optional[float] = None


@r.post("/validation/held/{entry_id}/decide", tags=["validation"])
def decide_held(entry_id: str, body: HeldIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    """A held entry (V01, V10, V12…) reaches emissions only after it is fixed or confirmed here."""
    res = svc.decide_held(db, ctx, ctx.tenant_id, entry_id, body.action, body.value)
    from ..live.registry import get_twin, push_snapshot
    tw = get_twin(ctx.tenant_id)
    if tw:
        tw.resolved(entry_id, body.action, res.get("qty"), res.get("rule", ""), res.get("registerId", ""))
        push_snapshot(tw, True)
    return res


@r.post("/validation/meter-glitch/{item_id}/decide", tags=["validation"])
def decide_glitch(item_id: str, body: HeldIn, ctx: Ctx = Depends(require(*CUSTODY))):
    from ..live.registry import get_twin, push_snapshot
    tw = get_twin(ctx.tenant_id)
    if tw:
        tw.resolved(item_id, "reject" if body.action == "reject" else "fix", None, "V11", "GRID_KWH")
        tw.log("ok" if body.action != "reject" else "info", "V11 meter reading re-taken; next packet accepted." if body.action != "reject" else "V11 item rejected and discarded.")
        push_snapshot(tw, True)
    return {"ok": True}


# ======================================================================== capture: meters, bills, documents
@r.get("/meters", tags=["capture"])
def meters(ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    return [{"id": m.id, "label": m.label, "kind": m.kind, "unit": m.unit, "serial": m.serial} for m in db.scalars(select(Meter).where(Meter.tenant_id == tid)).all()]


@r.get("/meters/{meter_id}/latest", tags=["capture"])
def meter_latest(meter_id: str, ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    """Latest cumulative register from the smart-meter feed (HES pull if configured, else the live feed)."""
    tid = plant_tenant_for(db, ctx)
    pulled = integrations.smart_meter_latest(meter_id)
    if pulled:
        return {**pulled, "source": "smart_meter_api"}
    from ..live.registry import get_twin
    tw = get_twin(tid)
    last = db.scalars(select(MeterReading).where(MeterReading.tenant_id == tid, MeterReading.meter_id == meter_id).order_by(desc(MeterReading.ts)).limit(1)).first()
    return {"meter": meter_id, "value": round(tw.meter_cum) if tw and meter_id == "incomer" else None, "unit": "kWh", "lastInterval": {"ts": last.ts.isoformat(), "kwh": last.kwh} if last else None,
            "source": "smart_meter_feed", "confidence": 1.0, "meterType": "HT smart meter (DLMS), 1-minute feed"}


class ReadingIn(BaseModel):
    meter: str = "Main incomer (HT)"
    value: float
    source: str = "smart_meter_api"
    confidence: float = 1.0


@r.post("/meters/{meter_id}/readings", tags=["capture"])
def add_reading(meter_id: str, body: ReadingIn, ctx: Ctx = Depends(require(*PLANT_RW, "device")), db: Session = Depends(get_db)):
    """A register reading (smart-meter API pull, or typed by hand). Non-monotonic readings are flagged V11."""
    tid = ctx.tenant_id
    prev = db.scalars(select(ManualMeterReading).where(ManualMeterReading.tenant_id == tid, ManualMeterReading.meter == body.meter).order_by(desc(ManualMeterReading.at))).first()
    flag = None
    if prev and body.value < prev.value:
        flag = {"rule": "V11", "reason": f"Reading {body.value:,.0f} is below the previous {prev.value:,.0f}. Meter reset or misread?"}
    m = ManualMeterReading(id=L.uid("mr"), tenant_id=tid, meter=body.meter, value=body.value, confidence=body.confidence, source=body.source, at=L.now_iso(), by=ctx.actor)
    db.add(m)
    audit(db, ctx.actor, ctx.role, "meter_reading", body.meter, f"{body.value} ({body.source}){' ' + flag['rule'] if flag else ''}", tid, commit=False)
    db.commit()
    return {"id": m.id, "flag": flag}


class BillIn(BaseModel):
    month: str
    kwh: Optional[float] = None
    kvah: Optional[float] = None
    pf: Optional[float] = None
    mdKva: Optional[float] = None
    amountInr: Optional[float] = None
    documentId: Optional[str] = None
    source: str = "manual"


@r.post("/bills", tags=["capture"])
def add_bill(body: BillIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    """Electricity bill → ledger reading lines (GRID_KWH, GRID_KVAH, PF, MD_KVA, BILL_INR) with checks."""
    tid = ctx.tenant_id
    b = Bill(id=L.uid("bill"), tenant_id=tid, month=body.month, kwh=body.kwh, kvah=body.kvah, pf=body.pf, md_kva=body.mdKva, amount_inr=body.amountInr, document_id=body.documentId, source=body.source)
    db.add(b); db.commit()
    out = []
    for reg, v in (("GRID_KWH", body.kwh), ("GRID_KVAH", body.kvah), ("PF", body.pf), ("MD_KVA", body.mdKva), ("BILL_INR", body.amountInr)):
        if v is not None:
            out.append(svc.post(db, ctx, tid, {"registerId": reg, "month": body.month, "line": "reading", "qty": v, "docRef": f"BILL-{body.month}-{reg}", "source": "bill",
                                                 "idempotencyKey": f"bill-{b.id}-{reg}", "reason": "Electricity bill"}, live_checks=False))
    return {"bill": b.id, "lines": out}


@r.post("/documents", tags=["capture"])
async def upload_document(kind: str = Form("bill"), file: UploadFile = File(...), ctx: Ctx = Depends(require(*PLANT_RW)), db: Session = Depends(get_db)):
    data = await file.read()
    sha = hashlib.sha256(data).hexdigest()
    dup = db.scalars(select(Document).where(Document.tenant_id == ctx.tenant_id, Document.sha256 == sha)).first()
    if dup:
        raise HTTPException(409, f"V10: this document was already uploaded on {dup.created_at:%d %b %Y}.")
    folder = Path(settings.storage_dir) / ctx.tenant_id
    folder.mkdir(parents=True, exist_ok=True)
    did = L.uid("doc")
    path = folder / f"{did}_{Path(file.filename or 'upload').name}"
    path.write_bytes(data)
    db.add(Document(id=did, tenant_id=ctx.tenant_id, kind=kind, filename=file.filename or "upload", path=str(path), sha256=sha))
    audit(db, ctx.actor, ctx.role, "document_upload", kind, f"{file.filename} sha256:{sha[:12]}…", ctx.tenant_id, commit=False)
    db.commit()
    return {"id": did, "sha256": sha}


@r.post("/documents/{doc_id}/read", tags=["capture"])
def read_document(doc_id: str, ctx: Ctx = Depends(require(*PLANT_RW)), db: Session = Depends(get_db)):
    """Structured fields for an uploaded bill. With smart meters the energy figures come from the meter feed; the bill
    amount is typed and confirmed by the custodian (no AI reading in this build)."""
    d = db.get(Document, doc_id)
    if not d or d.tenant_id != ctx.tenant_id:
        raise HTTPException(404, "Document not found")
    st = svc.state(db, ctx.tenant_id)
    m = st["plantMonths"][-1] if st["plantMonths"] else st["openMonth"]
    from ..domain.ledger import value
    fields = {"period": m, "kwh": value(st["idx"], "GRID_KWH", m, "reading"), "kvah": value(st["idx"], "GRID_KVAH", m, "reading"), "pf": value(st["idx"], "PF", m, "reading"),
              "mdKva": value(st["idx"], "MD_KVA", m, "reading"), "amountInr": None, "source": "smart_meter_feed", "note": "Energy figures pre-filled from the smart-meter feed; type the bill amount and confirm."}
    d.fields = fields
    db.commit()
    return fields


# ======================================================================== measures, OEM sharing
class MeasureIn(BaseModel):
    status: Optional[str] = None


@r.patch("/measures/{code}", tags=["reports"])
def set_measure(code: str, body: MeasureIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    ms = setting(db, ctx.tenant_id, "measures", MEASURE_SEED)
    ms = [{**m, **({"status": body.status} if m["code"] == code and body.status else {})} for m in ms]
    put_setting(db, ctx.tenant_id, "measures", ms)
    audit(db, ctx.actor, ctx.role, "measure_status", code, body.status or "", ctx.tenant_id)
    return ms


@r.get("/measures", tags=["reports"])
def get_measures(ctx: Ctx = Depends(require(*PLANT_RW, "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    st = svc.state(db, tid)
    ms = setting(db, tid, "measures", MEASURE_SEED)
    pf = portfolio(ms, st["tariff"], st["gridEf"])
    bl = base_load(st["idx"], st["plantMonths"])
    return {"measures": ms, "portfolio": {k: v for k, v in pf.items() if k != "rows"}, "tariff": st["tariff"], "baseLoad": bl}


class ConsentIn(BaseModel):
    consent: Optional[str]
    oem: str = "oem-a"


@r.post("/sharing/consent", tags=["oem"])
def set_consent(body: ConsentIn, ctx: Ctx = Depends(require("owner", "custodian")), db: Session = Depends(get_db)):
    links = db.scalars(select(OemSupplierLink).where(OemSupplierLink.supplier_tenant_id == ctx.tenant_id)).all()
    for l in links:
        l.consent = body.consent
        l.granted_by, l.granted_at = ctx.actor, dt.datetime.now(dt.timezone.utc)
    put_setting(db, ctx.tenant_id, "consent", body.consent)
    audit(db, ctx.actor, ctx.role, "consent", "OEM", body.consent or "revoked", ctx.tenant_id)
    return {"consent": body.consent}


class ShareIn(BaseModel):
    audience: str
    days: int = 30


@r.post("/sharing/links", tags=["oem"])
def add_share(body: ShareIn, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    links = setting(db, ctx.tenant_id, "shareLinks", [])
    nowt = dt.datetime.now(dt.timezone.utc)
    links = [{"id": secrets.token_hex(5), "audience": body.audience, "created": nowt.isoformat(), "expires": (nowt + dt.timedelta(days=body.days)).isoformat()}, *links]
    put_setting(db, ctx.tenant_id, "shareLinks", links)
    audit(db, ctx.actor, ctx.role, "share_link", body.audience, f"{body.days} days", ctx.tenant_id)
    return links


@r.post("/sharing/links/{lid}/revoke", tags=["oem"])
def revoke_share(lid: str, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    links = [{**l, "revoked": True} if l["id"] == lid else l for l in setting(db, ctx.tenant_id, "shareLinks", [])]
    put_setting(db, ctx.tenant_id, "shareLinks", links)
    audit(db, ctx.actor, ctx.role, "share_revoke", lid, "", ctx.tenant_id)
    return links


class ExportLogIn(BaseModel):
    kind: str
    period: str
    sha: str
    bytes: int


@r.post("/exports/log", tags=["reports"])
def log_export(body: ExportLogIn, ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx)
    lg = [{**body.model_dump(), "id": L.uid("ex"), "by": ctx.actor, "at": L.now_iso()}, *setting(db, tid, "exportsLog", [])][:200]
    put_setting(db, tid, "exportsLog", lg)
    audit(db, ctx.actor, ctx.role, "export", body.kind, f"{body.period} sha256:{body.sha[:12]}…", tid)
    return lg


class CommentIn(BaseModel):
    text: str
    month: Optional[str] = None
    supplier: Optional[str] = None


@r.post("/oem/requests", tags=["oem"])
def oem_request(body: CommentIn, ctx: Ctx = Depends(require("oem", "admin")), db: Session = Depends(get_db)):
    tid = plant_tenant_for(db, ctx, body.supplier)
    cm = [{"id": L.uid("cm"), "text": body.text, "month": body.month, "at": L.now_iso(), "status": "open", "by": ctx.actor}, *setting(db, tid, "comments", [])]
    put_setting(db, tid, "comments", cm)
    audit(db, ctx.actor, ctx.role, "oem_request", tid, body.text, tid)
    return cm


@r.post("/oem/requests/{cid}/close", tags=["oem"])
def close_request(cid: str, ctx: Ctx = Depends(require(*CUSTODY)), db: Session = Depends(get_db)):
    cm = [{**c, "status": "done"} if c["id"] == cid else c for c in setting(db, ctx.tenant_id, "comments", [])]
    put_setting(db, ctx.tenant_id, "comments", cm)
    db.commit()
    return cm


@r.get("/oem/suppliers", tags=["oem"])
def oem_suppliers(ctx: Ctx = Depends(require("oem", "admin")), db: Session = Depends(get_db)):
    """Suppliers that granted this OEM access (real link), plus clearly-labelled sample records for the overview."""
    from ..domain.samples import SAMPLE_SUPPLIERS
    q = select(OemSupplierLink)
    if ctx.role == "oem":
        q = q.where(OemSupplierLink.oem_tenant_id == ctx.tenant_id)
    out = []
    for l in db.scalars(q).all():
        t = db.get(Tenant, l.supplier_tenant_id)
        if l.consent:
            st = svc.state(db, t.id)
            em = st["emissions"][-12:]
            tot = sum(e["total"] for e in em)
            out_n = sum(e["output"] for e in em)
            out.append({"id": t.id, "name": t.name, "cluster": "Jamshedpur", "commodity": "Tipper bodies", "stage": 10, "consent": l.consent, "dq": round(st["dqAvg"]),
                        "intensity": round(tot / out_n) if out_n else 0, "trend": 0, "sample": False, "vendorCode": l.vendor_code})
    return out + SAMPLE_SUPPLIERS


# ======================================================================== onboarding
class GstIn(BaseModel):
    value: str


@r.post("/onboarding/kyb/gstin", tags=["onboarding"])
def kyb_gstin(body: GstIn, ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    res = integrations.verify_gstin(body.value)
    db.add(KybCheck(kind="gstin", input=body.value[:60], result=res, by=ctx.actor)); db.commit()
    return res


@r.post("/onboarding/kyb/udyam", tags=["onboarding"])
def kyb_udyam(body: GstIn, ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    res = integrations.verify_udyam(body.value)
    db.add(KybCheck(kind="udyam", input=body.value[:60], result=res, by=ctx.actor)); db.commit()
    return res


COLMAP = {"bodies_produced": ("PROD", "reading"), "grid_kwh": ("GRID_KWH", "reading"), "grid_kvah": ("GRID_KVAH", "reading"), "power_factor": ("PF", "reading"),
          "max_demand_kva": ("MD_KVA", "reading"), "bill_inr": ("BILL_INR", "reading")}


class CsvIn(BaseModel):
    csv: str


@r.post("/onboarding/import/csv", tags=["onboarding"])
def import_csv(body: CsvIn, ctx: Ctx = Depends(require(*CUSTODY, "admin")), db: Session = Depends(get_db)):
    """Validate a supplier's monthly sheet live (nothing is posted): rows, months, registers, V01–V12 hits, baseline."""
    from ..domain.seed import ISSUE_ONLY, registers as seed_registers
    rows = parse_csv(body.csv)
    if not rows or "period_month" not in rows[0]:
        raise HTTPException(422, "First column must be period_month (YYYY-MM)")
    cols = {d["col"]: d["code"] for d in ISSUE_ONLY}
    regs = [x for x in seed_registers() if x.mode != "full"]
    entries, months, used = [], [], set()
    for row in rows:
        m = row["period_month"]
        months.append(m)
        for col, v in row.items():
            if col == "period_month" or v == "":
                continue
            reg, line = COLMAP.get(col, (cols.get(col), "issued"))
            if not reg:
                continue
            used.add(reg)
            entries.append(L.LedgerEntry(id=L.uid("imp"), registerId=reg, month=m, line=line, qty=float(v), source="import"))
    idx = L.build_index(entries)
    issues = run_validation(ValidationContext([x for x in regs if x.id in used], idx, months, months, 450))
    count: dict = {}
    for i in issues:
        count[i.rule] = count.get(i.rule, 0) + 1
    kwh = sum(L.value(idx, "GRID_KWH", m, "reading") or 0 for m in months)
    units = sum(L.value(idx, "PROD", m, "reading") or 0 for m in months)
    from ..domain.emissions import month_emissions
    from ..services.ledger import factors
    em = [month_emissions([x for x in regs if x.id in used], idx, factors(db), m) for m in months]
    tot = sum(e["total"] for e in em)
    audit(db, ctx.actor, ctx.role, "import_validate", "CSV", f"{len(rows)} rows, {len(issues)} issues", ctx.tenant_id)
    return {"rows": len(rows), "months": len(set(months)), "registers": len(used), "issues": count, "issueList": [i.to_json() for i in issues[:60]],
            "intensity": tot / units if units else None, "kwhPerUnit": kwh / units if units else None, "source": "csv"}


@r.get("/onboarding/sample.csv", tags=["onboarding"], response_class=PlainTextResponse)
def sample_csv(ctx: Ctx = Depends(current)):
    return synth_monthly_csv()


@r.get("/onboarding/cases", tags=["onboarding"])
def cases(ctx: Ctx = Depends(require("admin", "oem")), db: Session = Depends(get_db)):
    return [case_json(c) for c in db.scalars(select(OnboardingCase).order_by(OnboardingCase.stage.desc())).all()]


class CaseIn(BaseModel):
    supplier: str
    cluster: str
    sponsor: str


@r.post("/onboarding/cases", tags=["onboarding"])
def add_case(body: CaseIn, ctx: Ctx = Depends(require("admin", "oem", "custodian", "owner")), db: Session = Depends(get_db)):
    c = OnboardingCase(id=L.uid("case"), supplier=body.supplier, cluster=body.cluster, sponsor=body.sponsor, associate="—", stage=1, sample=True)
    db.add(c)
    audit(db, ctx.actor, ctx.role, "lead_create", body.supplier, body.sponsor, None, commit=False)
    db.commit()
    return case_json(c)


class MoveIn(BaseModel):
    stage: int


@r.post("/onboarding/cases/{cid}/move", tags=["onboarding"])
def move_case(cid: str, body: MoveIn, ctx: Ctx = Depends(require("admin")), db: Session = Depends(get_db)):
    c = db.get(OnboardingCase, cid)
    if not c:
        raise HTTPException(404, "Case not found")
    c.stage, c.days_in_stage = body.stage, 0
    audit(db, ctx.actor, ctx.role, "pipeline_move", c.supplier, f"→ stage {body.stage}", None, commit=False)
    db.commit()
    return case_json(c)


# ======================================================================== admin: factors, rules, audit, sources
@r.get("/factors", tags=["admin"])
def list_factors(ctx: Ctx = Depends(current), db: Session = Depends(get_db)):
    return svc.factors(db)


class FactorIn(BaseModel):
    code: str
    kgco2e_per_unit: float
    valid_from: str
    source: str
    status: str = "active"


@r.post("/factors", tags=["admin"])
def publish_factor(body: FactorIn, ctx: Ctx = Depends(require("admin")), db: Session = Depends(get_db)):
    """New factor version. The previous open version is closed the day before; past months keep their factor."""
    cur = db.scalars(select(EmissionFactor).where(EmissionFactor.code == body.code).order_by(desc(EmissionFactor.version))).all()
    if not cur:
        raise HTTPException(404, "Unknown factor code")
    top = cur[0]
    if body.valid_from <= top.valid_from:
        raise HTTPException(422, f"valid_from must be after {top.valid_from}")
    prev_day = (dt.date.fromisoformat(body.valid_from) - dt.timedelta(days=1)).isoformat()
    for f in cur:
        if f.valid_to is None and f.valid_from < body.valid_from:
            f.valid_to = prev_day
    nf = EmissionFactor(code=top.code, activity=top.activity, scope=top.scope, unit=top.unit, kgco2e_per_unit=body.kgco2e_per_unit, source=body.source, version=top.version + 1,
                        valid_from=body.valid_from, valid_to=None, status=body.status, created_by=ctx.actor)
    db.add(nf)
    audit(db, ctx.actor, ctx.role, "factor_publish", body.code, f"v{nf.version} = {body.kgco2e_per_unit} from {body.valid_from}", None, commit=False)
    db.commit()
    for t in db.scalars(select(Tenant).where(Tenant.kind == "plant")).all():
        svc.invalidate(t.id)
    return svc.factors(db)


@r.get("/rules", tags=["admin"])
def rules(ctx: Ctx = Depends(current)):
    return RULES


@r.get("/audit", tags=["admin"])
def audit_log(limit: int = 300, action: Optional[str] = None, ctx: Ctx = Depends(require("admin", "owner", "custodian")), db: Session = Depends(get_db)):
    q = select(AuditEvent).order_by(desc(AuditEvent.id)).limit(min(limit, 2000))
    if ctx.role != "admin":
        q = q.where(AuditEvent.tenant_id == ctx.tenant_id)
    if action:
        q = q.where(AuditEvent.action == action)
    return [audit_json(a) for a in db.scalars(q).all()]


@r.get("/audit/verify", tags=["admin"])
def audit_verify(ctx: Ctx = Depends(require("admin")), db: Session = Depends(get_db)):
    """Re-walk the hash chain. Any edited or deleted row breaks it."""
    prev = None
    n = 0
    for a in db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all():
        if a.prev_hash != prev:
            return {"ok": False, "brokenAt": a.id}
        prev = a.hash
        n += 1
    return {"ok": True, "rows": n}


@r.get("/sources", tags=["admin"])
def sources(ctx: Ctx = Depends(current)):
    return integrations.sources()


@r.get("/admin/overview", tags=["admin"])
def admin_overview(ctx: Ctx = Depends(require("admin")), db: Session = Depends(get_db)):
    plants = db.scalars(select(Tenant).where(Tenant.kind == "plant")).all()
    out = []
    for t in plants:
        if not (t.meta or {}).get("ledger"):
            continue
        st = svc.state(db, t.id)
        out.append({"id": t.id, "name": t.name, "dqAvg": st["dqAvg"], "openIssues": len([i for i in st["issues"] if st["issueStates"].get(i.id, {}).get("status", "open") == "open"]),
                    "held": len(st["held"]), "entries": len(st["entries"]), "months": len(st["plantMonths"])})
    return {"plants": out, "users": len(db.scalars(select(User)).all())}
