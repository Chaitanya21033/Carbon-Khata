"""OEM supplier file, BRSR Principle 6, raw ledger, PACT-style passport and lender pack.
Port of reference/src/domain/exports.ts. Every value comes from the ledger index and the versioned factor library."""
from __future__ import annotations

import datetime as dt

from .emissions import factor_for, month_emissions, period_totals
from .ledger import LedgerIndex, value

SCHEMA_VERSION = "supplier_esg_v1"
GJ_PER_KWH = 0.0036
GJ_PER_L_DIESEL = 0.043 * 0.832
GJ_PER_KG_LPG = 0.0473


def _r(n: float, d: int = 1) -> float:
    import math
    p = 10 ** d
    return math.floor(n * p + 0.5) / p


def _sum_reg(idx: LedgerIndex, reg: str, months: list[str], line: str = "issued") -> float:
    return sum((value(idx, reg, m, line) or 0) for m in months)


def canonical(inp: dict) -> dict:
    """inp: supplier, plant, product, oemVendorCode, registers, idx, factors, months, dq, issues, issueStates, closed."""
    idx, months = inp["idx"], inp["months"]
    rows = [month_emissions(inp["registers"], idx, inp["factors"], m) for m in months]
    t = period_totals(rows)
    waste = [r for r in inp["registers"] if r.category in ("scrap", "waste")]
    out_months = []
    for r in rows:
        m = r["month"]
        out_months.append({
            "month": m, "status": "closed" if inp["closed"].get(m) else "open",
            "output": {"qty": r["output"], "unit": inp["product"]},
            "energy": {"grid_kwh": r["kwh"], "diesel_l": value(idx, "DIESEL", m, "issued") or 0, "lpg_kg": value(idx, "LPG", m, "issued") or 0},
            "emissions_kgco2e": {"scope1": _r(r["scope1"]), "scope2": _r(r["scope2"]), "total": _r(r["total"]), "by_source": {i["code"]: _r(i["kg"]) for i in r["items"]}},
            "intensity": {"kgco2e_per_unit": _r(r["intensity"], 2), "kwh_per_unit": _r(r["kwhPerUnit"], 2)},
            "water_l": (value(idx, "WATER_SUPPLY", m, "issued") or 0) + (value(idx, "WATER_BORE", m, "issued") or 0),
            "waste_kg": {w.code: value(idx, w.id, m, "issued") or 0 for w in waste},
            "data_quality_score": inp["dq"].get(m),
        })
    codes = []
    for r in inp["registers"]:
        if r.factorCode and r.factorCode not in codes:
            codes.append(r.factorCode)
    factors_used = []
    for c in codes:
        f = factor_for(inp["factors"], c, months[-1])
        factors_used.append({"code": f["code"], "value": f["kgco2e_per_unit"], "unit": f"kgCO2e/{f['unit']}", "version": f["version"], "source": f["source"]})
    open_issues = len([i for i in inp["issues"] if i.month in months and (inp["issueStates"].get(i.id, {}).get("status", "open")) == "open"])
    return {
        "schema_version": SCHEMA_VERSION, "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "supplier": {"name": inp["supplier"], "oem_vendor_code": inp["oemVendorCode"]}, "plant": inp["plant"],
        "period": {"from": months[0], "to": months[-1]}, "label": "Estimated from activity data and standard factors",
        "months": out_months,
        "totals": {"output": t["output"], "scope1_t": _r(t["scope1"] / 1000, 1), "scope2_t": _r(t["scope2"] / 1000, 1), "total_t": _r(t["total"] / 1000, 1), "kgco2e_per_unit": _r(t["intensity"], 1)},
        "factors_used": factors_used, "open_issues": open_issues,
    }


def to_csv(rows: list[list]) -> str:
    def cell(c):
        if isinstance(c, str):
            return f'"{c.replace(chr(34), chr(34) * 2)}"' if any(ch in c for ch in '",\n') else c
        if isinstance(c, float) and c.is_integer():
            return str(int(c))
        return "" if c is None else str(c)
    return "\n".join(",".join(cell(c) for c in r) for r in rows)


