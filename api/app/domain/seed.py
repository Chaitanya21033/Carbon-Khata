"""Demo plant registers and seeded ledger (24 months of history + open-month days 1–9). Port of seed.ts.
All companies and figures are fictional."""
from __future__ import annotations

import json
from pathlib import Path

from .ledger import LedgerEntry, Register
from .synth import CONTRACT_KVA, OPEN_MONTH, synth_history, synth_open_month_days

PLANT = {
    "tenant": "Vardhan Body Works Pvt. Ltd.",
    "plant": "Unit 2 · Jamshedpur cluster",
    "product": {"name": "Tipper body", "nameHi": "टिपर बॉडी", "unit": "nos"},
    "contractDemandKva": CONTRACT_KVA,
    "utility": "State DISCOM",
    "oem": "Demo OEM (CV division)",
    "udyam": "UDYAM-JH-00-0000000",
}

IMPORT_BY = "Field associate (history import)"
IMPORT_AT = "2026-11-02T10:00:00.000Z"

ISSUE_ONLY = [
    dict(code="DIESEL", label="Diesel (HSD)", labelHi="डीज़ल", unit="L", category="fuel", factorCode="EF_DIESEL", col="diesel_l"),
    dict(code="HR_SHEET", label="HR steel sheet", labelHi="एचआर स्टील शीट", unit="kg", category="material", col="hr_sheet_kg"),
    dict(code="TUBE", label="Tube / angle", labelHi="ट्यूब / एंगल", unit="kg", category="material", col="tube_angle_kg"),
    dict(code="BAR", label="Bar / angle", labelHi="बार / एंगल", unit="kg", category="material", col="bar_angle_kg"),
    dict(code="PAINT", label="Paint", labelHi="पेंट", unit="L", category="consumable", col="paint_l"),
    dict(code="MIG_WIRE", label="MIG welding wire", labelHi="मिग वेल्डिंग तार", unit="kg", category="consumable", col="mig_wire_kg"),
    dict(code="THINNER", label="Thinner", labelHi="थिनर", unit="L", category="consumable", col="thinner_l"),
    dict(code="HARDENER", label="Hardener", labelHi="हार्डनर", unit="L", category="consumable", col="hardener_l"),
    dict(code="SHOT", label="Steel shot", labelHi="स्टील शॉट", unit="kg", category="consumable", col="steel_shots_kg"),
    dict(code="GRIT", label="Steel grit", labelHi="स्टील ग्रिट", unit="kg", category="consumable", col="steel_grits_kg"),
    dict(code="GREASE", label="Grease", labelHi="ग्रीस", unit="kg", category="consumable", col="grease_kg"),
    dict(code="WATER_SUPPLY", label="Water, supply", labelHi="पानी, सप्लाई", unit="L", category="water", col="water_supply_l"),
    dict(code="WATER_BORE", label="Water, borewell", labelHi="पानी, बोरवेल", unit="L", category="water", col="water_bore_l"),
    dict(code="CHEM_BRA", label="Brightener A", unit="L", category="chemical", col="brightener_a_l"),
    dict(code="CHEM_BRB1", label="Brightener B1", unit="L", category="chemical", col="brightener_b1_l"),
    dict(code="CHEM_BRB2", label="Brightener B2", unit="L", category="chemical", col="brightener_b2_l"),
    dict(code="CHEM_COND", label="Conditioner", unit="L", category="chemical", col="conditioner_l"),
    dict(code="CHEM_NCZ", label="NCZ-106 salt", unit="kg", category="chemical", col="ncz106_salt_kg"),
    dict(code="CHEM_HCL", label="Hydrochloric acid", unit="L", category="chemical", col="hydrochloric_acid_l"),
    dict(code="CHEM_HNO3", label="Nitric acid", unit="L", category="chemical", col="nitric_acid_l"),
    dict(code="CHEM_NAOH", label="Caustic soda", unit="kg", category="chemical", col="caustic_soda_kg"),
    dict(code="CHEM_ZN", label="Zinc ingot", unit="kg", category="chemical", col="zinc_ingot_kg"),
    dict(code="CHEM_GTX", label="Ginthox 982L", unit="L", category="chemical", col="ginthox_982l_l"),
    dict(code="CHEM_DW", label="Distilled water", unit="L", category="chemical", col="distilled_water_l"),
    dict(code="SCRAP_HR", label="HR sheet scrap", labelHi="एचआर शीट स्क्रैप", unit="kg", category="scrap", col="hr_sheet_scrap_kg"),
    dict(code="SCRAP_TUBE", label="Tube scrap", labelHi="ट्यूब स्क्रैप", unit="kg", category="scrap", col="tube_scrap_kg"),
    dict(code="SCRAP_PLASMA", label="Plasma scrap", unit="kg", category="scrap", col="plasma_scrap_kg"),
    dict(code="SCRAP_SHOT", label="Shot / grit scrap", unit="kg", category="scrap", col="shot_grit_scrap_kg"),
    dict(code="SLAG", label="Plasma slag", unit="kg", category="scrap", col="plasma_slag_kg"),
    dict(code="SLUDGE", label="Paint sludge (hazardous)", labelHi="पेंट कीचड़ (खतरनाक)", unit="kg", category="waste", col="paint_sludge_kg"),
]

