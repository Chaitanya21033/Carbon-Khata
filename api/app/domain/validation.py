"""Validation rules V01–V12 and the data-quality score. Exact port of reference/src/domain/validation.ts."""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from .ledger import LedgerIndex, MonthClose, Register, balance, primary_line, value
from .util import fmt, month_label, nearest_median, to_fixed_str

_DATA = json.loads((Path(__file__).resolve().parent.parent / "data" / "validation_rules.json").read_text(encoding="utf-8"))
RULES: list[dict] = _DATA["rules"]
DQ: dict = _DATA["dq_score"]


def rule(code: str) -> dict:
    return next(r for r in RULES if r["code"] == code)


def sev(code: str) -> tuple[str, bool]:
    s = rule(code)["severity"]
    if s.startswith("block"):
        return "block", True
    if s == "warn_block_at_close":
        return "warn", True
    if s == "info":
        return "info", False
    return "warn", False


def fill(tpl: str, vars: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(vars.get(m.group(1), "")), tpl)


@dataclass
class Issue:
    id: str
    rule: str
    severity: str
    blocksClose: bool
    month: str
    field: str
    message: str
    messageHi: str
    registerId: Optional[str] = None
    line: Optional[str] = None
    expected: Optional[float] = None
    actual: Optional[float] = None
    series: Optional[list] = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class ValidationContext:
    registers: list[Register]
    idx: LedgerIndex
    plantMonths: list[str]
    billMonths: list[str]
    contractDemandKva: float


NO_OUTLIER = {"PF", "MD_KVA"}
NO_FLAT = {"PF", "MD_KVA"}


def months_for(ctx: ValidationContext, r: Register) -> list[str]:
    return ctx.billMonths if r.category == "utility" else ctx.plantMonths


