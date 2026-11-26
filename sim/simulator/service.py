"""Simulator service: runs the plant clock and serves the demo-control API for the separate control panel.
Run: python -m simulator.service   (control API on :5175, control panel web app on :5174)."""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .engine import DEVICES, SimEngine
from .feeds import ClusterMeters, FmcgLine
from .transport import Api, HttpTransport, LiveTransport, iso

log = logging.getLogger("sim")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "sim" / "state" / "sim.json"
START = int(dt.datetime(2026, 11, 10, 5, 50, tzinfo=dt.timezone.utc).timestamp() * 1000)  # plant-local 10 Nov 05:50
INITIAL_STOCK = {"CO2_GAS": 900, "LPG": 200, "HYD_OIL": 600, "OXYGEN": 50, "ARGON": 4000}


def env(k: str, d: str) -> str:
    v = os.environ.get(k)
    if v:
        return v
    for f in (ROOT / ".env", ROOT / "infra" / ".env"):
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith(f"{k}="):
                    return line.split("=", 1)[1].strip()
    return d


class Sim:
    def __init__(self):
        keys = dict(p.split(":", 1) for p in env("DEVICE_KEYS", "sim-vbw:dev-key-vbw,sim-afl:dev-key-afl,sim-cluster:dev-key-cluster,sim-market:dev-key-market").split(","))
        self.api = Api(env("API_URL", "http://localhost:8000"), keys)
        if env("MQTT_ENABLED", "true").lower() in ("false", "0", "no"):
            log.info("MQTT disabled: sending meter frames to the API over HTTP")
            self.tr = HttpTransport(self.api)
        else:
            self.tr = LiveTransport(self.api, env("MQTT_HOST", "localhost"), int(env("MQTT_PORT", "1883")))
        self.tr.on_replan = lambda: self.e.replan()
        self.lock = threading.RLock()
        self.heat_tripped = False
        self.spike_until = 0
        self.dr_until = 0
        self.ems_enabled = True
        self.carbon_price = 1500
        self.live: dict = {}
        self._build()

    def _build(self, fresh: bool = False):
        st = None if fresh or not STATE.exists() else json.loads(STATE.read_text(encoding="utf-8"))
        if st:
            self.e = SimEngine(st["clock"], self.tr, stock=st["stock"], warm_wip=False)
            self._restore(st)
            self.fmcg = FmcgLine(self.api, st.get("fmcgNext", 0), set(st.get("fmcgTests", [])))
            self.fmcg.resume(self.e.clock)
            self.cl = ClusterMeters(self.api, st.get("clusterLast"))
            self.cl.joined = st.get("joined", False)
            self.e.note("info", "Simulator resumed from the saved clock.")
        else:
            self.e = SimEngine(START, self.tr, stock=dict(INITIAL_STOCK))
            self.fmcg = FmcgLine(self.api)
            self.cl = ClusterMeters(self.api)
            self.warm = True
        self.tr.on_replan = lambda: self.e.replan()

    def warm_up(self):
        """First run: replay the previous 24 h through the real interfaces so every chart opens full."""
        log.info("Warm-up: replaying 24 h of plant data through MQTT/REST …")
        t0 = time.time()
        for i in range(24 * 60):
            self._step()
        self.e.note("info", "Live view opened. The previous 24 hours ran in the simulator so every chart starts full. Shift A begins at 06:00.")
        self.save()
        log.info("Warm-up done in %.0fs", time.time() - t0)

    def _step(self):
        self.e.step()
        c = self.e.clock
        self.fmcg.step(c)
        self.cl.step(c, self.e.cloud > 0, c < self.spike_until)

    # ---------- persistence ----------
    def save(self):
        e = self.e
        st = {"clock": e.clock, "speed": e.speed, "stock": e.stock, "tokens": [vars(t) for t in e.tokens], "tokenSeq": e.token_seq, "seq": e.seq, "rng": e.r.a, "solarRng": e.solar_r.a,
              "soc": e.site.soc, "flex": e.flex_queue, "co2": e.co2_pending, "lpg": e.lpg_pending, "hrShift": e.hr_shift, "online": e.online, "queues": e.queues,
              "fmcgNext": self.fmcg.next_idx, "fmcgTests": sorted(self.fmcg.done_tests)[-400:], "clusterLast": self.cl.last, "joined": self.cl.joined, "log": e.log[:40]}
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(st), encoding="utf-8")

    def _restore(self, st: dict):
        from .engine import Token
        e = self.e
        e.speed = st.get("speed", 5)
        e.tokens = [Token(**t) for t in st["tokens"]]
        e.token_seq, e.seq = st["tokenSeq"], st["seq"]
        e.r.a, e.solar_r.a = st["rng"], st["solarRng"]
        e.site.soc, e.flex_queue, e.co2_pending, e.lpg_pending, e.hr_shift = st["soc"], st["flex"], st["co2"], st["lpg"], st["hrShift"]
        e.online, e.queues = st["online"], {k: [tuple(x) for x in v] for k, v in st["queues"].items()}
        e.log = st.get("log", [])

    # ---------- loop ----------
    def run(self):
        if getattr(self, "warm", False):
            self.warm = False
            self.warm_up()
        last = time.monotonic()
        last_save = last
        last_live = 0.0
        while True:
            time.sleep(0.1)
            now = time.monotonic()
            with self.lock:
                if self.e.running:
                    self.e.acc += ((now - last)) * self.e.speed
                    n = min(int(self.e.acc), 120)
                    self.e.acc -= int(self.e.acc)
                    for _ in range(n):
                        self._step()
                last = now
                if self.api.retry:
                    self.api.flush()
            if now - last_save > 5:
                last_save = now
                with self.lock:
                    self.save()
            if now - last_live > 2:
                last_live = now
                try:
                    r = self.api.c.get(f"{self.api.base}/api/v1/live/state", headers={"X-Device-Key": self.api.keys["sim-vbw"]}, timeout=3)
                    if r.status_code == 200:
                        s = r.json()
                        self.live = {"held": len(s["quarantine"]), "rtm": (s["ems"]["current"] or {}).get("rtm", 0), "stress": (s["ems"]["current"] or {}).get("stress", 0),
                                     "enabled": s["ems"]["settings"]["enabled"], "carbonPrice": s["ems"]["settings"]["carbonPrice"], "packets": s["totals"]["packets"]}
                except Exception:
                    pass

    # ---------- commands from the control panel ----------
    def command(self, name: str, v=None, d: str | None = None) -> dict:
        with self.lock:
            e = self.e
            c = e.clock
            if name == "run":
                e.running = bool(v)
            elif name == "speed":
                e.speed = int(v)
            elif name == "nextShift":
                h = e.hour
                nxt = 6 if h < 6 else 14 if h < 14 else 22 if h < 22 else 30
                for _ in range((nxt - h) * 60 - e.minute):
                    self._step()
            elif name == "online":
                e.set_online(d, bool(v))
            elif name == "inject":
                if v in ("priceSpike", "gridStress"):
                    kind = "priceSpike" if v == "priceSpike" else "drCall"
                    mins = 30 if v == "priceSpike" else 45
                    if v == "priceSpike":
                        self.spike_until = c + mins * 60_000
                    else:
                        self.dr_until = c + mins * 60_000
                    self.api.call("POST", "/api/v1/energy/market/events", "sim-market", {"kind": kind, "ts": iso(c), "minutes": mins}, queue_on_fail=False)
                elif v == "cloud":
                    e.inject("cloud")
                    self.api.call("POST", "/api/v1/energy/market/events", "sim-market", {"kind": "cloud", "ts": iso(c), "value": e.cloud}, queue_on_fail=False)
                else:
                    e.inject(v)
            elif name == "ems":
                self.api.call("PUT", "/api/v1/energy/settings", "sim-vbw", v, queue_on_fail=False)
            elif name == "recall":
                self.api.call("POST", "/api/v1/fmcg/recall", "sim-afl", {"lot": "auto-spice", "reason": "Supplier (Spice Route Blends) reported a contaminated seasoning lot"}, queue_on_fail=False)
            elif name == "cluster":
                if v == "heatTrip":
                    self.heat_tripped = not self.heat_tripped
                    self.cl.event("heatTrip" if self.heat_tripped else "heatRestore", c)
                else:
                    self.cl.event(v, c)
            elif name == "scenario":
                e.scenario(v)
            elif name == "reset":
                self.api.call("POST", "/api/v1/ops/reset-demo", "sim-market", {}, queue_on_fail=False)
                if STATE.exists():
                    STATE.unlink()
                self._build(fresh=True)
                self.heat_tripped = False
                self.warm = False
                threading.Thread(target=self._warm_locked, daemon=True).start()
            return self.state()

    def _warm_locked(self):
        with self.lock:
            self.warm_up()

    def state(self) -> dict:
        e = self.e
        return {"connected": self.api.errors == 0 or not self.api.retry, "clock": e.clock, "running": e.running, "speed": e.speed, "kw": e.last.get("kw", 0), "kva": e.last.get("kva", 0),
                "contract": e.contract_kva, "held": self.live.get("held", 0), "online": e.online, "queued": {k: len(v) for k, v in e.queues.items()},
                "devices": DEVICES, "ems": {"rtm": self.live.get("rtm", 0), "stress": self.live.get("stress", 0), "soc": e.site.soc, "enabled": self.live.get("enabled", True),
                                           "carbonPrice": self.live.get("carbonPrice", 1500), "cloud": e.cloud > 0, "leak": e.leak_until > e.clock, "stressEvent": self.dr_until > e.clock},
                "surge": e.surge_until > e.clock, "powerCut": e.power_cut_until > e.clock, "cluster": {"overdraw": self.cl.overdraw_until > e.clock, "joined": self.cl.joined, "heatTrip": self.heat_tripped},
                "log": e.log[:30], "apiQueue": len(self.api.retry)}


