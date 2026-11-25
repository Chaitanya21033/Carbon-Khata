"""Ledger service: posting with idempotency + live checks, corrections by reversal, issue decisions, month close,
and the derived figures (issues, emissions, data-quality) every screen reads. All reads go through a per-tenant
cache that is invalidated on every write."""
from __future__ import annotations

import datetime as dt
import threading
from dataclasses import asdict
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import events
from ..domain import ledger as L
from ..domain.emissions import effective_tariff, factor_for, month_emissions
from ..domain.ledger import DIRECTION, build_index, running_stock, value
from ..domain.live_checks import check as live_check
from ..domain.validation import ValidationContext, close_blockers, dq_score, run_validation
from ..models import EmissionFactor, LedgerEntry, Period, Register, Tenant, ValidationResult
from ..security import Ctx, audit

_cache: dict[str, dict] = {}
_lock = threading.RLock()
BLOCKING_LIVE = {"V01", "V02", "V10", "V11", "V12"}


def plant_clock_ms() -> int:
    from ..live.registry import plant_now_ms
    return plant_now_ms()


def open_month() -> str:
    from ..live.twin import month_of
    return month_of(plant_clock_ms())


def invalidate(tenant_id: str):
    with _lock:
        _cache.pop(tenant_id, None)


def to_domain_entry(e: LedgerEntry) -> L.LedgerEntry:
    return L.LedgerEntry(id=e.id, registerId=e.register_id, month=e.month, line=e.line, qty=e.qty, status=e.status, by=e.posted_by, at=e.posted_at, source=e.source,
                         reversesId=e.reverses_entry_id, correctsId=e.corrects_entry_id, reason=e.reason, docRef=e.doc_ref, idempotencyKey=e.idempotency_key)


def to_domain_register(r: Register) -> L.Register:
    return L.Register(id=r.id, code=r.code, label=r.label, unit=r.unit, category=r.category, mode=r.mode, labelHi=r.label_hi, required=r.required,
                      conversion=r.conversion, factorCode=r.factor_code, typical=r.typical)


def factors(db: Session) -> list[dict]:
    rows = db.scalars(select(EmissionFactor).order_by(EmissionFactor.code, EmissionFactor.version)).all()
    return [{"code": f.code, "activity": f.activity, "scope": f.scope, "unit": f.unit, "kgco2e_per_unit": f.kgco2e_per_unit, "source": f.source, "version": f.version,
             "valid_from": f.valid_from, "valid_to": f.valid_to, "status": f.status} for f in rows]


def state(db: Session, tenant_id: str) -> dict:
    """Cached ledger state + derived figures for one plant tenant."""
    om = open_month()
    with _lock:
        c = _cache.get(tenant_id)
        if c and c["openMonth"] == om:
            return c
    regs = [to_domain_register(r) for r in db.scalars(select(Register).where(Register.tenant_id == tenant_id).order_by(Register.sort)).all()]
    rows = db.scalars(select(LedgerEntry).where(LedgerEntry.tenant_id == tenant_id).order_by(LedgerEntry.seq)).all()
    entries = [to_domain_entry(e) for e in rows]
    held = [e for e in rows if e.status == "held"]
    t = db.get(Tenant, tenant_id)
    fs = factors(db)
    months = sorted({e.month for e in entries if e.month < om and e.status in ("posted", "reversed")})
    idx = build_index(entries)
    issues = run_validation(ValidationContext(regs, idx, months, months, (t.contract_kva or 450) if t else 450)) if months else []
    states = {v.issue_id: {"status": v.status, "note": v.note, "by": v.decided_by, "at": v.decided_at}
              for v in db.scalars(select(ValidationResult).where(ValidationResult.tenant_id == tenant_id)).all()}
    closes = {p.month: {"month": p.month, "status": p.status, "reopenedCount": p.reopened_count, "submittedBy": p.submitted_by, "approvedBy": p.approved_by, "history": p.history}
              for p in db.scalars(select(Period).where(Period.tenant_id == tenant_id)).all()}
    # Lines carrying an open blocking issue never reach emissions or reports until decided.
    blocked = {(i.registerId, i.month, i.line) for i in issues if i.severity == "block" and states.get(i.id, {}).get("status", "open") == "open"}
    rep_entries = [e for e in entries if (e.registerId, e.month, e.line) not in blocked]
    rep_idx = build_index(rep_entries)
    emissions = [month_emissions(regs, rep_idx, fs, m) for m in months]
    dq = {}
    for m in months:
        missing = any(value(idx, r, m, "reading") is None for r in ("PROD", "GRID_KWH", "BILL_INR"))
        cl = closes.get(m)
        dq[m] = dq_score(m, issues, states, L.MonthClose(**{k: cl[k] for k in ("month", "status", "reopenedCount")}) if cl else None, missing)
    dq_avg = sum(dq.values()) / len(dq) if dq else 0
    grid = factor_for(fs, "EF_GRID_IN", months[-1] if months else om)
    c = {"tenant": tenant_id, "openMonth": om, "registers": regs, "entries": entries, "held": held, "idx": idx, "repIdx": rep_idx, "factors": fs, "plantMonths": months,
         "issues": issues, "issueStates": states, "closes": closes, "emissions": emissions, "dq": dq, "dqAvg": dq_avg,
         "tariff": effective_tariff(idx, months), "gridEf": grid["kgco2e_per_unit"] if grid else 0.71,
         "contractKva": (t.contract_kva or 450) if t else 450}
    with _lock:
        _cache[tenant_id] = c
    return c