def _js(v):
    """String(v) for a JS number: integers print without a decimal point."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def mk(code: str, vars: dict, **partial) -> Issue:
    d = rule(code)
    s, b = sev(code)
    return Issue(rule=code, severity=s, blocksClose=b, message=fill(d["message_en"], vars), messageHi=fill(d["message_hi"], vars), **partial)


def run_validation(ctx: ValidationContext) -> list[Issue]:
    issues: list[Issue] = []
    idx = ctx.idx
    for r in ctx.registers:
        months = months_for(ctx, r)
        line = primary_line(r)
        vals = [value(idx, r.id, m, line) for m in months]
        series = [{"month": m, "value": vals[i] if vals[i] is not None else 0} for i, m in enumerate(months)]
        label = r.label

        if r.id not in NO_OUTLIER:
            p1, p2 = rule("V01")["params"], rule("V02")["params"]
            for i, v in enumerate(vals):
                if v is None:
                    continue
                med, count = nearest_median(vals, i, int(p1["window_months"]))
                if count < int(p1["min_history_months"]) or not (med > 0):
                    continue
                m = months[i]
                win = series[max(0, i - 6): i + 7]
                if v > float(p1["multiple_of_median"]) * med:
                    issues.append(mk("V01", {"ratio": to_fixed_str(v / med, 1), "field": label.lower()}, id=f"V01|{r.id}|{m}|{line}", registerId=r.id, month=m, line=line, field=label, expected=med, actual=v, series=win))
                elif v < float(p2["fraction_of_median"]) * med:
                    issues.append(mk("V02", {"ratio": to_fixed_str(v / med, 2), "field": label.lower()}, id=f"V02|{r.id}|{m}|{line}", registerId=r.id, month=m, line=line, field=label, expected=med, actual=v, series=win))

        if r.id not in NO_FLAT:
            need = int(rule("V03")["params"]["consecutive_months"])
            start = 0
            for i in range(1, len(vals) + 1):
                if i < len(vals) and vals[i] is not None and vals[i] == vals[start] and vals[i] != 0:
                    continue
                ln = i - start
                if ln >= need and vals[start] is not None and vals[start] != 0:
                    m = months[start]
                    issues.append(mk("V03", {"field": label, "value": fmt(vals[start]), "n": ln}, id=f"V03|{r.id}|{m}", registerId=r.id, month=m, line=line, field=label, actual=vals[start], series=series[start:i]))
                start = i

        if r.required:
            for i, m in enumerate(months):
                if vals[i] is None:
                    issues.append(mk("V04", {"field": label, "month": month_label(m, "en", False)}, id=f"V04|{r.id}|{m}", registerId=r.id, month=m, line=line, field=label))

        if r.mode == "full":
            prev_closing = None
            for m in months:
                b = balance(idx, r.id, m)
                if b["calc"] is None:
                    prev_closing = b["closing"]
                    continue
                vv = {"o": fmt(b["opening"]), "r": fmt(b["received"]), "i": fmt(b["issued"]), "calc": fmt(b["calc"]), "c": fmt(b["closing"])}
                if not b["ok"]:
                    issues.append(mk("V05", vv, id=f"V05|{r.id}|{m}", registerId=r.id, month=m, line="closing", field=label, expected=b["calc"], actual=b["closing"]))
                elif prev_closing is not None and abs((b["opening"] or 0) - prev_closing) > 0.5:
                    issues.append(mk("V05", vv, id=f"V05cf|{r.id}|{m}", registerId=r.id, month=m, line="opening", field=f"{label} (carry-forward)", expected=prev_closing, actual=b["opening"]))
                if b["calc"] < -b["tolerance"]:
                    issues.append(mk("V12", {"value": fmt(b["calc"])}, id=f"V12|{r.id}|{m}", registerId=r.id, month=m, line="issued", field=label, expected=0, actual=b["calc"]))
                prev_closing = b["closing"]

    bm = ctx.billMonths
    kwh = [value(idx, "GRID_KWH", m, "reading") for m in bm]
    kvah = [value(idx, "GRID_KVAH", m, "reading") for m in bm]
    amt = [value(idx, "BILL_INR", m, "reading") for m in bm]
    pf = [value(idx, "PF", m, "reading") for m in bm]
    md = [value(idx, "MD_KVA", m, "reading") for m in bm]
    rate = [(amt[i] / kwh[i]) if (kwh[i] and amt[i] is not None) else None for i in range(len(bm))]
    for i, m in enumerate(bm):
        if md[i] is not None and md[i] > ctx.contractDemandKva:
            issues.append(mk("V06", {"md": fmt(md[i]), "cd": _js(ctx.contractDemandKva)}, id=f"V06|{m}", registerId="MD_KVA", month=m, line="reading", field="Maximum demand", expected=ctx.contractDemandKva, actual=md[i]))
        if rate[i] is not None:
            med, _ = nearest_median(rate, i, 6)
            p = rule("V07")["params"]
            if rate[i] < float(p["low"]) * med or rate[i] > float(p["high"]) * med:
                issues.append(mk("V07", {"rate": to_fixed_str(rate[i], 2), "median": to_fixed_str(med, 2)}, id=f"V07|{m}", registerId="BILL_INR", month=m, line="reading", field="Electricity bill", expected=med * kwh[i], actual=amt[i]))
        if kwh[i] and kvah[i]:
            implied = kwh[i] / kvah[i]
            tol = float(rule("V08")["params"]["pf_tolerance"])
            if kvah[i] < kwh[i] or (pf[i] is not None and abs(implied - pf[i]) > tol):
                issues.append(mk("V08", {"pf": _js(pf[i]) if pf[i] is not None else "—", "implied": to_fixed_str(implied, 2)}, id=f"V08|{m}", registerId="PF", month=m, line="reading", field="Power factor", expected=implied, actual=pf[i]))

    pm = ctx.plantMonths
    kpu = []
    for m in pm:
        k = value(idx, "GRID_KWH", m, "reading")
        p = value(idx, "PROD", m, "reading")
        kpu.append(k / p if (k and p) else None)
    band = float(rule("V09")["params"]["band"])
    for i, v in enumerate(kpu):
        if v is None:
            continue
        med, _ = nearest_median(kpu, i, 12)
        if abs(v - med) / med > band:
            m = pm[i]
            issues.append(mk("V09", {"kwh_per_unit": to_fixed_str(v, 0), "median": to_fixed_str(med, 0)}, id=f"V09|{m}", registerId="GRID_KWH", month=m, line="reading", field="kWh per unit", expected=med, actual=v))
    return issues


def effective_status(issue: Issue, states: dict) -> str:
    st = states.get(issue.id)
    return st["status"] if st else "open"


def dq_score(month: str, issues: list[Issue], states: dict, close: Optional[MonthClose], missing_source: bool) -> float:
    s = DQ["start"]
    for i in issues:
        if i.month != month:
            continue
        st = effective_status(i, states)
        if st == "open" and i.severity == "block":
            s += DQ["per_open_block"]
        elif st == "open" and i.severity == "warn":
            s += DQ["per_open_warn"]
        elif st == "accepted":
            s += DQ["per_accepted_as_real"]
    if close and close.reopenedCount > 0:
        s += DQ["month_reopened"] * close.reopenedCount
    if missing_source:
        s += DQ["missing_required_source"]
    return max(DQ["floor"], min(100, s))


def close_blockers(month: str, issues: list[Issue], states: dict) -> list[Issue]:
    return [i for i in issues if i.month == month and i.blocksClose and effective_status(i, states) == "open"]