sim: Sim | None = None
app = FastAPI(title="CarbonKhata simulator: field devices & demo controls", docs_url="/sim/docs", openapi_url="/sim/openapi.json", redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Cmd(BaseModel):
    name: str
    v: object | None = None
    d: str | None = None


@app.get("/sim/state")
def get_state():
    return sim.state()


@app.post("/sim/cmd")
def post_cmd(c: Cmd):
    return sim.command(c.name, c.v, c.d)


# ---------------- field devices: one API (and one web page) per sensor ----------------
from .devices import BY_ID, SENSORS  # noqa: E402


def _dev(d: tuple, hist: int = 0) -> dict:
    e = sim.e
    sid, label, unit, kind, overridable, desc = d
    o = e.overrides.get(sid)
    out = {"id": sid, "label": label, "unit": unit, "kind": kind, "overridable": overridable, "description": desc, "value": e.readings.get(sid),
           "online": sid not in e.sensor_offline and e.online["meters"], "override": o, "clock": e.clock,
           "topic": f"plant/vbw/{'sensor' if kind == 'carbon' else 'meter' if sid in ('incomer', 'comp', 'weld', 'paint', 'light', 'util') else 'asset'}/{sid}"}
    if hist:
        out["history"] = e.history.get(sid, [])[-hist:]
    return out


@app.get("/sim/devices")
def list_devices():
    with sim.lock:
        return [_dev(d) for d in SENSORS]


@app.get("/sim/devices/{sid}")
def get_device(sid: str, points: int = 120):
    if sid not in BY_ID:
        raise HTTPException(404, "Unknown device")
    with sim.lock:
        return _dev(BY_ID[sid], points)


class OverrideIn(BaseModel):
    mode: str = "fixed"          # fixed | offset | auto
    value: float | None = None
    minutes: int | None = None   # None = until set back to automatic


@app.post("/sim/devices/{sid}/override")
def override_device(sid: str, body: OverrideIn):
    if sid not in BY_ID or not BY_ID[sid][4]:
        raise HTTPException(400, "This device's reading cannot be overridden")
    if body.mode not in ("fixed", "offset", "auto"):
        raise HTTPException(422, "mode must be fixed, offset or auto")
    with sim.lock:
        sim.e.set_override(sid, body.mode, body.value, body.minutes)
        return _dev(BY_ID[sid], 120)


class OnlineIn(BaseModel):
    online: bool


@app.post("/sim/devices/{sid}/online")
def device_online(sid: str, body: OnlineIn):
    if sid not in BY_ID:
        raise HTTPException(404, "Unknown device")
    with sim.lock:
        sim.e.set_sensor_online(sid, body.online)
        return _dev(BY_ID[sid], 120)


def main():
    global sim
    sim = Sim()
    threading.Thread(target=sim.run, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=int(env("SIM_CONTROL_PORT", "5175")), log_level="warning")


if __name__ == "__main__":
    main()
