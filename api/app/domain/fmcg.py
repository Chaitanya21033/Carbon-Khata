"""FMCG batch tracing for the fictional co-packer (Annapurna Foods): release gate, recall, carbon per pack, dispatch.
Port of the evaluation half of buildBatch() in reference/src/domain/fmcg.ts. Batch facts (lots, test results)
arrive from the line MES / QC lab; this module decides status from them."""
from __future__ import annotations

import datetime as dt
import json

CO_PACKER = {"name": "Annapurna Foods (co-packer)", "plant": "Unit 1 · Jamshedpur cluster", "fssai": "FSSAI Lic. 1002XXXXXXXXXX (demo)"}
BRANDS = {"A": {"name": "Brand A Foods", "color": "#C2410C"}, "B": {"name": "Brand B Nutrition", "color": "#1D5FA8"}}
MATERIALS = {
    "flour": {"name": "Wheat flour (maida)", "supplier": "Shree Roller Flour Mill", "prefix": "WF", "every": 6, "kgCo2PerKg": 0.55, "coa": "Moisture ≤ 14%, gluten 9–11%"},
    "oats": {"name": "Rolled oats", "supplier": "Himgiri Agro", "prefix": "OT", "every": 9, "kgCo2PerKg": 0.7, "coa": "Moisture ≤ 12%, foreign matter nil"},
    "sugar": {"name": "Sugar (S-30)", "supplier": "Kosi Sugar Mills", "prefix": "SG", "every": 10, "kgCo2PerKg": 0.8, "coa": "ICUMSA ≤ 150, moisture ≤ 0.1%"},
    "oil": {"name": "Palm oil (RBD)", "supplier": "Coastal Edible Oils", "prefix": "PO", "every": 8, "kgCo2PerKg": 3.0, "coa": "FFA ≤ 0.1%, peroxide ≤ 1 meq/kg"},
    "spice": {"name": "Masala seasoning", "supplier": "Spice Route Blends", "prefix": "MS", "every": 12, "kgCo2PerKg": 1.0, "coa": "Salmonella absent / 25 g, aflatoxin ≤ 10 ppb"},
    "salt": {"name": "Iodised salt", "supplier": "Sambhar Salts", "prefix": "SL", "every": 20, "kgCo2PerKg": 0.2, "coa": "Iodine ≥ 15 ppm"},
    "film": {"name": "Laminated pack film", "supplier": "Flexi Pack Industries", "prefix": "PF", "every": 15, "kgCo2PerKg": 3.5, "coa": "Seal strength ≥ 1.5 N/15 mm, migration within limits"},
}
PRODUCTS = {
    "MC50": {"id": "MC50", "name": "Masala Crunch 50 g", "brand": "A", "packG": 50, "packs": 12000, "filmG": 2.2, "shelfDays": 180, "recipe": {"flour": 0.62, "oil": 0.24, "spice": 0.06, "sugar": 0.06, "salt": 0.02}, "mrp": 10},
    "GB100": {"id": "GB100", "name": "Glucose Biscuit 100 g", "brand": "A", "packG": 100, "packs": 7000, "filmG": 3.5, "shelfDays": 270, "recipe": {"flour": 0.65, "sugar": 0.25, "oil": 0.1}, "mrp": 10},
    "OD200": {"id": "OD200", "name": "Oat Digestive 200 g", "brand": "B", "packG": 200, "packs": 4000, "filmG": 6, "shelfDays": 240, "recipe": {"flour": 0.45, "oats": 0.2, "sugar": 0.2, "oil": 0.15}, "mrp": 50},
}
DISTRIBUTORS = ["Ranchi Distributors", "Kolkata Central Depot", "Bhubaneswar Traders", "Patna FMCG Hub", "Dhanbad Supply Co."]
KWH_PER_KG, LPG_PER_KG, LPG_EF = 0.35, 0.06, 2.98


