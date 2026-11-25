"""Other simulated sources: Annapurna Foods' line MES + QC lab, the cluster members' meters and weighbridges,
and the market-data / DISCOM event feed. All post to the public API with device keys."""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # demo_data
from demo_data.cluster_gen import member_load, weighbridge  # noqa: E402
from demo_data.fmcg_gen import batch_record, slot_start  # noqa: E402

from .transport import Api  # noqa: E402

IST_MS = int(5.5 * 3_600_000)
MEMBERS_KW = [  # member load profiles (the members' own meters / forecasts)
    {"id": "vbw", "kw": 380, "shape": "day", "err": 0.07, "x": 110}, {"id": "fab2", "kw": 260, "shape": "day", "err": 0.09, "x": 110},
    {"id": "fab3", "kw": 310, "shape": "day", "err": 0.09, "x": 110}, {"id": "fdy", "kw": 1450, "shape": "flat", "err": 0.05, "x": 470},
    {"id": "frg", "kw": 920, "shape": "two", "err": 0.06, "x": 470}, {"id": "pnt", "kw": 240, "shape": "paint", "err": 0.1, "x": 650},
    {"id": "cem", "kw": 1800, "shape": "night", "err": 0.05, "x": 650}, {"id": "fm1", "kw": 520, "shape": "two", "err": 0.07, "x": 650},
    {"id": "fm2", "kw": 430, "shape": "two", "err": 0.08, "x": 290}, {"id": "etp", "kw": 140, "shape": "flat", "err": 0.04, "x": 470},
    {"id": "scr", "kw": 190, "shape": "day", "err": 0.1, "x": 290},
]
TOOL = {"id": "tool", "kw": 160, "shape": "day", "err": 0.1, "x": 290}


class FmcgLine:
    def __init__(self, api: Api, next_idx: int = 0, posted_tests: set | None = None):
        self.api = api
        self.next_idx = next_idx
        self.open: dict[int, dict] = {}
        self.done_tests = posted_tests or set()

    def step(self, clock_local: int):
        utc = clock_local - IST_MS
        while slot_start(self.next_idx) <= utc:
            rec = batch_record(self.next_idx)
            plan = {**rec, "tests": [{k: t[k] for k in ("stage", "name", "spec", "by", "at")} for t in rec["tests"]]}
            self.api.call("POST", "/api/v1/fmcg/batches", "sim-afl", plan)
            self.open[self.next_idx] = rec
            self.next_idx += 1
        for i, rec in list(self.open.items()):
            for t in rec["tests"]:
                key = f"{rec['code']}|{t['name']}"
                if t["at"] <= utc and key not in self.done_tests:
                    self.api.call("POST", f"/api/v1/fmcg/batches/{rec['code']}/tests", "sim-afl", {"name": t["name"], "value": t["value"], "ok": t["ok"], "at": t["at"], "by": t["by"]})
                    self.done_tests.add(key)
            if all(f"{rec['code']}|{t['name']}" in self.done_tests for t in rec["tests"]):
                self.open.pop(i)

    def resume(self, clock_local: int):
        """After a restart: re-open batches whose lab results may still be due."""
        utc = clock_local - IST_MS
        for i in range(max(0, self.next_idx - 8), self.next_idx):
            rec = batch_record(i)
            if any(t["at"] > utc for t in rec["tests"]):
                self.open[i] = rec


class ClusterMeters:
    def __init__(self, api: Api, last_block_key: str | None = None):
        self.api = api
        self.last = last_block_key
        self.overdraw_until = 0
        self.joined = False
        self.exchanges: list[dict] = []
        self.last_hour = None

    def step(self, clock: int, cloud: bool, spike: bool):
        day = clock // 86_400_000
        blk = (clock % 86_400_000) // (15 * 60_000)
        key = f"{day}-{blk}"
        if key != self.last:
            self.last = key
            t = day * 86_400_000 + blk * 15 * 60_000 + 7 * 60_000
            ms = MEMBERS_KW + ([TOOL] if self.joined else [])
            readings = {m["id"]: [member_load(m, t, False), member_load(m, t, True, self.overdraw_until)] for m in ms}
            date = (dt.date(1970, 1, 1) + dt.timedelta(days=day)).isoformat()
            self.api.call("POST", "/api/v1/cluster/feed/pool", "sim-cluster", {"date": date, "block": blk, "readings": readings, "cloud": cloud, "spike": spike, "ts": clock})
        hour = clock // 3_600_000
        if hour != self.last_hour:
            self.last_hour = hour
            if not self.exchanges or hour % 6 == 0:
                r = self.api.call("GET", "/api/v1/cluster/exchanges", "sim-cluster", queue_on_fail=False) or {}
                self.exchanges = [x for x in r.get("exchanges", []) if x["unit"] == "t"]
            if self.exchanges:
                x = self.exchanges[hour % len(self.exchanges)]
                sent, received = weighbridge(clock, x["qty"])
                self.api.call("POST", "/api/v1/cluster/feed/weighbridge", "sim-cluster", {"agreementId": x["id"], "sent": sent, "received": received, "ts": clock})

    def event(self, kind: str, clock: int):
        if kind == "overdraw":
            self.overdraw_until = clock + 120 * 60_000
        if kind == "join":
            self.joined = not self.joined
            kind = "join" if self.joined else "leave"
        if kind == "mismatch":
            self.api.call("POST", "/api/v1/cluster/feed/weighbridge", "sim-cluster", {"agreementId": "x-scrap", "sent": 1.24, "received": 1.09, "ts": clock})
            return
        self.api.call("POST", "/api/v1/cluster/feed/event", "sim-cluster", {"kind": kind, "ts": clock})