def is_locked(st: dict, month: str) -> bool:
    return st["closes"].get(month, {}).get("status") in ("closed", "in_review")


def _row(tenant_id: str, e: L.LedgerEntry, unit: Optional[str], hold: Optional[dict] = None) -> LedgerEntry:
    return LedgerEntry(id=e.id, tenant_id=tenant_id, register_id=e.registerId, month=e.month, line=e.line, direction=DIRECTION[e.line], qty=e.qty, unit=unit, status=e.status,
                       reverses_entry_id=e.reversesId, corrects_entry_id=e.correctsId, reason=e.reason, doc_ref=e.docRef, source=e.source, idempotency_key=e.idempotencyKey,
                       posted_by=e.by, posted_at=e.at, hold=hold)


def post(db: Session, ctx: Ctx, tenant_id: str, req: dict, live_checks: bool = True, audit_it: bool = True) -> dict:
    """Post one entry. Returns {result: posted|held|duplicate, entry, hold?}. Same idempotency key twice → one entry."""
    key = req.get("idempotencyKey")
    if key:
        ex = db.scalars(select(LedgerEntry).where(LedgerEntry.tenant_id == tenant_id, LedgerEntry.idempotency_key == key)).first()
        if ex:
            return {"result": "duplicate", "entry": to_domain_entry(ex).to_json(), "status": ex.status}
    st = state(db, tenant_id)
    reg = next((r for r in st["registers"] if r.id == req["registerId"]), None)
    if reg is None:
        raise HTTPException(404, f"Unknown register {req['registerId']}")
    month = req.get("month") or st["openMonth"]
    line = req["line"]
    if line not in L.LINES:
        raise HTTPException(422, "Unknown line type")
    qty = float(req["qty"])
    if is_locked(st, month):
        raise HTTPException(409, "This month is closed. Ask the owner to reopen it.")
    if not (qty > 0) and line != "opening":
        raise HTTPException(422, "Enter a quantity above zero.")
    by = req.get("by") or ctx.actor
    at = req.get("at") or L.now_iso()
    created: list[LedgerEntry] = []
    # carry-forward: first entry of a new month in a full register gets an opening line = last closing
    if reg.mode == "full" and line != "opening" and value(st["idx"], reg.id, month, "opening") is None:
        prev = max([m for m in st["plantMonths"] if m < month], default=None)
        c = (value(st["idx"], reg.id, prev, "closing") or 0) if prev else 0
        created.append(_row(tenant_id, L.LedgerEntry(id=L.uid("ent"), registerId=reg.id, month=month, line="opening", qty=c, by="System (carry-forward)", at=at, source="app",
                                                     reason="Carry-forward from previous closing"), reg.unit))
    flag = None
    if live_checks and req.get("source", "app") != "import":
        seen = req.get("docRef") and db.scalars(select(LedgerEntry.id).where(LedgerEntry.tenant_id == tenant_id, LedgerEntry.doc_ref == req["docRef"], LedgerEntry.status == "posted",
                                                                            LedgerEntry.reverses_entry_id.is_(None))).first()
        stock = running_stock(st["idx"], reg.id, month) + (created[0].qty if created else 0)
        flag = live_check({**req, "qty": qty, "line": line}, {"mode": reg.mode, "typical": reg.typical}, stock, bool(seen))
    e = L.LedgerEntry(id=L.uid("ent"), registerId=reg.id, month=month, line=line, qty=qty, status="held" if flag else "posted", by=by, at=at, source=req.get("source", "app"),
                      reason=req.get("reason"), docRef=req.get("docRef"), idempotencyKey=key)
    hold = {**flag, "device": req.get("_device"), "kind": req.get("_kind")} if flag else None
    created.append(_row(tenant_id, e, reg.unit, hold))
    try:
        for r in created:
            db.add(r)
        if audit_it and not ctx.device:
            audit(db, ctx.actor, ctx.role, "create" if not flag else "hold", reg.label, f"{line} {qty} for {month}{f' ({e.docRef})' if e.docRef else ''}{(' HELD ' + flag['rule']) if flag else ''}", tenant_id, commit=False)
        db.commit()
    except IntegrityError:
        db.rollback()
        ex = db.scalars(select(LedgerEntry).where(LedgerEntry.tenant_id == tenant_id, LedgerEntry.idempotency_key == key)).first()
        if ex:
            return {"result": "duplicate", "entry": to_domain_entry(ex).to_json(), "status": ex.status}
        raise
    invalidate(tenant_id)
    events.publish(tenant_id, "ledger", {"registerId": reg.id, "line": line, "qty": qty, "status": e.status, "id": e.id})
    out = {"result": "held" if flag else "posted", "entry": e.to_json()}
    if flag:
        out["hold"] = flag
    return out


