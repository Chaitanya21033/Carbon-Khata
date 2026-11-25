"""Port of reference/src/sim/cluster.test.ts (3 tests): pool settlement on member meter data, paired exchange lines, scoreboard."""
import datetime as dt

from demo_data.cluster_gen import member_load
from app.domain import cluster as CL
from app.domain.grid import market_day

T = int(dt.datetime(2026, 11, 10, 20, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
DAY = 86_400_000


def day_rows(clock, overdraw_until=0):
    day0 = clock // DAY * DAY
    mk = market_day(clock // DAY)
    now_blk = (clock - day0) // (15 * 60_000)
    ms = [m for m in CL.MEMBERS if m["kw"] > 0 and not m.get("late")]
    rows = []
    for b in range(min(now_blk, 95) + 1):
        t = day0 + b * 15 * 60_000 + 7 * 60_000
        rows.append(CL.settle_block(b, {m["id"]: (member_load(m, t, False), member_load(m, t, True, overdraw_until)) for m in ms}, mk[b]))
    return rows


def test_pooled_deviation_and_charges_lower_than_members_alone():
    rows = day_rows(T)
    s = lambda k: sum(r[k] for r in rows)
    assert len(rows) == 81
    assert s("pooledDev") < s("indivDev") * 0.6
    assert s("pooledPen") < s("indivPen")
    assert s("pooledCost") < s("soloCost")


def test_paired_line_reconciles_and_weighbridge_mismatch_is_held():
    p = next(x for x in CL.PROPOSALS if x["id"] == "p-offcut")
    q = round(p["qty"] / 30, 2)
    assert CL.reconcile(q, q) == "reconciled"
    assert CL.reconcile(1.24, 1.09) == "mismatch"


def test_scoreboard_accrues_and_heat_trip_pauses_heat_only():
    def accrue(exchanges, months, paused):
        return sum(x["tco2PerMonth"] * months for x in exchanges if x["id"] not in paused)
    t0 = accrue(CL.BASE_EXCHANGES, (T - int(dt.datetime(2026, 4, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)) / (30.4 * DAY), set())
    assert t0 > 1000
    paused = {x["id"] for x in CL.BASE_EXCHANGES if x["kind"] == "heat"}
    assert paused == {"x-heat"}
    assert t0 + accrue(CL.BASE_EXCHANGES, 1 / (30.4 * 24), paused) > t0
