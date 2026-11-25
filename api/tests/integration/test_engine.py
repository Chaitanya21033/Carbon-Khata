"""Port of reference/src/sim/engine.test.ts (4 tests). Packet checks now run on the product side (live_checks)."""
import datetime as dt

from .harness import Harness

START = int(dt.datetime(2026, 11, 11, 6, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
STOCK = {"CO2_GAS": 900, "LPG": 200, "HYD_OIL": 600, "OXYGEN": 50, "ARGON": 4000}


def test_working_day_produces_bodies_energy_and_clean_entries():
    h = Harness(START, STOCK).run(17 * 60)
    assert h.e.today["bodies"] > 8
    assert h.twin.today["kwh"] > 3000
    assert len([p for p in h.posted if p["registerId"] == "PROD"]) == h.e.today["bodies"]
    meter = sum(p["qty"] for p in h.posted if p["registerId"] == "GRID_KWH")
    k = h.twin.ems.today["kwh"]
    assert abs(meter - (k["discom"] + k["rtm"] + k["dam"])) < 400
    assert h.held == []


def test_holds_typo_negative_issue_and_duplicate_slip():
    h = Harness(START, STOCK).run(1)
    h.e.inject("typo"); h.e.inject("negative"); h.e.inject("duplicate")
    assert sorted(x["rule"] for x in h.held) == ["V01", "V10", "V12"]
    assert not any(p["qty"] == 32000 for p in h.posted)
    h.resolve("V01", "fix")
    assert h.posted[-1]["qty"] == 3200


def test_offline_device_queues_and_posts_each_once_on_reconnect():
    h = Harness(START, STOCK)
    for d in ("stores", "line", "paint"):
        h.e.set_online(d, False)
    h.run(240)
    queued = sum(len([q for q in h.e.queues[d] if q[0] == "entry"]) for d in ("stores", "line", "paint"))
    assert queued > 3
    before = len([p for p in h.posted if p["source"] == "app"])
    for d in ("stores", "line", "paint", "stores"):
        h.e.set_online(d, True)
    assert len([p for p in h.posted if p["source"] == "app"]) - before == queued
    keys = [p["idempotencyKey"] for p in h.posted]
    assert len(set(keys)) == len(keys)


def test_peak_load_raises_demand():
    h = Harness(START, STOCK).run(180)
    h.e.inject("surge")
    h.run(20)
    assert h.twin.today["peakKva"] > 300