def held_items(db: Session, tenant_id: str) -> list[dict]:
    rows = db.scalars(select(LedgerEntry).where(LedgerEntry.tenant_id == tenant_id, LedgerEntry.status == "held").order_by(LedgerEntry.seq.desc())).all()
    return [{"id": r.id, "t": r.posted_at, "device": (r.hold or {}).get("device") or "stores", "registerId": r.register_id, "line": r.line, "qty": r.qty, "suggested": (r.hold or {}).get("suggested"),
             "rule": (r.hold or {}).get("rule"), "reason": (r.hold or {}).get("reason"), "docRef": r.doc_ref, "month": r.month, "by": r.posted_by} for r in rows]


def decide_held(db: Session, ctx: Ctx, tenant_id: str, entry_id: str, action: str, new_value: Optional[float] = None) -> dict:
    r = db.get(LedgerEntry, entry_id)
    if not r or r.tenant_id != tenant_id or r.status != "held":
        raise HTTPException(404, "No held entry with that id")
    rule = (r.hold or {}).get("rule", "")
    if action == "reject":
        r.status = "rejected"
        audit(db, ctx.actor, ctx.role, "hold_reject", r.register_id, f"{rule} {r.doc_ref} discarded", tenant_id, commit=False)
        db.commit(); invalidate(tenant_id)
        events.publish(tenant_id, "ledger", {"id": r.id, "status": "rejected"})
        return {"result": "rejected", "rule": rule}
    if action == "fix":
        qty = new_value if new_value is not None else (r.hold or {}).get("suggested") or r.qty
        r.status = "rejected"
        new = LedgerEntry(id=L.uid("ent"), tenant_id=tenant_id, register_id=r.register_id, month=r.month, line=r.line, direction=r.direction, qty=float(qty), unit=r.unit,
                          status="posted", corrects_entry_id=r.id, reason=f"Corrected from {r.qty:g} to {float(qty):g} ({rule})", doc_ref=r.doc_ref, source=r.source,
                          idempotency_key=f"{r.idempotency_key}-fix" if r.idempotency_key else None, posted_by=ctx.actor, posted_at=L.now_iso())
        db.add(new)
    else:  # confirm as real
        qty = r.qty
        r.status = "posted"
        r.reason = f"{r.reason or ''} · Confirmed as real ({rule}) by {ctx.actor}".strip(" ·")
        if rule == "V10" and r.doc_ref:
            r.doc_ref = f"{r.doc_ref}-R"
    audit(db, ctx.actor, ctx.role, f"hold_{action}", r.register_id, f"{rule} {r.doc_ref}: {'posted ' + str(qty) if action == 'fix' else 'confirmed as real'}", tenant_id, commit=False)
    db.commit()
    invalidate(tenant_id)
    events.publish(tenant_id, "ledger", {"id": r.id, "status": "posted"})
    return {"result": "posted", "rule": rule, "qty": qty, "registerId": r.register_id}


def correct(db: Session, ctx: Ctx, tenant_id: str, register_id: str, month: str, line: str, new_qty: float, reason: str) -> dict:
    st = state(db, tenant_id)
    if is_locked(st, month):
        raise HTTPException(409, "Month is locked. Reopen it first (owner, with reason).")
    if not reason or not reason.strip():
        raise HTTPException(422, "A reason is required.")
    before = value(st["idx"], register_id, month, line)
    _, created = L.correct_line([e for e in st["entries"] if e.status in ("posted",)], register_id, month, line, new_qty, reason, ctx.actor)
    reg = next(r for r in st["registers"] if r.id == register_id)
    for c in created:
        db.add(_row(tenant_id, c, reg.unit))
        if c.reversesId:
            db.execute(update(LedgerEntry).where(LedgerEntry.id == c.reversesId).values(status="reversed"))
    audit(db, ctx.actor, ctx.role, "correct", reg.label, f"{month} {line}: {before} → {new_qty}. Reason: {reason}", tenant_id, commit=False)
    db.commit()
    invalidate(tenant_id)
    events.publish(tenant_id, "ledger", {"registerId": register_id, "corrected": True})
    return {"created": [c.to_json() for c in created]}