def ist_date(t_ms: int) -> str:
    return (dt.datetime.fromtimestamp(t_ms / 1000, dt.timezone.utc) + dt.timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")


def evaluate(rec: dict, clock_utc: int, flagged_lots: set, overrides: dict, energy_ef: float, renewable_share: float, results: dict | None = None) -> dict:
    """rec: batch facts. results: {test name: reported value/ok} received so far (None → every test due by clock is reported).
    overrides: {'<code>|<test>': 'pass'|'fail'|'pending'} set by QC staff."""
    p = PRODUCTS[rec["productId"]]
    tests = []
    for t in rec["tests"]:
        key = f"{rec['code']}|{t['name']}"
        reported = (t["at"] <= clock_utc) if results is None else (t["name"] in results)
        st = overrides.get(key) or ("pending" if not reported else ("pass" if t["ok"] else "fail"))
        tests.append({**{k: v for k, v in t.items() if k != "ok"}, "value": t["value"] if reported else "—", "status": st})
    failed = [x for x in tests if x["status"] == "fail"]
    pending = [x for x in tests if x["status"] == "pending"]
    recalled_lot = next((l for l in rec["lots"] if l["lot"] in flagged_lots), None)
    status = "in_production" if clock_utc < rec["end"] else "held" if failed else "qc_pending" if pending else "released"
    if recalled_lot and status != "in_production":
        status = "recalled"
    hold = f"Ingredient lot {recalled_lot['lot']} flagged" if recalled_lot else (f"Failed: {', '.join(f['name'] for f in failed)}" if failed else None)
    ing = sum(l["kg"] * MATERIALS[l["material"]]["kgCo2PerKg"] for l in rec["lots"] if l["material"] != "film")
    pack = sum(l["kg"] * MATERIALS["film"]["kgCo2PerKg"] for l in rec["lots"] if l["material"] == "film")
    kwh, lpg = rec["outputKg"] * KWH_PER_KG, rec["outputKg"] * LPG_PER_KG
    energy = kwh * energy_ef + lpg * LPG_EF
    per_pack_g = ((ing + pack + energy) / p["packs"]) * 1000
    dispatch = []
    if status in ("released", "recalled"):
        left = p["packs"]
        n = 2 + (rec["index"] % 3)
        for k in range(n):
            q = left if k == n - 1 else round(p["packs"] / n)
            dispatch.append({"to": DISTRIBUTORS[(rec["index"] + k) % len(DISTRIBUTORS)], "packs": q})
            left -= q
    return {"id": rec["code"], "index": rec["index"], "product": p, "line": rec["line"], "start": rec["start"], "end": rec["end"], "microAt": rec["microAt"], "status": status,
            "holdReason": hold, "tests": tests, "lots": rec["lots"], "outputKg": rec["outputKg"], "inputKg": rec["inputKg"], "yieldPct": rec["yieldPct"], "kwh": kwh, "lpgKg": lpg,
            "carbon": {"ingredients": ing, "packaging": pack, "energy": energy, "perPackG": per_pack_g}, "renewableShare": renewable_share, "dispatch": dispatch,
            "mfg": ist_date(rec["start"]), "exp": ist_date(rec["start"] + p["shelfDays"] * 86_400_000)}


def lot_index(batches: list[dict]) -> list[dict]:
    m: dict = {}
    for b in batches:
        for l in b["lots"]:
            e = m.setdefault(l["lot"], {"lot": l["lot"], "material": l["material"], "batches": [], "kg": 0.0})
            e["batches"].append(b["id"]); e["kg"] += l["kg"]
    out = list(m.values())
    out.sort(key=lambda e: e["lot"], reverse=True)
    out.sort(key=lambda e: e["material"])
    return out


def batch_fingerprint(b: dict) -> str:
    return json.dumps({"id": b["id"], "product": b["product"]["id"], "mfg": b["mfg"], "exp": b["exp"], "tests": [[t["name"], t["value"], t["status"]] for t in b["tests"]],
                       "lots": [[l["lot"], l["kg"]] for l in b["lots"]], "carbon": round(b["carbon"]["perPackG"])}, separators=(",", ":"), ensure_ascii=False)
