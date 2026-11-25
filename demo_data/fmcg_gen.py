"""Annapurna Foods (fictional co-packer): what its line MES and QC lab report for batch i.
Port of the generation half of buildBatch() in reference/src/domain/fmcg.ts (same seeded values)."""
from __future__ import annotations

import datetime as dt
import math
from decimal import ROUND_HALF_UP, Decimal

from .rng import rng

T0 = int(dt.datetime(2026, 11, 9, 0, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)  # 06:00 IST
SLOT_MIN, RUN_MIN, MICRO_MIN = 120, 150, 8 * 60
PRODUCTS = [
    {"id": "MC50", "packG": 50, "packs": 12000, "filmG": 2.2, "recipe": {"flour": 0.62, "oil": 0.24, "spice": 0.06, "sugar": 0.06, "salt": 0.02}},
    {"id": "GB100", "packG": 100, "packs": 7000, "filmG": 3.5, "recipe": {"flour": 0.65, "sugar": 0.25, "oil": 0.1}},
    {"id": "OD200", "packG": 200, "packs": 4000, "filmG": 6, "recipe": {"flour": 0.45, "oats": 0.2, "sugar": 0.2, "oil": 0.15}},
]
LOT = {"flour": ("WF", 6), "oats": ("OT", 9), "sugar": ("SG", 10), "oil": ("PO", 8), "spice": ("MS", 12), "salt": ("SL", 20), "film": ("PF", 15)}


def tf(x: float, d: int) -> str:
    return str(Decimal(x).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP))


def jr(x: float) -> int:
    return math.floor(x + 0.5)


def in_grp(n: int) -> str:
    s = str(n)
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:]); head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts + [tail])


def lot_id(material: str, n: int) -> str:
    return f"{LOT[material][0]}-{2600 + n:04d}"


def slot_start(i: int) -> int:
    return T0 + (i // 8) * 86_400_000 + (i % 8) * SLOT_MIN * 60_000


def batch_record(i: int) -> dict:
    """Everything the MES/LIMS will report about batch i (test results carry the time they become available)."""
    r = rng(5000 + i * 17)
    p = PRODUCTS[i % 3]
    start = slot_start(i)
    end = start + RUN_MIN * 60_000
    micro = end + MICRO_MIN * 60_000
    d = dt.datetime.fromtimestamp(start / 1000, dt.timezone.utc) + dt.timedelta(hours=5, minutes=30)
    code = f"B{str(d.year)[2:]}{d.month:02d}{d.day:02d}-{(i % 8) + 1:02d}"
    output_kg = (p["packs"] * p["packG"]) / 1000
    yield_pct = 95 + r.next() * 2.5
    input_kg = output_kg / (yield_pct / 100)
    lots = [{"lot": lot_id(m, i // LOT[m][1]), "material": m, "kg": float(tf(input_kg * share, 1))} for m, share in p["recipe"].items()]
    lots.append({"lot": lot_id("film", i // LOT["film"][1]), "material": "film", "kg": float(tf((p["packs"] * p["filmG"]) / 1000 * 1.03, 1))})
    fill_fail, moist_fail = i % 13 == 5, i % 17 == 9
    fill_mean = p["packG"] + (-1.4 if fill_fail else 0.6 + r.next() * 1.2)
    moisture = 3.4 if moist_fail else 1.9 + r.next() * 0.8
    tpc = jr(800 + r.next() * 3200)
    mid = start + RUN_MIN * 30_000
    tests = []

    def t(stage, name, spec, value, ok, by, at):
        tests.append({"stage": stage, "name": name, "spec": spec, "value": value, "ok": ok, "by": by, "at": at})
    t("in-process", "Dough moisture", "18–22 %", f"{tf(19 + r.next() * 2, 1)} %", True, "Line QC", start + 20 * 60_000)
    t("in-process", "Oven exit temperature", "180–200 °C", f"{jr(186 + r.next() * 8)} °C", True, "Oven sensor", mid)
    t("in-process", "Metal detection (Fe 1.5 mm, SS 2.5 mm)", "All rejects isolated", "Pass · test pieces rejected", True, "Metal detector", mid)
    t("final", "Product moisture", "≤ 3.0 %", f"{tf(moisture, 1)} %", not moist_fail, "QC lab", end)
    t("final", "Fill weight (mean of 30 packs)", f"≥ {p['packG']} g declared", f"{tf(fill_mean, 1)} g", not fill_fail, "Checkweigher", end)
    t("final", "Seal integrity (dye / pressure)", "No leaks in 20 packs", "0 / 20 leaks", True, "QC lab", end)
    t("final", "Label & batch code check", "Batch, MFG, EXP, MRP legible", "OK", True, "Line QC", end)
    t("lab", "Total plate count", "≤ 10,000 cfu/g", f"{in_grp(tpc)} cfu/g", True, "Micro lab (rapid)", micro)
    t("lab", "Yeast & mould", "≤ 100 cfu/g", f"{jr(10 + r.next() * 40)} cfu/g", True, "Micro lab (rapid)", micro)
    return {"code": code, "index": i, "productId": p["id"], "line": "L2" if i % 2 else "L1", "start": start, "end": end, "microAt": micro,
            "lots": lots, "tests": tests, "outputKg": output_kg, "inputKg": input_kg, "yieldPct": yield_pct}


def batches_until(clock_utc_ms: int, limit: int = 5000) -> list[dict]:
    out = []
    for i in range(limit):
        if slot_start(i) > clock_utc_ms:
            break
        out.append(batch_record(i))
    return out