FULL = [
    dict(code="HYD_OIL", label="Hydraulic oil", labelHi="हाइड्रॉलिक तेल", unit="L", category="consumable"),
    dict(code="CO2_GAS", label="CO₂ welding gas", labelHi="CO₂ वेल्डिंग गैस", unit="kg", category="gas", factorCode="EF_CO2_PROCESS", conversion={"unitLabel": "cylinder", "factor": 30}),
    dict(code="LPG", label="LPG", labelHi="एलपीजी", unit="kg", category="fuel", factorCode="EF_LPG", conversion={"unitLabel": "cylinder", "factor": 19}),
    dict(code="OXYGEN", label="Oxygen", labelHi="ऑक्सीजन", unit="m³", category="gas", conversion={"unitLabel": "cylinder", "factor": 7}),
    dict(code="ARGON", label="Argon", labelHi="आर्गन", unit="m³", category="gas"),
]

READINGS = [
    dict(code="PROD", label="Tipper bodies produced", labelHi="बनी टिपर बॉडी", unit="nos", category="production", required=True),
    dict(code="GRID_KWH", label="Grid electricity", labelHi="ग्रिड बिजली", unit="kWh", category="utility", required=True, factorCode="EF_GRID_IN"),
    dict(code="GRID_KVAH", label="Grid apparent energy", labelHi="ग्रिड kVAh", unit="kVAh", category="utility"),
    dict(code="PF", label="Power factor", labelHi="पावर फ़ैक्टर", unit="", category="utility", required=True),
    dict(code="MD_KVA", label="Maximum demand", labelHi="अधिकतम मांग", unit="kVA", category="utility"),
    dict(code="SOLAR_KWH", label="Rooftop solar generation", labelHi="रूफ़टॉप सोलर उत्पादन", unit="kWh", category="utility", factorCode="EF_SOLAR_SELF"),
    dict(code="GREEN_OA_KWH", label="Green open-access power", labelHi="ग्रीन ओपन-एक्सेस बिजली", unit="kWh", category="utility", factorCode="EF_GREEN_OA"),
    dict(code="GRID_EXPORT_KWH", label="Power exported to grid", labelHi="ग्रिड को बेची बिजली", unit="kWh", category="utility"),
    dict(code="GENSET_GAS_SCM", label="Gas genset fuel (natural gas)", labelHi="गैस जेनसेट ईंधन", unit="scm", category="fuel", factorCode="EF_PNG"),
    dict(code="BILL_INR", label="Electricity bill", labelHi="बिजली बिल", unit="₹", category="utility", required=True),
]

# Usual size of ONE shop-floor entry; a live entry 5× bigger is held (live V01). From the reference engine.
TYPICAL = {"SOLAR_KWH": 400, "GREEN_OA_KWH": 400, "GRID_EXPORT_KWH": 400, "GENSET_GAS_SCM": 100, "GRID_KWH": 900, "HR_SHEET": 3200, "CO2_GAS": 30, "LPG": 19, "DIESEL": 40, "PAINT": 22, "THINNER": 9, "HYD_OIL": 30, "SCRAP_HR": 1600, "SLUDGE": 7, "PROD": 1}

FACTORS: list[dict] = json.loads((Path(__file__).resolve().parent.parent / "data" / "emission_factors.json").read_text(encoding="utf-8"))["factors"]