def reverse(db: Session, ctx: Ctx, tenant_id: str, entry_id: str, reason: str) -> dict:
    if not reason or not reason.strip():
        raise HTTPException(422, "A reason is required.")
    r = db.get(LedgerEntry, entry_id)
    if not r or r.tenant_id != tenant_id or r.status != "posted" or r.reverses_entry_id:
        raise HTTPException(404, "No posted entry with that id")
    st = state(db, tenant_id)
    if is_locked(st, r.month):
        raise HTTPException(409, "Month is locked. Reopen it first (owner, with reason).")
    rev = LedgerEntry(id=L.uid("rev"), tenant_id=tenant_id, register_id=r.register_id, month=r.month, line=r.line, direction=r.direction, qty=-r.qty, unit=r.unit, status="posted",
                      reverses_entry_id=r.id, reason=reason, source="app", posted_by=ctx.actor, posted_at=L.now_iso())
    r.status = "reversed"
    db.add(rev)
    audit(db, ctx.actor, ctx.role, "reverse", r.register_id, f"{r.month} {r.line} {r.qty:g} reversed. Reason: {reason}", tenant_id, commit=False)
    db.commit()
    invalidate(tenant_id)
    events.publish(tenant_id, "ledger", {"reversed": entry_id})
    return {"reversal": to_domain_entry(rev).to_json()}


def resolve_issue(db: Session, ctx: Ctx, tenant_id: str, issue_id: str, status: str, note: Optional[str]) -> dict:
    if status not in ("open", "accepted", "dismissed"):
        raise HTTPException(422, "Unknown status")
    if status not in ("open", "dismissed") and not (note or "").strip():
        raise HTTPException(422, "Add a note explaining why this value is real.")
    v = db.get(ValidationResult, (tenant_id, issue_id))
    at = L.now_iso()
    if v is None:
        db.add(ValidationResult(tenant_id=tenant_id, issue_id=issue_id, rule=issue_id.split("|")[0][:8], status=status, note=note, decided_by=ctx.actor, decided_at=at))
    else:
        v.status, v.note, v.decided_by, v.decided_at = status, note, ctx.actor, at
    audit(db, ctx.actor, ctx.role, f"issue_{status}", issue_id.split("|")[0], f"{issue_id}{f' — {note}' if note else ''}", tenant_id, commit=False)
    db.commit()
    invalidate(tenant_id)
    events.publish(tenant_id, "ledger", {"issue": issue_id})
    return {"ok": True}


def month_action(db: Session, ctx: Ctx, tenant_id: str, month: str, action: str, note: Optional[str]) -> dict:
    st = state(db, tenant_id)
    p = db.get(Period, (tenant_id, month)) or Period(tenant_id=tenant_id, month=month, status="open", reopened_count=0, history=[])
    if action == "submit":
        blockers = close_blockers(month, st["issues"], st["issueStates"])
        if blockers:
            raise HTTPException(409, f"{len(blockers)} issue(s) must be fixed or confirmed first.")
        if ctx.role not in ("custodian", "owner"):
            raise HTTPException(403, "Only the ESG custodian submits a month.")
    if action in ("approve", "return", "reopen") and ctx.role != "owner":
        raise HTTPException(403, "Only the owner can approve, return or reopen.")
    if action == "reopen" and not (note or "").strip():
        raise HTTPException(422, "A reason is required to reopen.")
    if action == "close":
        action = "approve"
    status = {"submit": "in_review", "approve": "closed", "return": "open", "reopen": "reopened"}.get(action)
    if not status:
        raise HTTPException(422, "Unknown action")
    p.status = status
    if action == "reopen":
        p.reopened_count += 1
    if action == "submit":
        p.submitted_by = ctx.actor
    if action == "approve":
        p.approved_by = ctx.actor
    p.history = [*p.history, {"action": action, "by": ctx.actor, "at": L.now_iso(), "note": note}]
    db.merge(p)
    audit(db, ctx.actor, ctx.role, f"month_{action}", month, note or "", tenant_id, commit=False)
    db.commit()
    invalidate(tenant_id)
    events.publish(tenant_id, "ledger", {"period": month})
    return {"month": month, "status": status}


def stock(db: Session, tenant_id: str) -> dict:
    st = state(db, tenant_id)
    return {r.id: running_stock(st["idx"], r.id, st["openMonth"]) for r in st["registers"] if r.mode == "full"}
