"""Port of reference/src/domain/__tests__/acceptance.test.ts (19 tests). The generator plants known data-entry
mistakes; these prove the engine finds exactly those and computes the carbon ledger against the generator's truth."""
import json
from pathlib import Path

import pytest

from app.domain.emissions import base_load, effective_tariff, month_emissions, period_totals
from app.domain.ledger import LedgerEntry, MonthClose, balance, build_index, correct_line, post_entry, value
from app.domain.measures import MEASURE_SEED, portfolio
from app.domain.seed import FACTORS, PLANT, build_seed
from app.domain.synth import PLANTED, TRUE_A, TRUE_B, synth_history
from app.domain.validation import ValidationContext, dq_score, run_validation

seed = build_seed()
h = synth_history()
M = h["months"]


def ctx(entries=None):
    return ValidationContext(seed["registers"], build_index(entries or seed["entries"]), seed["plantMonths"], seed["billMonths"], PLANT["contractDemandKva"])


def hits(rule, reg=None):
    return sorted(i.month for i in run_validation(ctx()) if i.rule == rule and (not reg or i.registerId == reg))


def test_golden_seed_matches_reference_exactly():
    g = json.loads((Path(__file__).parents[1] / "golden" / "seed_golden.json").read_text(encoding="utf-8"))
    assert [[e.id, e.registerId, e.month, e.line, e.qty, e.docRef] for e in seed["entries"]] == g["entries"]
    assert [[i.id, i.message, i.messageHi, i.expected, i.actual] for i in run_validation(ctx())] == g["issues"]


def test_T1_import_24_plant_months():
    idx = build_index(seed["entries"])
    assert len(seed["plantMonths"]) == 24
    assert sum(value(idx, "PROD", m, "reading") or 0 for m in M) == sum(h["truth"]["units"])


def test_T2_V01_extra_zero_steel_and_bill():
    assert hits("V01") == sorted([M[PLANTED["hrSheetExtraZero"]], M[PLANTED["billExtraZero"]]])


def test_T2_V02_missing_digit():
    assert hits("V02") == [M[PLANTED["hrSheetMissingDigit"]]]


def test_T2_V03_flat_lined():
    assert sorted(i.registerId for i in run_validation(ctx()) if i.rule == "V03") == ["CHEM_COND", "CHEM_DW", "CHEM_GTX", "CHEM_HNO3", "WATER_SUPPLY"]


def test_T2_V04_pf_missing():
    assert hits("V04", "PF") == [M[PLANTED["pfMissing"]]]


def test_T2_V05_hydraulic_oil():
    assert hits("V05", "HYD_OIL") == sorted(M[i] for i in [*PLANTED["hydClosingWrong"], PLANTED["hydOverIssue"]])


def test_T2_V07_bill_arithmetic():
    assert hits("V07") == [M[PLANTED["billExtraZero"]]]


def test_T2_V09_intensity_outlier():
    assert hits("V09") == [M[PLANTED["lowOutputMonth"]]]


def test_T2_V12_negative_stock():
    assert hits("V12", "HYD_OIL") == [M[PLANTED["hydOverIssue"]]]


def test_T2_V06_contract_demand():
    assert hits("V06") == [m for i, m in enumerate(M) if (h["rows"][i]["max_demand_kva"] or 0) > PLANT["contractDemandKva"]]


def test_T3_gas_registers_balance():
    idx = build_index(seed["entries"])
    lines = 0
    for reg in ("OXYGEN", "CO2_GAS", "LPG", "ARGON"):
        for m in M:
            b = balance(idx, reg, m)
            if b["calc"] is not None:
                lines += 1
                assert b["ok"]
    assert lines == 96


def test_T4_emissions_equal_activity_times_factor():
    idx = build_index(seed["entries"])
    t = period_totals([month_emissions(seed["registers"], idx, FACTORS, m) for m in M])
    kwh = sum(h["truth"]["kwh"])
    diesel = sum(r["diesel_l"] for r in h["rows"])
    lpg = sum(l["issued"] for l in h["full"]["LPG"])
    co2 = sum(l["issued"] for l in h["full"]["CO2_GAS"])
    expected = (kwh * 0.71 + diesel * 2.68 + lpg * 2.98 + co2) / 1000
    assert abs(t["total"] / 1000 - expected) < 0.1
    assert t["intensity"] == pytest.approx((expected * 1000) / t["output"], rel=1e-6)


def test_T5_tariff_after_correcting_planted_bill():
    i = PLANTED["billExtraZero"]
    entries, _ = correct_line(seed["entries"], "BILL_INR", M[i], "reading", h["truth"]["bill"][i], "Extra zero typed", "test")
    truth = sum(h["truth"]["bill"]) / sum(h["truth"]["kwh"])
    assert effective_tariff(build_index(entries), M) == pytest.approx(truth, rel=1e-6)
    assert effective_tariff(build_index(seed["entries"]), M) > truth * 1.3


def test_T6_base_load_fit_recovers_generator():
    bl = base_load(build_index(seed["entries"]), M)
    assert abs(bl["a"] - TRUE_A) / TRUE_A < 0.08
    assert abs(bl["b"] - TRUE_B) / TRUE_B < 0.15
    assert bl["r2"] > 0.5


def test_T7_measures_arithmetic():
    p = portfolio(MEASURE_SEED, 7.5, 0.71)
    kwh = sum(m["kwhPerYr"] for m in MEASURE_SEED)
    extra = sum(m["extraInrPerYr"] for m in MEASURE_SEED)
    assert p["savingInr"] == pytest.approx(kwh * 7.5 + extra)
    assert p["co2t"] == pytest.approx(sum(m["kwhPerYr"] for m in MEASURE_SEED if m["co2Counted"]) * 0.71 / 1000)
    assert p["payback"] == pytest.approx(p["capex"] / p["savingInr"])


def test_T8_correction_is_reversal_plus_new_entry():
    m = M[0]
    before = month_emissions(seed["registers"], build_index(seed["entries"]), FACTORS, m)
    orig = next(e for e in seed["entries"] if e.registerId == "DIESEL" and e.month == m)
    entries, created = correct_line(seed["entries"], "DIESEL", m, "issued", 2000, "Re-counted from slips", "custodian")
    assert len(created) == 2
    assert created[0].qty == -orig.qty and created[0].reversesId == orig.id
    assert next(e for e in entries if e.id == orig.id).status == "reversed"
    after = month_emissions(seed["registers"], build_index(entries), FACTORS, m)
    assert before["total"] - after["total"] == pytest.approx((orig.qty - 2000) * 2.68, abs=1e-3)


def test_T8_rejects_correction_without_reason():
    with pytest.raises(ValueError):
        correct_line(seed["entries"], "DIESEL", M[0], "issued", 1, " ", "x")


def test_T9_reopen_lowers_dq_by_10():
    issues = run_validation(ctx())
    base = dq_score(M[20], issues, {}, None, False)
    reopened = dq_score(M[20], issues, {}, MonthClose(month=M[20], status="reopened", reopenedCount=1), False)
    assert base - reopened == 10


def test_T11_offline_sync_posts_exactly_once():
    entries = list(seed["entries"])
    queue = [LedgerEntry(id=f"q{i}", registerId="DIESEL", month="2026-11", line="issued", qty=10, idempotencyKey=f"k{i}") for i in range(10)]
    for p in (1, 2):
        for q in queue:
            entries, _ = post_entry(entries, LedgerEntry(**{**q.__dict__, "id": f"{q.id}_{p}"}))
    assert len(entries) - len(seed["entries"]) == 10
