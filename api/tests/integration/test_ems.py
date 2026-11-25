"""Port of reference/src/sim/ems.test.ts (7 tests) + the brief's acceptance numbers for the seeded day."""
import datetime as dt

import pytest

from app.domain.grid import market_day
from .harness import Harness

DAY0 = int(dt.datetime(2026, 11, 11, tzinfo=dt.timezone.utc).timestamp() * 1000)  # plant-local 11 Nov 00:00
STOCK = {"CO2_GAS": 9000, "LPG": 2000, "HYD_OIL": 6000, "OXYGEN": 50, "ARGON": 4000}


def run(enabled, mins=24 * 60 - 1):
    return Harness(DAY0, STOCK, enabled).run(mins)


ON, OFF = run(True), run(False)


def test_market_feed_has_duck_shape():
    d = market_day(20403)
    assert len(d) == 96
    avg = lambda a, b: sum(x["rtm"] for x in d[a * 4:b * 4]) / ((b - a) * 4)
    assert avg(11, 15) < avg(18, 22) - 4
    assert d[13 * 4]["netDemandGW"] < d[19 * 4]["netDemandGW"] - 10


def test_costs_less_than_naive_twin():
    on, off = ON.twin.ems, OFF.twin.ems
    assert on.today["costInr"] < on.naive["costInr"] * 0.9
    assert abs(off.today["costInr"] - off.naive["costInr"]) / off.naive["costInr"] < 0.08


def test_takes_energy_off_the_evening_peak_and_exports():
    e = ON.twin.ems
    assert e.today["peakEveningImportKwh"] < e.naive["peakEveningKwh"] * 0.6
    assert e.today["exportKwh"] > 0


def test_energy_balances_every_minute():
    f = ON.twin.ems.flows
    supply = f["solar"] + f["bessOut"] + f["genset"] + f["green"] + f["rtm"] + f["dam"] + f["discom"]
    assert abs(supply - (f["load"] + f["bessIn"] + f["export"] + f["curtail"])) < 1e-6


def test_posts_solar_import_and_production_to_ledger():
    regs = {p["registerId"] for p in ON.posted}
    assert {"GRID_KWH", "SOLAR_KWH", "PROD"} <= regs


def test_one_passport_per_finished_body_routed_to_its_oem():
    assert len(ON.twin.passports) == len([p for p in ON.posted if p["registerId"] == "PROD"])
    p = ON.twin.passports[0]
    assert p["total"] == pytest.approx(p["s1"] + p["s2"] + p["steel"], rel=1e-9)
    assert p["oem"] in ("A", "B", "C")


def test_rides_through_grid_outage():
    h = Harness(DAY0, STOCK).run(13 * 60)
    h.e.inject("powerCut")
    h.run(20)
    assert h.twin.ems.island_min > 10
    assert h.e.site.gen_on


def test_seeded_day_matches_reference_numbers():
    """Brief §10: ≈19 % cheaper than the naive twin, evening import ≈ −66 %, peak ≤ 380 kW."""
    e = ON.twin.ems
    saving = (1 - e.today["costInr"] / e.naive["costInr"]) * 100
    eve = (e.today["peakEveningImportKwh"] / e.naive["peakEveningKwh"] - 1) * 100
    assert saving == pytest.approx(19.2, abs=0.1)
    assert eve == pytest.approx(-66.2, abs=0.1)
    assert e.today["peakKw"] <= 380 + 1e-6
