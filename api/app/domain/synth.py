"""Deterministic dummy-data generator (24 months of history with planted mistakes). Bit-exact port of synth.ts.
Every company, figure and error here is invented."""
from __future__ import annotations

import math
from datetime import date

from .rng import rng
from .util import add_months, js_round, round_to

HISTORY_START = "2024-11"
HISTORY_MONTHS = 24
OPEN_MONTH = "2026-11"
CONTRACT_KVA = 450
TRUE_A = 120000
TRUE_B = 110
ENERGY_RATE = 6.45
DEMAND_RATE = 420

PLANTED = {"hrSheetExtraZero": 4, "hrSheetMissingDigit": 13, "lowOutputMonth": 7, "pfMissing": 9, "billExtraZero": 17, "hydClosingWrong": [3, 11, 19], "hydOverIssue": 15}


def synth_history(seed: int = 2026) -> dict:
    r = rng(seed)
    months = [add_months(HISTORY_START, i) for i in range(HISTORY_MONTHS)]
    rows: list[dict] = []
    truth = {"units": [], "kwh": [], "bill": [], "pf": []}
    stock = {"CO2_GAS": 240, "LPG": 76, "OXYGEN": 70, "ARGON": 6000, "HYD_OIL": 1260}
    size = {"CO2_GAS": 30, "LPG": 19, "OXYGEN": 7, "ARGON": 1000, "HYD_OIL": 210}
    full = {k: [] for k in stock}
    R = js_round
    for i, _ in enumerate(months):
        season = 1 + 0.1 * math.sin((2 * math.pi * (i + 2)) / 12)
        units = R(400 * season * (1 + r.normal(0.05)))
        if i == PLANTED["lowOutputMonth"]:
            units = R(units * 0.55)
        kwh = R(TRUE_A + TRUE_B * units + r.normal(4500))
        pf = round_to(0.93 + r.next() * 0.04, 2)
        kvah = R(kwh / pf)
        md = R(360 + 0.2 * units + r.normal(20))
        bill = R(kwh * ENERGY_RATE + md * DEMAND_RATE)
        truth["units"].append(units); truth["kwh"].append(kwh); truth["bill"].append(bill); truth["pf"].append(pf)
        hr_true = R(units * 3200 * (1 + r.normal(0.04)))
        hr = hr_true
        if i == PLANTED["hrSheetExtraZero"]:
            hr = hr_true * 10
        if i == PLANTED["hrSheetMissingDigit"]:
            hr = R(hr_true / 10)
        row = {"bodies_produced": units, "grid_kwh": kwh, "grid_kvah": kvah, "power_factor": None if i == PLANTED["pfMissing"] else pf, "max_demand_kva": md,
               "bill_inr": bill * 10 if i == PLANTED["billExtraZero"] else bill}
        row["diesel_l"] = R(2600 + r.normal(320))
        row["hr_sheet_kg"] = hr
        row["tube_angle_kg"] = R(units * 420 * (1 + r.normal(0.05)))
        row["bar_angle_kg"] = R(units * 12 * (1 + r.normal(0.08)))
        row["paint_l"] = R(units * 22 * (1 + r.normal(0.05)))
        row["mig_wire_kg"] = R(units * 38 * (1 + r.normal(0.05)))
        row["thinner_l"] = R(units * 9 * (1 + r.normal(0.06)))
        row["hardener_l"] = R(units * 4 * (1 + r.normal(0.06)))
        row["steel_shots_kg"] = R(units * 7 * (1 + r.normal(0.08)))
        row["steel_grits_kg"] = R(units * 3.5 * (1 + r.normal(0.08)))
        row["grease_kg"] = R(90 + r.normal(8))
        row["water_supply_l"] = 9000
        row["water_bore_l"] = R(14000 + r.normal(1300))
        row["brightener_a_l"] = R(28 + r.normal(4))
        row["brightener_b1_l"] = R(26 + r.normal(4))
        row["brightener_b2_l"] = R(24 + r.normal(4))
        row["conditioner_l"] = 30
        row["ncz106_salt_kg"] = R(48 + r.normal(5))
        row["hydrochloric_acid_l"] = R(850 + r.normal(70))
        row["nitric_acid_l"] = 30
        row["caustic_soda_kg"] = R(72 + r.normal(7))
        row["zinc_ingot_kg"] = R(96 + r.normal(9))
        row["ginthox_982l_l"] = 30
        row["distilled_water_l"] = 1200
        row["hr_sheet_scrap_kg"] = R(hr_true * 0.032 * (1 + r.normal(0.05)))
        row["tube_scrap_kg"] = R(units * 13 * (1 + r.normal(0.08)))
        row["plasma_scrap_kg"] = R(1700 + r.normal(150))
        row["shot_grit_scrap_kg"] = R(240 + r.normal(25))
        row["plasma_slag_kg"] = R(430 + r.normal(40))
        row["paint_sludge_kg"] = R(units * 0.45 * (1 + r.normal(0.08)))
        rows.append(row)

        issue = {
            "CO2_GAS": R(units * 21 * (1 + r.normal(0.04))),
            "LPG": R(units * 2.2 * (1 + r.normal(0.06))),
            "OXYGEN": round_to(units * 0.75 * (1 + r.normal(0.06)), 1),
            "ARGON": round_to(units * 65 * (1 + r.normal(0.05)), 1),
            "HYD_OIL": R(900 + r.normal(140)),
        }
        for k in stock:
            opening = stock[k]
            received = 0
            buffer = size[k] * 2
            if k == "HYD_OIL" and i == PLANTED["hydOverIssue"]:
                received = 0
            elif opening - issue[k] < buffer:
                received = math.ceil((issue[k] + buffer - opening) / size[k]) * size[k]
            iss = issue[k]
            if k == "HYD_OIL" and i == PLANTED["hydOverIssue"]:
                iss = opening + 420
            closing = round_to(opening + received - iss, 1)
            if k == "HYD_OIL" and i == PLANTED["hydOverIssue"]:
                closing = 0
            if k == "HYD_OIL" and i in PLANTED["hydClosingWrong"]:
                s = str(int(js_round(closing))).rjust(3, "0")
                closing = float(s[:-2] + s[-1:] + s[-2:-1]) + 100
            full[k].append({"opening": opening, "received": received, "issued": iss, "closing": closing})
            stock[k] = max(closing, 0)
    return {"months": months, "rows": rows, "full": full, "truth": truth}


