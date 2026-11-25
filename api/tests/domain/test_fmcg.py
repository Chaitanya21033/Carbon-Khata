"""Port of reference/src/domain/__tests__/fmcg.test.ts (5 tests): batches from the line MES generator, evaluated by the API logic."""
import datetime as dt

from demo_data.fmcg_gen import batch_record, batches_until
from app.domain.fmcg import batch_fingerprint, evaluate, lot_index

CLOCK = int(dt.datetime(2026, 11, 12, 12, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)


def build(clock, flagged=frozenset(), overrides=None):
    return [evaluate(r, clock, set(flagged), overrides or {}, 0.6, 0.3) for r in batches_until(clock)]


ALL = build(CLOCK)


def test_batches_have_lots_tests_and_carbon():
    assert len(ALL) > 20
    for b in ALL:
        assert len(b["lots"]) > 2 and b["carbon"]["perPackG"] > 0


def test_release_gate_failed_test_holds_and_blocks_dispatch():
    held = [b for b in ALL if b["status"] == "held"]
    assert held
    for b in held:
        assert any(t["status"] == "fail" for t in b["tests"]) and b["dispatch"] == []


def test_mass_balance_output_never_exceeds_input():
    for b in ALL:
        assert b["outputKg"] < sum(l["kg"] for l in b["lots"] if l["material"] != "film") + 0.5


def test_recall_finds_exactly_the_batches_that_used_the_lot():
    lot = next(l for l in lot_index(ALL) if l["material"] == "spice")
    after = build(CLOCK, {lot["lot"]})
    users = {b["id"] for b in ALL if b["id"] in lot["batches"] and b["status"] != "in_production"}
    assert {b["id"] for b in after if b["status"] == "recalled"} == users


def test_fingerprint_changes_if_a_result_is_edited():
    r = batch_record(3)
    a = evaluate(r, CLOCK, set(), {}, 0.6, 0.3)
    b = evaluate(r, CLOCK, set(), {f"{a['id']}|Product moisture": "fail"}, 0.6, 0.3)
    assert batch_fingerprint(a) != batch_fingerprint(b)