def oem_csv(c: dict) -> str:
    head = ["supplier_vendor_code", "supplier_name", "plant", "month", "month_status", "output_qty", "grid_kwh", "diesel_l", "lpg_kg", "scope1_kgco2e", "scope2_kgco2e", "total_kgco2e",
            "kgco2e_per_unit", "kwh_per_unit", "water_l", "hazardous_waste_kg", "scrap_kg", "dq_score", "schema_version"]
    rows = []
    for m in c["months"]:
        scrap = sum(v for k, v in m["waste_kg"].items() if k != "SLUDGE")
        rows.append([c["supplier"]["oem_vendor_code"], c["supplier"]["name"], c["plant"], m["month"], m["status"], m["output"]["qty"], m["energy"]["grid_kwh"], m["energy"]["diesel_l"],
                     m["energy"]["lpg_kg"], m["emissions_kgco2e"]["scope1"], m["emissions_kgco2e"]["scope2"], m["emissions_kgco2e"]["total"], m["intensity"]["kgco2e_per_unit"],
                     m["intensity"]["kwh_per_unit"], m["water_l"], m["waste_kg"].get("SLUDGE", 0), _r(scrap), m["data_quality_score"] if m["data_quality_score"] is not None else "", c["schema_version"]])
    return to_csv([head, *rows])


def brsr_p6(c: dict, inp: dict, turnover_inr: float | None = None) -> list[dict]:
    kwh = sum(m["energy"]["grid_kwh"] for m in c["months"])
    diesel = sum(m["energy"]["diesel_l"] for m in c["months"])
    lpg = sum(m["energy"]["lpg_kg"] for m in c["months"])
    water = sum(m["water_l"] for m in c["months"])
    sludge = _sum_reg(inp["idx"], "SLUDGE", inp["months"])
    scrap = sum(_sum_reg(inp["idx"], r.id, inp["months"]) for r in inp["registers"] if r.category == "scrap")
    elec_gj = kwh * GJ_PER_KWH
    fuel_gj = diesel * GJ_PER_L_DIESEL + lpg * GJ_PER_KG_LPG
    rows = [
        ("Total electricity consumption (A)", _r(elec_gj, 1), "GJ", "Grid bills"),
        ("Total fuel consumption (B)", _r(fuel_gj, 1), "GJ", "Diesel and LPG issues, IPCC 2006 NCV"),
        ("Total energy consumption (A+B)", _r(elec_gj + fuel_gj, 1), "GJ", ""),
        ("Energy intensity per unit of output", _r((elec_gj + fuel_gj) / c["totals"]["output"], 3) if c["totals"]["output"] else 0, "GJ per unit", ""),
        ("Total Scope 1 emissions", c["totals"]["scope1_t"], "tCO2e", "Diesel, LPG, CO2 welding gas"),
        ("Total Scope 2 emissions", c["totals"]["scope2_t"], "tCO2e", "CEA grid factor"),
        ("GHG intensity per unit of output", c["totals"]["kgco2e_per_unit"], "kgCO2e per unit", ""),
    ]
    if turnover_inr:
        rows.append(("GHG intensity per rupee of turnover", _r((c["totals"]["scope1_t"] + c["totals"]["scope2_t"]) * 1e6 / turnover_inr, 4), "tCO2e per ₹ crore × 10", "Turnover from the financials register"))
    rows += [
        ("Total water withdrawal", _r(water / 1000, 1), "kL", "Supply + borewell registers"),
        ("Hazardous waste generated (paint sludge)", _r(sludge / 1000, 2), "t", ""),
        ("Metal scrap generated (sent for recycling)", _r(scrap / 1000, 1), "t", ""),
        ("Period", f"{c['period']['from']} to {c['period']['to']}", "", c["schema_version"]),
    ]
    return [{"indicator": a, "value": b, "unit": u, "basis": s} for a, b, u, s in rows]


def brsr_csv(rows: list[dict]) -> str:
    return to_csv([["BRSR Principle 6 indicator", "Value", "Unit", "Basis"], *[[r["indicator"], r["value"], r["unit"], r["basis"]] for r in rows]])