def synth_monthly_csv(h: dict | None = None) -> str:
    h = h or synth_history()
    cols = list(h["rows"][0].keys())
    lines = [",".join(["period_month", *cols])]

    def cell(v):
        if v is None:
            return ""
        return str(int(v)) if float(v).is_integer() else str(v)
    for i, row in enumerate(h["rows"]):
        lines.append(",".join([h["months"][i], *[cell(row[c]) for c in cols]]))
    return "\n".join(lines)


def synth_open_month_days(seed: int = 77) -> list[dict]:
    r = rng(seed)
    days = []
    R = js_round
    for d in range(1, 10):
        sunday = date(2026, 11, d).weekday() == 6
        bodies = 0 if sunday else r.int(14, 18)
        days.append({
            "day": d, "bodies": bodies,
            "kwh": R((TRUE_A / 30) + TRUE_B * bodies + 950 + r.normal(150)),
            "diesel": R(20 if sunday else 85 + r.normal(15)),
            "hr": bodies * 3200 + R(r.normal(2000)),
            "paint": R(bodies * 22 + r.normal(10)),
            "co2": 0 if sunday else 300 + r.int(0, 3) * 30,
            "lpg": 0 if sunday else 38,
            "hyd": R(30 + r.normal(5)),
        })
    return days
