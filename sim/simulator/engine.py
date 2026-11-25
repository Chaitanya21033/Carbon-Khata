"""Plant simulator for the fictional Vardhan Body Works. Port of reference/src/sim/engine.ts.

It plays the *physical plant and its people*: sub-meters, the production line, store-keepers' phones and the
site controller that executes EMS setpoints. It talks to CarbonKhata only through a `Transport` – the same public
interfaces real devices use (MQTT meter frames, REST entries with idempotency keys, production events).
Product logic (validation, passports, EMS decisions, accounting) is NOT here; it lives in the API.

Clock values are milliseconds of plant-local time (IST wall clock written as if UTC), as in the reference.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Protocol

from .rng import rng
from .site import Assets, SiteState, site_minute

STATIONS = [
    {"id": "cut", "label": "Cutting", "mins": 45, "cap": 2},
    {"id": "weld", "label": "Welding & fab", "mins": 150, "cap": 4},
    {"id": "blast", "label": "Shot blast", "mins": 40, "cap": 2},
    {"id": "paint", "label": "Paint & oven", "mins": 110, "cap": 3},
    {"id": "qc", "label": "Inspection", "mins": 30, "cap": 2},
]
METERS = [("comp", "Compressor"), ("weld", "Welding bay"), ("paint", "Paint shop & oven"), ("light", "Lighting"), ("util", "Utilities & office")]
DEVICES = [
    {"id": "meters", "label": "Energy meters", "sub": "5 sub-meters, 1-min smart-meter feed"},
    {"id": "stores", "label": "Stores phone", "sub": "Gas, diesel, steel, oil"},
    {"id": "line", "label": "Line supervisor", "sub": "Bodies finished"},
    {"id": "paint", "label": "Paint-shop phone", "sub": "Paint, thinner, sludge"},
    {"id": "docs", "label": "Bills & invoices", "sub": "Photos, PDFs"},
    {"id": "grid", "label": "IEX feed & EMS", "sub": "Prices + dispatch, 15-min"},
]
DEVICE_LABEL = {d["id"]: d["label"] for d in DEVICES}
OEM_STEEL_NOTE = {"A": "OEM A", "B": "OEM B", "C": "OEM C"}
FULL = {"CO2_GAS", "LPG", "HYD_OIL", "OXYGEN", "ARGON"}
SPEEDS = (1, 5, 15, 60)


class Transport(Protocol):
    def request_plan(self, req: dict) -> dict: ...
    def telemetry(self, frame: dict) -> None: ...
    def post_entry(self, req: dict, device: str) -> None: ...
    def production(self, evt: dict) -> None: ...
    def device_status(self, device: str, online: bool, queued: int) -> None: ...


def month_of(clock: int) -> str:
    days = clock // 86_400_000
    import datetime as _dt
    d = _dt.date(1970, 1, 1) + _dt.timedelta(days=days)
    return f"{d.year}-{d.month:02d}"


def weekday_sun(clock: int) -> bool:
    # 1970-01-01 was a Thursday (getUTCDay 4)
    return ((clock // 86_400_000) + 4) % 7 == 0


@dataclass
class Token:
    id: int
    station: int
    left: float
    oem: str | None = None
    order: str | None = None
    steelKg: float | None = None


class SimEngine:
    def __init__(self, start: int, transport: Transport, contract_kva: float = 450, stock: dict | None = None, warm_wip: bool = True):
        self.clock = start
        self.t = transport
        self.running = True
        self.speed = 5
        self.contract_kva = contract_kva
        self.online = {d["id"]: True for d in DEVICES}
        self.queues: dict[str, list] = {d["id"]: [] for d in DEVICES}
        self.assets = Assets()
        self.site = SiteState()
        self.sp: dict = {"block": -1, "bess": 0, "genset": False, "export": False, "flexOn": False, "buy": "discom", "greenKw": 0, "shed": 0, "reason": "", "enabled": True, "reserveSoc": 0.2}
        self.plan_block = -1
        self.cloud = 0.0
        self.flex_queue = 0.0
        self.leak_until = 0
        self.surge_until = 0
        self.power_cut_until = 0
        self.power_cut_was_on = False
        self.dg_litres = 0.0
        self.pf = 0.945
        self.stock = dict(stock or {})
        self.tokens: list[Token] = []
        self.token_seq = 0
        self.seq = 0
        self.co2_pending = 0.0
        self.lpg_pending = 0.0
        self.hr_shift = 0
        self.schedule: list[tuple[int, Callable]] = []
        self.last_posted: dict | None = None
        self.r = rng(4242)
        self.solar_r = rng(777)
        self.acc = 0.0
        self.log: list[dict] = []
        self.today = {"bodies": 0}
        self.last = {"kw": 0.0, "kva": 0.0, "soc": self.site.soc}
        if warm_wip:
            for st, left in ((1, 40), (1, 110), (2, 20), (3, 60), (3, 95), (4, 10)):
                self.token_seq += 1
                self.tokens.append(Token(self.token_seq, st, left))
        self.note("info", "Simulator started. Shift A begins at 06:00.")

    # ---------- helpers ----------
    @property
    def hour(self): return (self.clock // 3_600_000) % 24
    @property
    def minute(self): return (self.clock // 60_000) % 60
    @property
    def sunday(self): return weekday_sun(self.clock)
    @property
    def month(self): return month_of(self.clock)
    @property
    def shift(self):
        h = self.hour
        return "A" if 6 <= h < 14 else "B" if 14 <= h < 22 else "C"
    @property
    def block(self): return self.hour * 4 + self.minute // 15

    def note(self, level: str, text: str):
        self.log.insert(0, {"t": self.clock, "level": level, "text": text})
        del self.log[150:]

    def _stamp(self) -> str:
        d = (self.clock // 86_400_000)
        import datetime as _dt
        day = (_dt.date(1970, 1, 1) + _dt.timedelta(days=d)).day
        return f"{day:02d}{self.hour:02d}{self.minute:02d}"

    def solar_kw(self) -> float:
        h = self.hour + self.minute / 60
        sun = max(0.0, math.sin((math.pi * (h - 6.2)) / 12.6))
        flicker = 1 - 0.06 * abs(self.solar_r.normal(1)) * sun
        return self.assets.solarKwp * 0.82 * sun * flicker * (1 - 0.75 * self.cloud)

    # ---------- time ----------
    def tick(self, real_ms: float):
        if not self.running:
            return 0
        self.acc += (real_ms / 1000) * self.speed
        n = min(int(self.acc), 120)
        self.acc -= int(self.acc)
        for _ in range(n):
            self.step()
        return n

    def step(self):
        self.clock += 60_000
        h, m = self.hour, self.minute
        due = [s for s in self.schedule if s[0] <= self.clock]
        if due:
            self.schedule = [s for s in self.schedule if s[0] > self.clock]
            for _, fn in due:
                fn()
        act = 1 if self.shift == "A" else 0.9 if self.shift == "B" else 0.08
        if (h == 12 and m < 30) or (h == 19 and m < 30):
            act *= 0.45
        if self.sunday:
            act = 0.04
        if self.shift != "C" and not self.sunday and self.clock > self.surge_until and self.r.next() < 1 / 260:
            self.surge_until = self.clock + 15 * 60_000
            self.note("info", "Paint oven heat-up and full welding bay: load rising.")
        surge = 1 if self.clock < self.surge_until else 0
        painting = any(t.station == 3 for t in self.tokens)
        n = self.r.normal
        cut = self.clock < self.power_cut_until
        comp = (60 if act > 0.3 else 38) + 8 * math.sin((2 * math.pi * m) / 12) + n(2) + (24 if self.clock < self.leak_until else 0)
        weld = 14 + 115 * act * (0.85 + 0.3 * self.r.next()) + surge * 80
        paint = (60 + n(4) if (painting and act > 0.3) else 7) + surge * 85
        light = 34 if (h < 6 or h >= 18) else 20
        util = 28 + n(2)
        if cut:
            crit = 0.45
            comp *= crit; weld = 0; paint = 0; light *= crit; util *= crit
        self.pf = min(0.99, max(0.9, self.pf + n(0.002) + (0.945 - self.pf) * 0.05))
        base_kw = max(0, comp) + max(0, weld) + max(0, paint) + light + util

        blk = self.block
        working = act > 0.3
        flex_gen = 32 if working else 0
        self.flex_queue += flex_gen / 60
        if self.plan_block != blk:
            solar_d = self.solar_kw()
            sp = self.t.request_plan({"ts": self.clock, "block": blk, "loadKw": base_kw + (self.assets.flexRunKw if self.flex_queue > 1 else 0), "flexPendingKwh": self.flex_queue,
                                      "working": working, "gridDown": cut, "solarKw": solar_d, "soc": self.site.soc})
            if sp:
                self.sp = sp
            self.plan_block = blk
        solar = self.solar_kw()
        f = site_minute(self.site, self.assets, self.sp, solar, base_kw, self.flex_queue, cut)
        self.flex_queue = max(0.0, self.flex_queue - f["flexRun"] / 60)
        dg = 0.0
        if cut:
            dg = f["shed"]
            self.dg_litres += dg / 60 / 3.2
        imp = f["green"] + f["rtm"] + f["dam"] + f["discom"]
        kva = imp / self.pf
        meters = {"comp": max(0, comp), "weld": max(0, weld), "paint": max(0, paint), "light": light, "util": util}
        self.last = {"kw": f["load"], "kva": kva, "soc": self.site.soc, "imp": imp, "solar": solar}
        if self.online["meters"]:
            self.t.telemetry({"ts": self.clock, "meters": meters, "flows": f, "baseKw": base_kw, "flexGenKw": flex_gen, "flexPendingKwh": self.flex_queue, "gridDown": cut,
                              "soc": self.site.soc, "pf": self.pf, "kva": kva, "dgKw": dg, "price": None})
        if not cut and self.power_cut_was_on:
            self.power_cut_was_on = False
            self._after_power_cut()
        if cut:
            self.power_cut_was_on = True
        self._step_line(act)
        if act > 0.3 and painting:
            self.lpg_pending += 0.06
        if self.lpg_pending >= 19:
            self.lpg_pending -= 19
            self.entry("stores", "LPG", "issued", 19, "LPG cylinder to paint oven")
        if self.co2_pending >= 30:
            self.co2_pending -= 30
            self.entry("stores", "CO2_GAS", "issued", 30, "CO₂ cylinder to welding bay")
        if not self.sunday:
            if h in (8, 16) and m == 5:
                self.entry("stores", "DIESEL", "issued", 40, "Diesel to forklift")
            if h == 10 and m == 20:
                self.entry("stores", "HYD_OIL", "issued", 30, "Hydraulic oil top-up, press brake")
            if h in (14, 22) and m == 0 and self.hr_shift > 0:
                self.entry("stores", "SCRAP_HR", "issued", math.floor(self.hr_shift * 0.032 + 0.5), "Shift scrap weighed")
                self.hr_shift = 0
            if h == 11 and m == 0:
                if self.stock.get("CO2_GAS", 0) < 600:
                    self.entry("stores", "CO2_GAS", "received", 1500, "CO₂ delivery: 50 cylinders")
                if self.stock.get("LPG", 0) < 80:
                    self.entry("stores", "LPG", "received", 380, "LPG delivery: 20 cylinders")
            if h == 17 and m == 40:
                self.entry("paint", "SLUDGE", "issued", 7 + self.r.int(0, 3), "Paint sludge drum to authorised vendor")
        if h == 0 and m == 0:
            self.today = {"bodies": 0}
        if m == 0 and h in (6, 14, 22):
            self.note("info", f"Shift {self.shift} started.")

    def _step_line(self, act: float):
        if act <= 0.3:
            return
        for t in self.tokens:
            t.left -= act
        for s in range(len(STATIONS) - 1, -1, -1):
            for t in [x for x in self.tokens if x.station == s and x.left <= 0]:
                if s == len(STATIONS) - 1:
                    self.tokens = [x for x in self.tokens if x is not t]
                    self.today["bodies"] += 1
                    self.entry("line", "PROD", "reading", 1, f"Body #{t.id} passed inspection")
                    self._prod({"kind": "finished", "serial": t.id})
                elif len([x for x in self.tokens if x.station == s + 1]) < STATIONS[s + 1]["cap"]:
                    t.station = s + 1
                    t.left = STATIONS[s + 1]["mins"] * (0.85 + 0.3 * self.r.next())
                    if s + 1 == 2:
                        self.co2_pending += 21
                    self._prod({"kind": "moved", "serial": t.id, "station": s + 1})
                    if s + 1 == 4:
                        self.entry("paint", "PAINT", "issued", 22, f"Paint for body #{t.id}")
                        if t.id % 2 == 0:
                            self.entry("paint", "THINNER", "issued", 18, "Thinner, 2 bodies")
        if len([x for x in self.tokens if x.station == 0]) < STATIONS[0]["cap"] and self.r.next() < 1 / 55:
            oem = ["A", "A", "B", "A", "C", "B", "A", "C", "A", "B"][self.token_seq % 10]
            steel = 3200 + self.r.int(-150, 150)
            self.token_seq += 1
            order = f"PO-{oem}-{4100 + self.token_seq // 4:04d}"
            t = Token(self.token_seq, 0, STATIONS[0]["mins"], oem, order, steel)
            self.tokens.append(t)
            self.hr_shift += 3200
            self._prod({"kind": "started", "serial": t.id, "oem": oem, "order": order, "steelKg": steel})
            self.entry("stores", "HR_SHEET", "issued", steel, f"Steel sheet for body #{t.id} ({OEM_STEEL_NOTE[oem]})")

    def _prod(self, evt: dict):
        evt["ts"] = self.clock
        if self.online["line"]:
            self.t.production(evt)
        else:
            self.queues["line"].append(("prod", evt))

    def _after_power_cut(self):
        litres = max(5, math.floor(self.dg_litres + 0.5))
        self.dg_litres = 0
        self.note("ok", "Grid power restored.")
        self.entry("stores", "DIESEL", "issued", litres, "Diesel burned by DG set during power cut")

    # ---------- entries ----------
    def entry(self, device: str, register_id: str, line: str, qty: float, label: str, force_doc: str | None = None, fresh_key: bool = False):
        self.seq += 1
        doc = force_doc or f"{register_id}-{self._stamp()}-{self.seq}"
        key = f"sim-{doc}" if not fresh_key else f"sim-{doc}-{self.seq}"
        req = {"registerId": register_id, "month": self.month, "line": line, "qty": qty, "docRef": doc, "by": DEVICE_LABEL[device], "source": "app", "idempotencyKey": key, "reason": label, "ts": self.clock}
        if not self.online[device]:
            self.queues[device].append(("entry", req))
            if len(self.queues[device]) == 1:
                self.note("warn", f"{DEVICE_LABEL[device]} is offline: entries are saved on the phone.")
            return
        self._commit(req, device)

    def _commit(self, req: dict, device: str):
        self.t.post_entry(req, device)
        self.last_posted = {**req, "device": device}
        reg = req["registerId"]
        if reg in FULL and not req.get("_injected"):
            self.stock[reg] = self.stock.get(reg, 0) + (req["qty"] if req["line"] == "received" else -req["qty"] if req["line"] == "issued" else 0)

    # ---------- controls (simulator only) ----------
    def set_online(self, device: str, v: bool):
        self.online[device] = v
        q = self.queues[device]
        if v and q:
            self.queues[device] = []
            self.note("ok", f"{DEVICE_LABEL[device]} back online: syncing {len(q)} saved entries (each posts once).")
            for kind, item in q:
                if kind == "entry":
                    self._commit(item, device)
                else:
                    self.t.production(item)
        elif not v:
            self.note("warn", f"{DEVICE_LABEL[device]} went offline.")
        self.t.device_status(device, v, len(self.queues[device]))

    def inject(self, kind: str):
        if kind == "typo":
            self.entry("stores", "HR_SHEET", "issued", 32000, "Steel sheet issue (typed 32000 for 3200)")
        elif kind == "negative":
            self.seq += 1
            doc = f"HYD_OIL-{self._stamp()}-{self.seq}"
            self._commit({"registerId": "HYD_OIL", "month": self.month, "line": "issued", "qty": round(self.stock.get("HYD_OIL", 0) + 150), "docRef": doc, "by": DEVICE_LABEL["stores"],
                          "source": "app", "idempotencyKey": f"sim-{doc}", "reason": "Hydraulic oil issue larger than stock", "ts": self.clock, "_injected": True}, "stores")
        elif kind == "duplicate":
            lp = self.last_posted
            if lp:
                self.entry(lp["device"], lp["registerId"], lp["line"], lp["qty"], "Same slip entered again", force_doc=lp["docRef"], fresh_key=True)
            else:
                doc = f"DIESEL-{self._stamp()}-X"
                self.entry("stores", "DIESEL", "issued", 40, "Diesel to forklift", force_doc=doc)
                self.entry("stores", "DIESEL", "issued", 40, "Same slip entered again", force_doc=doc, fresh_key=True)
        elif kind == "meterGlitch":
            self.t.telemetry({"ts": self.clock, "glitch": {"meter": "comp", "cumulativeKwh": -1}})
        elif kind == "surge":
            self.surge_until = self.clock + 20 * 60_000
            self.note("warn", "Peak load: oven heat-up while all welders run.")
        elif kind == "powerCut":
            self.power_cut_until = self.clock + 25 * 60_000
            self.note("warn", "Grid power cut. DG set started.")
        elif kind == "delivery":
            self.entry("stores", "CO2_GAS", "received", 1500, "CO₂ delivery: 50 cylinders")
        elif kind == "cloud":
            self.cloud = 0 if self.cloud > 0 else 0.8
            self.note("info", "Heavy cloud over the plant." if self.cloud else "Cloud cleared.")
        elif kind == "leak":
            self.leak_until = 0 if self.leak_until > self.clock else self.clock + 7 * 86_400_000
            self.note("info", "Compressed-air leak started (simulated)." if self.leak_until else "Air leak fixed.")

    def replan(self):
        self.plan_block = -1

    def scenario(self, name: str):
        def at(mins, fn):
            self.schedule.append((self.clock + mins * 60_000, fn))
        if name == "normal":
            for d in list(self.online):
                if not self.online[d]:
                    self.set_online(d, True)
            self.surge_until = 0
            self.power_cut_until = 0
        elif name == "errors":
            at(1, lambda: self.inject("typo")); at(10, lambda: self.inject("duplicate")); at(20, lambda: self.inject("negative")); at(30, lambda: self.inject("meterGlitch"))
        elif name == "peak":
            self.inject("surge"); at(50, lambda: self.inject("surge"))
        elif name == "outage":
            for d in ("stores", "line", "paint"):
                self.set_online(d, False)
            at(120, lambda: [self.set_online(d, True) for d in ("stores", "line", "paint")])
        self.note("info", f"Scenario: {name}.")

    def jump_to_next_shift(self):
        h = self.hour
        nxt = 6 if h < 6 else 14 if h < 14 else 22 if h < 22 else 30
        for _ in range((nxt - h) * 60 - self.minute):
            self.step()
