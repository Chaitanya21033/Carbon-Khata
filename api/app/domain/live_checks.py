"""Packet-level checks run when an entry arrives (port of SimEngine.check in the reference; now product-side).
V12 negative stock, V01 order-of-magnitude vs a typical single entry, V10 duplicate slip."""
from __future__ import annotations

from typing import Optional

from .util import fmt, to_fixed_str

FULL_MODE = "full"


def check(req: dict, register: Optional[dict], stock_on_hand: float, doc_seen: bool) -> Optional[dict]:
    reg_mode = (register or {}).get("mode")
    typical = (register or {}).get("typical")
    qty = req["qty"]
    if reg_mode == FULL_MODE and req["line"] == "issued" and stock_on_hand - qty < 0:
        return {"rule": "V12", "reason": f"Only {fmt(round(stock_on_hand))} in stock; issuing {fmt(qty)} would go negative."}
    if typical and req["line"] != "received" and qty > 5 * typical:
        return {"rule": "V01", "reason": f"{fmt(qty)} is {to_fixed_str(qty / typical, 0)}× a normal entry ({fmt(typical)}). Extra zero?", "suggested": round(qty / 10)}
    if doc_seen:
        return {"rule": "V10", "reason": f"Slip {req.get('docRef')} was already entered."}
    return None
