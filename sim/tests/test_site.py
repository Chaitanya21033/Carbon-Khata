"""Simulator-side checks: the site controller conserves energy and respects the import cap; the engine is deterministic."""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from simulator.engine import SimEngine  # noqa: E402
from simulator.site import Assets, SiteState, site_minute  # noqa: E402

SP = {"block": 0, "bess": -150, "genset": False, "export": False, "flexOn": True, "buy": "discom", "greenKw": 0, "shed": 0, "reason": "", "enabled": True, "reserveSoc": 0.2}


def test_site_minute_balances_and_caps_import():
    st = SiteState(soc=0.5)
    f = site_minute(st, Assets(), SP, 100, 360, 10, False)
    supply = f["solar"] + f["bessOut"] + f["genset"] + f["green"] + f["rtm"] + f["dam"] + f["discom"]
    assert abs(supply - (f["load"] + f["bessIn"] + f["export"] + f["curtail"])) < 1e-9
    assert f["discom"] <= 380 + 1e-9


class Null:
    def __init__(self): self.n = 0
    def request_plan(self, r): return None
    def telemetry(self, f): self.n += 1
    def post_entry(self, r, d): pass
    def production(self, e): pass
    def device_status(self, *a): pass


def test_engine_is_deterministic():
    t = int(dt.datetime(2026, 11, 11, 6, tzinfo=dt.timezone.utc).timestamp() * 1000)
    runs = []
    for _ in range(2):
        n = Null(); e = SimEngine(t, n, stock={"CO2_GAS": 900})
        for _ in range(300):
            e.step()
        runs.append((e.today["bodies"], round(e.last["kw"], 6), n.n))
    assert runs[0] == runs[1] and runs[0][2] == 300
