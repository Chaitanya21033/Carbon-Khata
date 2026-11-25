"""Emissions, intensity, effective tariff and base-load regression. Port of reference/src/domain/emissions.ts."""
from __future__ import annotations

from typing import Optional

from .ledger import LedgerIndex, Register, consumption, value
from .util import add_months, linreg


def factor_for(factors: list[dict], code: str, month: str) -> Optional[dict]:
    """A month uses the highest version valid in that month; months before any validity use the earliest version."""
    d = f"{month}-01"
    lst = [f for f in factors if f["code"] == code]
    valid = sorted([f for f in lst if f["valid_from"] <= d and (f["valid_to"] is None or f["valid_to"] >= d)], key=lambda f: -f["version"])
    if valid:
        return valid[0]
    lst = sorted(lst, key=lambda f: (f["valid_from"], f["version"]))
    return lst[0] if lst else None


def month_emissions(registers: list[Register], idx: LedgerIndex, factors: list[dict], month: str) -> dict:
    items = []
    for r in registers:
        if not r.factorCode:
            continue
        f = factor_for(factors, r.factorCode, month)
        if not f or f["scope"] == 3:
            continue
        qty = consumption(idx, r, month) or 0
        items.append({"code": r.code, "label": r.label, "scope": f["scope"], "qty": qty, "unit": r.unit, "factor": f["kgco2e_per_unit"], "factorVersion": f["version"], "kg": qty * f["kgco2e_per_unit"]})
    scope1 = 0.0
    for i in items:
        if i["scope"] == 1:
            scope1 += i["kg"]
    scope2 = 0.0
    for i in items:
        if i["scope"] == 2:
            scope2 += i["kg"]
    output = value(idx, "PROD", month, "reading") or 0
    kwh = value(idx, "GRID_KWH", month, "reading") or 0
    total = scope1 + scope2
    return {"month": month, "output": output, "kwh": kwh, "items": items, "scope1": scope1, "scope2": scope2, "total": total,
            "intensity": total / output if output else 0, "kwhPerUnit": kwh / output if output else 0}


def period_totals(rows: list[dict]) -> dict:
    total = sum(r["total"] for r in rows)
    output = sum(r["output"] for r in rows)
    kwh = sum(r["kwh"] for r in rows)
    by_item: dict = {}
    for r in rows:
        for i in r["items"]:
            b = by_item.setdefault(i["code"], {"label": i["label"], "qty": 0, "unit": i["unit"], "kg": 0, "scope": i["scope"]})
            b["qty"] += i["qty"]
            b["kg"] += i["kg"]
    return {"months": len(rows), "total": total, "output": output, "kwh": kwh,
            "scope1": sum(r["scope1"] for r in rows), "scope2": sum(r["scope2"] for r in rows),
            "intensity": total / output if output else 0, "byItem": by_item}


def effective_tariff(idx: LedgerIndex, months: list[str]) -> float:
    inr = kwh = 0.0
    for m in months:
        a = value(idx, "BILL_INR", m, "reading")
        k = value(idx, "GRID_KWH", m, "reading")
        if a is not None and k is not None:
            inr += a
            kwh += k
    return inr / kwh if kwh else 0


def base_load(idx: LedgerIndex, months: list[str]) -> Optional[dict]:
    pts = []
    for m in months:
        x, y = value(idx, "PROD", m, "reading"), value(idx, "GRID_KWH", m, "reading")
        if x is not None and y is not None:
            pts.append({"month": m, "x": x, "y": y})
    if len(pts) < 9:
        return None
    lr = linreg([p["x"] for p in pts], [p["y"] for p in pts])
    return {"a": lr["a"], "b": lr["b"], "r2": lr["r2"], "share": lr["a"] / lr["meanY"], "points": pts}


def last12(months: list[str]) -> list[str]:
    end = months[-1]
    start = add_months(end, -11)
    return [m for m in months if m >= start]