def registers() -> list[Register]:
    out = []
    for d in READINGS:
        out.append(Register(id=d["code"], mode="reading", typical=TYPICAL.get(d["code"]), **d))
    for d in FULL:
        out.append(Register(id=d["code"], mode="full", typical=TYPICAL.get(d["code"]), **d))
    for d in ISSUE_ONLY:
        dd = {k: v for k, v in d.items() if k != "col"}
        out.append(Register(id=d["code"], mode="issue_only", typical=TYPICAL.get(d["code"]), **dd))
    return out


def build_seed() -> dict:
    n = 0
    h = synth_history()
    entries: list[LedgerEntry] = []

    def entry(reg, month, line, qty, source="import") -> LedgerEntry:
        nonlocal n
        n += 1
        return LedgerEntry(id=f"seed_{n}", registerId=reg, month=month, line=line, qty=float(qty), status="posted", by=IMPORT_BY, at=IMPORT_AT, source=source, docRef=f"IMPORT-{reg}-{month}-{line}")

    for i, m in enumerate(h["months"]):
        row = h["rows"][i]
        entries.append(entry("PROD", m, "reading", row["bodies_produced"]))
        for reg, col in [("GRID_KWH", "grid_kwh"), ("GRID_KVAH", "grid_kvah"), ("PF", "power_factor"), ("MD_KVA", "max_demand_kva"), ("BILL_INR", "bill_inr")]:
            if row[col] is not None:
                entries.append(entry(reg, m, "reading", row[col], "bill"))
        for d in FULL:
            ln = h["full"][d["code"]][i]
            for line in ("opening", "received", "issued", "closing"):
                entries.append(entry(d["code"], m, line, ln[line]))
        for d in ISSUE_ONLY:
            if row.get(d["col"]) is not None:
                entries.append(entry(d["code"], m, "issued", row[d["col"]]))

    last = len(h["months"]) - 1
    for d in FULL:
        e = entry(d["code"], OPEN_MONTH, "opening", max(0, h["full"][d["code"]][last]["closing"]))
        e.source, e.by, e.reason, e.docRef = "app", "System (carry-forward)", "Carry-forward from previous closing", None
        entries.append(e)
    for reg, qty, doc in (("CO2_GAS", 3000, "GRN-2611-014"), ("LPG", 380, "GRN-2611-015")):
        e = entry(reg, OPEN_MONTH, "received", qty)
        e.source, e.by, e.docRef = "app", "Stores", doc
        entries.append(e)
    for day in synth_open_month_days():
        dd = f"{day['day']:02d}"
        at = f"2026-11-{dd}T18:00:00.000Z"

        def add(reg, line, qty, by, source="app"):
            if qty > 0:
                e = entry(reg, OPEN_MONTH, line, qty, source)
                e.at, e.by, e.docRef = at, by, f"{reg}-2611{dd}-D"
                entries.append(e)
        add("PROD", "reading", day["bodies"], "Line supervisor")
        sunday = day["bodies"] == 0
        solar = round(1350 + ((day["day"] * 37) % 9) * 40 - (700 if day["day"] == 4 else 0))
        green = 600 if sunday else 1900 + ((day["day"] * 53) % 7) * 30
        gen_kwh = 0 if sunday else 1050 + ((day["day"] * 29) % 5) * 40
        add("GRID_KWH", "reading", max(400, day["kwh"] - solar - green - gen_kwh + 140), "Meter gateway", "meter")
        add("SOLAR_KWH", "reading", solar, "EMS gateway", "meter")
        add("GREEN_OA_KWH", "reading", green, "EMS gateway", "meter")
        from .util import js_round
        add("GENSET_GAS_SCM", "reading", js_round(gen_kwh / 3.3), "EMS gateway", "meter")
        add("GRID_EXPORT_KWH", "reading", 520 if sunday else 140, "EMS gateway", "meter")
        add("DIESEL", "issued", day["diesel"], "Stores")
        add("HR_SHEET", "issued", day["hr"], "Stores")
        add("PAINT", "issued", day["paint"], "Paint shop")
        add("CO2_GAS", "issued", day["co2"], "Stores")
        add("LPG", "issued", day["lpg"], "Stores")
        add("HYD_OIL", "issued", day["hyd"], "Stores")
    return {"registers": registers(), "entries": entries, "plantMonths": h["months"], "billMonths": h["months"]}
