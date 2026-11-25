"""Register ledger: signed quantity lines per register / month / line type, corrections by reversal.

Port of reference/src/domain/ledger.ts. Posted entries are never edited: a correction reverses every active
entry on the line and posts one new entry with the corrected quantity.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import asdict, dataclass, field
from typing import Optional

LINES = ("opening", "received", "issued", "closing", "adjustment", "reading")
DIRECTION = {"opening": "stock", "closing": "stock", "received": "in", "issued": "out", "adjustment": "adjust", "reading": "reading"}


@dataclass
class Register:
    id: str
    code: str
    label: str
    unit: str
    category: str
    mode: str  # full | issue_only | reading
    labelHi: Optional[str] = None
    required: bool = False
    conversion: Optional[dict] = None
    factorCode: Optional[str] = None
    typical: Optional[float] = None

    def to_json(self) -> dict:
        d = {k: v for k, v in asdict(self).items() if v is not None and v is not False}
        return d


@dataclass
class LedgerEntry:
    id: str
    registerId: str
    month: str
    line: str
    qty: float
    status: str = "posted"  # posted | reversed | held | rejected
    by: str = "system"
    at: str = ""
    source: str = "app"
    reversesId: Optional[str] = None
    correctsId: Optional[str] = None
    reason: Optional[str] = None
    docRef: Optional[str] = None
    idempotencyKey: Optional[str] = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


_counter = itertools.count(1)


def uid(prefix: str = "id") -> str:
    return f"{prefix}_{int(time.time() * 1000):x}{next(_counter):x}"


def now_iso() -> str:
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


def _key(reg: str, month: str, line: str) -> tuple:
    return (reg, month, line)


class LedgerIndex(dict):
    """(register, month, line) → {'sum': float, 'entries': [LedgerEntry]}. Only posted/reversed lines count."""


def build_index(entries: list[LedgerEntry]) -> LedgerIndex:
    idx = LedgerIndex()
    for e in entries:
        if e.status in ("held", "rejected"):
            continue
        k = _key(e.registerId, e.month, e.line)
        cur = idx.get(k)
        if cur is None:
            cur = idx[k] = {"sum": 0.0, "entries": []}
        cur["sum"] += e.qty
        cur["entries"].append(e)
    return idx


def value(idx: LedgerIndex, reg: str, month: str, line: str) -> Optional[float]:
    v = idx.get(_key(reg, month, line))
    if v is None:
        return None
    from .util import js_round
    return js_round(v["sum"] * 1e6) / 1e6


def line_entries(idx: LedgerIndex, reg: str, month: str, line: str) -> list[LedgerEntry]:
    v = idx.get(_key(reg, month, line))
    return v["entries"] if v else []


def primary_line(r: Register) -> str:
    return "reading" if r.mode == "reading" else "issued"


def consumption(idx: LedgerIndex, r: Register, month: str) -> Optional[float]:
    return value(idx, r.id, month, primary_line(r))


def tolerance(calc: float) -> float:
    return max(0.5, abs(calc) * 0.001)


def balance(idx: LedgerIndex, reg_id: str, month: str) -> dict:
    opening = value(idx, reg_id, month, "opening")
    received = value(idx, reg_id, month, "received") or 0
    issued = value(idx, reg_id, month, "issued") or 0
    adjustment = value(idx, reg_id, month, "adjustment") or 0
    closing = value(idx, reg_id, month, "closing")
    if opening is None or closing is None:
        return {"opening": opening, "received": received, "issued": issued, "adjustment": adjustment, "closing": closing, "ok": True, "tolerance": 0.5, "calc": None}
    calc = opening + received - issued + adjustment
    tol = tolerance(calc)
    diff = closing - calc
    return {"opening": opening, "received": received, "issued": issued, "adjustment": adjustment, "closing": closing, "calc": calc, "diff": diff, "ok": abs(diff) <= tol, "tolerance": tol, "running": calc}


def running_stock(idx: LedgerIndex, reg_id: str, month: str) -> float:
    """Stock on hand within an open month: opening + received − issued + adjustment."""
    return (value(idx, reg_id, month, "opening") or 0) + (value(idx, reg_id, month, "received") or 0) - (value(idx, reg_id, month, "issued") or 0) + (value(idx, reg_id, month, "adjustment") or 0)


def correct_line(entries: list[LedgerEntry], reg_id: str, month: str, line: str, new_qty: float, reason: str, by: str) -> tuple[list[LedgerEntry], list[LedgerEntry]]:
    if not reason or not reason.strip():
        raise ValueError("A reason is required for every correction")
    at = now_iso()
    active = [e for e in entries if e.registerId == reg_id and e.month == month and e.line == line and e.status == "posted" and not e.reversesId]
    created: list[LedgerEntry] = []
    reversed_ids = set()
    for e in active:
        reversed_ids.add(e.id)
        created.append(LedgerEntry(id=uid("rev"), registerId=reg_id, month=month, line=line, qty=-e.qty, status="posted", reversesId=e.id, reason=reason, by=by, at=at, source="app"))
    created.append(LedgerEntry(id=uid("ent"), registerId=reg_id, month=month, line=line, qty=new_qty, status="posted", correctsId=active[0].id if active else None, reason=reason, by=by, at=at, source="app"))
    nxt = []
    for e in entries:
        if e.id in reversed_ids:
            e = LedgerEntry(**{**asdict(e), "status": "reversed"})
        nxt.append(e)
    return nxt + created, created


def post_entry(entries: list[LedgerEntry], e: LedgerEntry) -> tuple[list[LedgerEntry], bool]:
    if e.idempotencyKey and any(x.idempotencyKey == e.idempotencyKey for x in entries):
        return entries, True
    return entries + [e], False


def is_duplicate_doc(entries: list[LedgerEntry], doc_ref: Optional[str]) -> Optional[LedgerEntry]:
    if not doc_ref:
        return None
    for e in entries:
        if e.docRef == doc_ref and e.status == "posted" and not e.reversesId:
            return e
    return None


@dataclass
class MonthClose:
    month: str
    status: str = "open"
    reopenedCount: int = 0
    submittedBy: Optional[str] = None
    approvedBy: Optional[str] = None
    history: list = field(default_factory=list)
