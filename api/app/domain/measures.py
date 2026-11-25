"""Energy-saving measures library and portfolio maths. Port of reference/src/domain/measures.ts (demo inputs)."""
from __future__ import annotations

import math

MEASURE_SEED = [
    {"code": "APFC", "name": "Automatic power-factor correction panel", "nameHi": "ऑटोमैटिक पावर-फ़ैक्टर पैनल", "kwhPerYr": 48000, "extraInrPerYr": 65000, "capexInr": 140000, "co2Counted": False, "status": "accepted", "note": "kVAh billing: better PF cuts billed energy and demand charge. Cost saving only."},
    {"code": "LED", "name": "LED high-bay retrofit", "nameHi": "एलईडी हाई-बे लाइट", "kwhPerYr": 160000, "extraInrPerYr": 0, "capexInr": 1100000, "co2Counted": True, "status": "suggested", "note": "Fixtures × (old W − new W) × operating hours."},
    {"code": "VFD", "name": "Variable-frequency drives (compressor, pumps, fans)", "nameHi": "वीएफडी (कंप्रेसर, पंप, पंखे)", "kwhPerYr": 150000, "extraInrPerYr": 0, "capexInr": 750000, "co2Counted": True, "status": "suggested", "note": "Motor kWh × 25–35% at part load."},
    {"code": "SOLAR", "name": "Rooftop solar, 120 kW", "nameHi": "रूफ़टॉप सोलर, 120 kW", "kwhPerYr": 120 * 4.5 * 365, "extraInrPerYr": 0, "capexInr": 5400000, "co2Counted": True, "status": "in_progress", "note": "120 kW × 4.5 kWh/kW/day × 365."},
]


def evaluate(m: dict, tariff: float, grid_ef: float) -> dict:
    saving = m["kwhPerYr"] * tariff + m["extraInrPerYr"]
    co2t = (m["kwhPerYr"] * grid_ef) / 1000 if m["co2Counted"] else 0
    return {"savingInr": saving, "co2t": co2t, "payback": m["capexInr"] / saving if saving else math.inf}


def portfolio(ms: list[dict], tariff: float, grid_ef: float) -> dict:
    rows = [{"m": m, **evaluate(m, tariff, grid_ef)} for m in ms if m["status"] != "rejected"]
    capex = sum(r["m"]["capexInr"] for r in rows)
    saving = sum(r["savingInr"] for r in rows)
    co2t = sum(r["co2t"] for r in rows)
    return {"rows": rows, "capex": capex, "savingInr": saving, "co2t": co2t, "payback": capex / saving if saving else math.inf}