def raw_ledger_csv(entries, registers) -> str:
    name = {r.id: r.label for r in registers}
    unit = {r.id: r.unit for r in registers}
    return to_csv([["entry_id", "register", "month", "line", "qty", "unit", "status", "reverses_entry_id", "corrects_entry_id", "reason", "doc_ref", "entered_by", "entered_at", "source"],
                   *[[e.id, name.get(e.registerId, e.registerId), e.month, e.line, e.qty, unit.get(e.registerId, ""), e.status, e.reversesId or "", e.correctsId or "", e.reason or "", e.docRef or "", e.by, e.at, e.source] for e in entries]])


def passport_json(c: dict, dq_avg: float) -> dict:
    return {
        "format": "pact-inspired-pcf (prototype; not certified)", "id": f"pcf-{c['supplier']['oem_vendor_code']}-{c['period']['to']}", "companyName": c["supplier"]["name"],
        "productDescription": c["months"][0]["output"]["unit"] if c["months"] else "unit", "declaredUnit": "piece",
        "pcf": {"boundary": "gate-to-gate (plant Scope 1 + 2)", "excludedEmissions": "Purchased steel and other upstream materials (Scope 3) not yet included",
                "pCfExcludingBiogenic_kgCO2e_per_unit": c["totals"]["kgco2e_per_unit"], "referencePeriodStart": c["period"]["from"], "referencePeriodEnd": c["period"]["to"],
                "crossSectoralStandardsUsed": ["GHG Protocol Corporate Standard"], "emissionFactorSources": [f"{f['code']} v{f['version']}: {f['source']}" for f in c["factors_used"]],
                "primaryDataShare": 100, "dataQualityScore_0_100": round(dq_avg), "assurance": "none (self-declared; verifier share available)"},
        "status": "Active", "version": 1,
    }


def lender_pack(c: dict, pf: dict, tariff: float, dq_avg: float) -> dict:
    return {"title": "Green-loan readiness pack", "supplier": c["supplier"]["name"], "plant": c["plant"], "period": c["period"],
            "baseline": {"kgco2e_per_unit": c["totals"]["kgco2e_per_unit"], "total_t": c["totals"]["total_t"], "effective_tariff_inr_per_kwh": _r(tariff, 2)},
            "proposed_measures": {"capex_inr": pf["capex"], "saving_inr_per_yr": round(pf["savingInr"]), "co2_t_per_yr": _r(pf["co2t"], 1), "simple_payback_yr": _r(pf["payback"], 1)},
            "data_quality_avg": round(dq_avg), "mv_method": "Post-implementation months compared with baseline adjusted for output (kWh = a + b × output)."}


def cbam_file(passports: list[dict], supplier: str, oem: dict, grid_ef: float) -> dict:
    """CBAM-style embedded-emissions declaration per finished body for an exporting OEM (illustrative, not a legal form)."""
    items = []
    for p in passports:
        items.append({"serial": f"VBW-{p['id']:05d}", "order": p["order"], "production_date": p.get("finishedAt"), "cn_code": "8707 90 (bodies for motor vehicles, illustrative)",
                      "direct_emissions_kgco2e": round(p["s1"], 2), "indirect_emissions_kgco2e": round(p["s2"], 2), "precursor_steel_kgco2e": round(p["steel"], 1),
                      "steel_kg": p["steelKg"], "steel_factor_kgco2e_per_kg": oem["steelEf"], "steel_factor_basis": oem["steelNote"], "electricity_kwh": round(p["kwh"], 1),
                      "renewable_share": round(p["renewableShare"], 3), "total_embedded_kgco2e": round(p["total"], 1)})
    tot = sum(i["total_embedded_kgco2e"] for i in items)
    return {"format": "cbam-style-embedded-emissions (demo, not a legal declaration)", "operator": supplier, "installation": "Unit 2 · Jamshedpur cluster", "reporting_oem": oem["name"],
            "grid_ef_kg_per_kwh": grid_ef, "methodology": "Actual attributed energy per body from 1-minute sub-metering; steel precursor from mill-certified factor",
            "goods": items, "total_embedded_tco2e": round(tot / 1000, 3), "count": len(items)}
