"""Live plant twin: the product-side view of a plant, built only from what devices send.

Inputs (public interfaces): 1-minute smart-meter frames, EMS plan requests from the site controller, production
events from the line, and ledger results from the ingestion service. Outputs: EMS setpoints, hourly meter
roll-ups posted to the ledger, carbon passports, live alerts, data-flow packets and a JSON snapshot for the UI.
Port of the product half of reference/src/sim/engine.ts (attribution, passports, roll-ups, alerts, logs).
"""
from __future__ import annotations

import datetime as dt
from typing import Callable, Optional

from ..domain.grid import CEA_EF, DAY_MS, GENSET_EF, SOURCES, EmsBrain, utc_hour, utc_minute
from ..domain.util import fmt, js_round, to_fixed_str

STATIONS = [
    {"id": "cut", "label": "Cutting", "mins": 45, "cap": 2},
    {"id": "weld", "label": "Welding & fab", "mins": 150, "cap": 4},
    {"id": "blast", "label": "Shot blast", "mins": 40, "cap": 2},
    {"id": "paint", "label": "Paint & oven", "mins": 110, "cap": 3},
    {"id": "qc", "label": "Inspection", "mins": 30, "cap": 2},
]
METERS = [{"id": "comp", "label": "Compressor"}, {"id": "weld", "label": "Welding bay"}, {"id": "paint", "label": "Paint shop & oven"}, {"id": "light", "label": "Lighting"}, {"id": "util", "label": "Utilities & office"}]
DEVICES = [
    {"id": "meters", "label": "Energy meters", "sub": "5 sub-meters, 1-min smart-meter feed"},
    {"id": "stores", "label": "Stores phone", "sub": "Gas, diesel, steel, oil"},
    {"id": "line", "label": "Line supervisor", "sub": "Bodies finished"},
    {"id": "paint", "label": "Paint-shop phone", "sub": "Paint, thinner, sludge"},
    {"id": "docs", "label": "Bills & invoices", "sub": "Photos, PDFs"},
    {"id": "grid", "label": "IEX feed & EMS", "sub": "Prices + dispatch, 15-min"},
]
DEVICE_BY_LABEL = {d["label"]: d["id"] for d in DEVICES}
OEMS = {
    "A": {"name": "OEM A", "sub": "Commercial vehicles (domestic)", "steelEf": 2.3, "steelNote": "BF-BOF steel, India average"},
    "B": {"name": "OEM B", "sub": "Construction equipment", "steelEf": 2.3, "steelNote": "BF-BOF steel, India average"},
    "C": {"name": "OEM C", "sub": "Export to EU (CBAM)", "steelEf": 1.55, "steelNote": "Mill-certified lower-carbon steel"},
}
EF = {"grid": 0.71, "diesel": 2.68, "lpg": 2.98, "co2": 1.0}
CO2_PER_BODY_KG = 21          # shielding gas issued when a body leaves welding (scope 1, mass balance)
LPG_PER_BODY_KG = 2.2         # paint-oven LPG per body
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def device_for(register_id: str) -> str:
    if register_id == "PROD":
        return "line"
    if register_id in ("PAINT", "THINNER", "HARDENER", "SLUDGE"):
        return "paint"
    if register_id in ("GRID_KWH", "GRID_KVAH", "PF", "MD_KVA", "BILL_INR"):
        return "docs"
    if register_id in ("SOLAR_KWH", "GREEN_OA_KWH", "GRID_EXPORT_KWH", "GENSET_GAS_SCM"):
        return "grid"
    return "stores"


def plant_ms_to_iso(clock: int) -> str:
    """Plant-local ms → ISO-8601 with the +05:30 offset (what goes on the wire and in the DB)."""
    t = dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=clock)
    return t.replace(tzinfo=IST).isoformat()


def iso_to_plant_ms(s: str | int) -> int:
    if isinstance(s, (int, float)):
        return int(s)
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=IST)
    local = d.astimezone(IST).replace(tzinfo=None)
    return int((local - dt.datetime(1970, 1, 1)).total_seconds() * 1000)


def month_of(clock: int) -> str:
    d = dt.date(1970, 1, 1) + dt.timedelta(days=clock // DAY_MS)
    return f"{d.year}-{d.month:02d}"


class PlantTwin:
    def __init__(self, tenant_id: str, contract_kva: float = 450, oem_steel: Optional[dict] = None, grid_ef: float = CEA_EF,
                 post_ledger: Optional[Callable[[dict], None]] = None, emit: Optional[Callable[[str, dict], None]] = None,
                 on_passport: Optional[Callable[[dict], None]] = None, on_block: Optional[Callable[[dict], None]] = None,
                 on_meter_interval: Optional[Callable[[dict], None]] = None):
        self.tenant_id = tenant_id
        self.contract_kva = contract_kva
        self.grid_ef = grid_ef
        self.oems = {k: {**v, "steelEf": (oem_steel or {}).get(k, v["steelEf"])} for k, v in OEMS.items()}
        self.post_ledger = post_ledger or (lambda r: None)
        self._emit = emit or (lambda k, p: None)
        self.on_passport = on_passport or (lambda p: None)
        self.on_block_closed = on_block or (lambda r: None)
        self.on_meter_interval = on_meter_interval or (lambda r: None)
        self.ems = EmsBrain()
        self.clock = 0
        self.started = False
        self.online = {d["id"]: True for d in DEVICES}
        self.queued = {d["id"]: 0 for d in DEVICES}
        self.series: list[dict] = []
        self.events: list[dict] = []
        self.ev_seq = 0
        self.pseq = 0
        self.quarantine: list[dict] = []
        self.tokens: list[dict] = []
        self.passports: list[dict] = []
        self.oem_today = {"A": 0, "B": 0, "C": 0}
        self.machine_alerts: list[dict] = []
        self.last_leak_alert = 0
        self.today = {"bodies": 0, "kwh": 0.0, "diesel": 0.0, "lpg": 0.0, "co2": 0.0, "peakKva": 0.0, "packets": 0, "flagged": 0, "posted": 0}
        self.totals = {"packets": 0, "posted": 0, "flagged": 0}
        self.meter_kwh = {m["id"]: 0.0 for m in METERS}
        self.meter_cum = 4_812_300.0
        self.pf = 0.945
        self.flex_queue = 0.0
        self.last = {"t": 0, "comp": 0, "weld": 0, "paint": 0, "light": 0, "util": 0, "kva": 0, "dg": 0, "solar": 0, "bess": 0, "genset": 0, "imp": 0, "exp": 0, "price": 0}
        self.blk15 = {"kva": 0.0, "n": 0}
        self.interval = {m["id"]: 0.0 for m in METERS} | {"import": 0.0, "export": 0.0, "solar": 0.0, "kvah": 0.0}
        self.last_comp_cum = None
        self.rn = {"re": 0.0, "tot": 0.0}
        self.day_index = -1

    # ---------- helpers ----------
    @property
    def block(self) -> int:
        return utc_hour(self.clock) * 4 + utc_minute(self.clock) // 15

    def log(self, level: str, text: str):
        self.ev_seq += 1
        e = {"id": self.ev_seq, "t": self.clock, "level": level, "text": text}
        self.events.insert(0, e)
        del self.events[120:]
        self._emit("event", e)

    def packet(self, device: str, kind: str, label: str, **kw):
        self.pseq += 1
        p = {"id": f"p{self.pseq}", "t": self.clock, "device": device, "kind": kind, "label": label, **{k: v for k, v in kw.items() if v is not None}}
        self.totals["packets"] += 1
        self.today["packets"] += 1
        self._emit("packet", p)
        return p

    def working(self, clock: int) -> bool:
        """Plant shift calendar: shifts A and B (06:00–22:00), Monday to Saturday."""
        h = utc_hour(clock)
        sunday = ((clock // DAY_MS) + 4) % 7 == 0
        return (not sunday) and 6 <= h < 22

    # ---------- EMS ----------
    def request_plan(self, req: dict) -> dict:
        clock = int(req["ts"])
        self._advance_clock(clock)
        for n in self.ems.expire(clock):
            self.log("ok", n)
        block = int(req["block"])
        prev_block = self.ems.plan["block"]
        sp, closed = self.ems.on_block(clock, block, req["loadKw"], req["flexPendingKwh"], req.get("working", self.working(clock)), req["gridDown"], req["solarKw"], req["soc"])
        if closed:
            self.on_block_closed({**closed, "tenant": self.tenant_id})
            self._emit("ems.decision", self.ems.decisions[0])
        if prev_block != block:
            mb = self.ems.current(block)
            self.packet("grid", "market", f"IEX block {block + 1}: RTM ₹{to_fixed_str(mb['rtm'], 2)}")
            p = self.ems.plan
            if self.ems.settings.enabled and (p["export"] or p["genset"] or p["bess"] != 0 or p["shed"] > 0):
                self.log("flow", f"EMS {utc_hour(clock):02d}:{utc_minute(clock):02d}: {p['reason']}")
        return sp

    # ---------- telemetry ----------
    def _advance_clock(self, clock: int):
        if clock < self.clock:
            return
        d = clock // DAY_MS
        if self.day_index >= 0 and d != self.day_index:
            self._roll_day()
        self.day_index = d
        self.clock = clock
        self.ems.ensure_day(d)

    def telemetry(self, frame: dict):
        clock = int(frame["ts"])
        if "glitch" in frame:
            self._advance_clock(clock)
            self.flag_meter_glitch(frame["glitch"])
            return
        self._advance_clock(clock)
        for n in self.ems.expire(clock):
            self.log("ok", n)
        f = frame["flows"]
        meters = frame["meters"]
        grid_down = bool(frame.get("gridDown"))
        self.pf = frame.get("pf", self.pf)
        block = self.block
        self.ems.account(clock, block, f, frame["baseKw"], frame.get("flexGenKw", 0), grid_down, frame.get("soc"))
        self.flex_queue = frame.get("flexPendingKwh", 0)
        imp = f["green"] + f["rtm"] + f["dam"] + f["discom"]
        kva = frame.get("kva", imp / max(self.pf, 0.5))
        mb = self.ems.current(block)
        self.last = {"t": clock, **{k: meters.get(k, 0) for k in ("comp", "weld", "paint", "light", "util")}, "kva": kva, "dg": frame.get("dgKw", 0), "solar": f["solar"],
                     "bess": f["bessOut"] - f["bessIn"], "genset": f["genset"], "imp": imp, "exp": f["export"], "price": mb["rtm"]}
        self.series.append(self.last)
        del self.series[:-240]
        working = self.working(clock)
        self._attribute(f, imp, working)
        # machine health: compressor idle draw vs 38 kW benchmark
        comp = meters.get("comp", 0)
        if not working and comp > 50 and clock - self.last_leak_alert > 3 * 3_600_000:
            self.last_leak_alert = clock
            loss = comp - 38
            msg = f"Compressor idle draw {to_fixed_str(comp, 0)} kW vs 38 kW benchmark: likely air leak, ≈{to_fixed_str(loss, 0)} kW wasted (₹{fmt(js_round(loss * 24 * 6.5))}/day)."
            self.machine_alerts.insert(0, {"t": clock, "machine": "Compressor", "text": msg})
            del self.machine_alerts[20:]
            self.log("warn", msg)
        kw = f["load"]
        self.today["kwh"] += kw / 60
        self.meter_cum += imp / 60
        for m in METERS:
            self.meter_kwh[m["id"]] += meters.get(m["id"], 0) / 60
            self.interval[m["id"]] += meters.get(m["id"], 0) / 60
        self.interval["import"] += imp / 60
        self.interval["export"] += f["export"] / 60
        self.interval["solar"] += f["solar"] / 60
        self.interval["kvah"] += kva / 60
        self.blk15["kva"] += kva
        self.blk15["n"] += 1
        minute = utc_minute(clock)
        if minute % 15 == 0:
            avg = self.blk15["kva"] / max(1, self.blk15["n"])
            self.blk15 = {"kva": 0.0, "n": 0}
            self.today["peakKva"] = max(self.today["peakKva"], avg)
            if avg > self.contract_kva:
                self.log("warn", f"V06 demand alert: {to_fixed_str(avg, 0)} kVA in the last 15 min, above the {fmt(self.contract_kva)} kVA contract. Stagger the oven or compressor.")
            self.on_meter_interval({"ts": clock, "tenant": self.tenant_id, "values": dict(self.interval), "pf": self.pf, "kvaAvg": avg})
            self.interval = {k: 0.0 for k in self.interval}
            for i, mt in enumerate(METERS):
                self.packet("meters", "meter", f"{mt['label']} {to_fixed_str(self.last[mt['id']], 0)} kW", delay=i * 90)
        if minute == 0:
            hr = self.ems.take_hour()
            month = month_of(clock - 60_000)
            stamp = f"{(dt.date(1970, 1, 1) + dt.timedelta(days=clock // DAY_MS)).day:02d}{utc_hour(clock):02d}{minute:02d}"
            for reg, qty, label, dev in (("GRID_KWH", hr["grid"], "Hourly grid import", "meters"), ("SOLAR_KWH", hr["solar"], "Hourly solar", "grid"),
                                         ("GREEN_OA_KWH", hr["green"], "Hourly green open access", "grid"), ("GRID_EXPORT_KWH", hr["export"], "Hourly export", "grid"),
                                         ("GENSET_GAS_SCM", hr["gasScm"], "Hourly genset gas", "grid")):
                q = js_round(qty)
                if q > 0:
                    unit = "scm" if reg == "GENSET_GAS_SCM" else "kWh"
                    self.post_ledger({"registerId": reg, "month": month, "line": "reading", "qty": q, "docRef": f"{reg}-{stamp}", "by": "EMS gateway" if dev == "grid" else "Meter gateway",
                                      "source": "meter", "idempotencyKey": f"mtr-{reg}-{clock}", "_device": dev, "_kind": "rollup", "_label": f"{label} {fmt(q)} {unit}"})
        if utc_hour(clock) == 23 and minute == 0:
            self.packet("meters", "export", "Nightly OEM sync", target="out_oem")
            self.log("flow", "Nightly sync: today's summary sent to the OEM portal (consented fields only).")
        if utc_hour(clock) == 2 and minute == 0:
            self.log("info", "Nightly validation run: V01–V12 re-checked on full history.")
        if minute == 0 and utc_hour(clock) in (6, 14, 22):
            self.log("info", f"Shift {'A' if utc_hour(clock) == 6 else 'B' if utc_hour(clock) == 14 else 'C'} started.")
        if grid_down and not getattr(self, "_grid_was_down", False):
            self.log("warn", "Grid power cut detected at the incomer. Solar, battery and gas genset carrying critical load.")
        if not grid_down and getattr(self, "_grid_was_down", False):
            self.log("ok", "Grid power restored.")
        self._grid_was_down = grid_down

    def flag_meter_glitch(self, g: dict):
        item = {"id": f"q{self.pseq + 1}", "t": self.clock, "device": "meters", "registerId": "GRID_KWH", "line": "reading", "qty": 0, "rule": "V11",
                "reason": "Cumulative kWh went backwards (meter reset or misread). Reading held for review.", "docRef": f"MTR-GLITCH-{self.clock}", "month": month_of(self.clock), "kind": "meter"}
        self.quarantine.insert(0, item)
        self.today["flagged"] += 1
        self.totals["flagged"] += 1
        self.log("block", "V11 held: Compressor meter read lower than last reading.")
        self.packet("meters", "meter", "Compressor meter read lower than last reading", flagged={"rule": "V11", "reason": item["reason"]})
        return item

    # ---------- production & passports ----------
    def _attribute(self, f: dict, imp: float, working: bool):
        if not working or not self.tokens:
            return
        supply = max(1.0, f["load"])
        grid_share = min(1.0, (imp - f["green"]) / supply)
        gen_share = min(1.0, f["genset"] / supply)
        re_share = max(0.0, 1 - grid_share - gen_share)
        self.rn["re"] += re_share
        self.rn["tot"] += 1
        l = self.last

        def give(ts, kw):
            if not ts or kw <= 0:
                return
            each = kw / len(ts) / 60
            for t in ts:
                t["kwh"] += each
                t["s2"] += each * grid_share * self.grid_ef
                t["s1"] += each * gen_share * GENSET_EF
                t["re"] += each * re_share
        at = lambda s: [t for t in self.tokens if t["station"] == s]
        give(at(0), 18)
        give(at(1), l["weld"])
        give(at(2), f["flexRun"] * 0.6 + 20)
        give(at(3), l["paint"])
        give(self.tokens, l["comp"] + l["light"] + l["util"])

    def _token(self, serial: int) -> dict:
        t = next((x for x in self.tokens if x["id"] == serial), None)
        if t is None:
            t = {"id": serial, "station": 0, "left": 0, "oem": None, "order": None, "kwh": 0.0, "s1": 0.0, "s2": 0.0, "re": 0.0, "steel": None, "steelKg": None, "started": None}
            self.tokens.append(t)
        return t

    def production(self, evt: dict):
        clock = int(evt["ts"])
        self._advance_clock(clock)
        kind = evt["kind"]
        t = self._token(int(evt["serial"]))
        if kind == "started":
            oem = evt["oem"]
            t.update(station=0, since=clock, oem=oem, order=evt["order"], steelKg=evt["steelKg"], steel=evt["steelKg"] / 1000 * self.oems[oem]["steelEf"] * 1000, started=clock)
        elif kind == "moved":
            st = int(evt["station"])
            t["station"] = st
            t["since"] = clock
            if st == 2:
                t["s1"] += CO2_PER_BODY_KG * EF["co2"]
            if st == 3:
                t["s1"] += LPG_PER_BODY_KG * EF["lpg"]
        elif kind == "finished":
            self.tokens = [x for x in self.tokens if x["id"] != t["id"]]
            self.today["bodies"] += 1
            kwh = t["kwh"]
            steel = t["steel"] if t["steel"] is not None else 7360
            p = {"id": t["id"], "oem": t["oem"] or "A", "order": t["order"] or "PO-A-0000", "t": clock, "started": t["started"] or clock, "kwh": kwh, "s1": t["s1"], "s2": t["s2"],
                 "steel": steel, "steelKg": t["steelKg"] or 3200, "total": t["s1"] + t["s2"] + steel, "renewableShare": t["re"] / kwh if kwh else 0}
            self.passports.insert(0, p)
            del self.passports[300:]
            self.oem_today[p["oem"]] += 1
            self.on_passport({**p, "tenant": self.tenant_id})
            self.packet("line", "passport", f"Carbon passport #{t['id']} → {self.oems[p['oem']]['name']}", target="out_oem")
            self.log("ok", f"Body #{t['id']} carbon passport → {self.oems[p['oem']]['name']} ({p['order']}): {to_fixed_str(p['s1'] + p['s2'], 0)} kg plant + {to_fixed_str(p['steel'] / 1000, 2)} t steel, {to_fixed_str(p['renewableShare'] * 100, 0)}% renewable power.")

    # ---------- ledger results (from the ingestion service) ----------
    def entry_result(self, req: dict, result: str, rule: Optional[str] = None, reason: Optional[str] = None, item: Optional[dict] = None):
        """result: posted | held | duplicate | rejected"""
        dev = req.get("_device") or DEVICE_BY_LABEL.get(req.get("by", ""), device_for(req["registerId"]))
        kind = req.get("_kind") or ("production" if req["registerId"] == "PROD" else "entry")
        label = req.get("_label") or req.get("reason") or f"{req['registerId']} {req['line']}"
        if result == "held":
            self.today["flagged"] += 1
            self.totals["flagged"] += 1
            if item:
                self.quarantine.insert(0, item)
            self.log("block", f"{rule} held: {label}. {reason}")
            self.packet(dev, kind, label, registerId=req["registerId"], qty=req["qty"], flagged={"rule": rule, "reason": reason})
        elif result == "posted":
            self.today["posted"] += 1
            self.totals["posted"] += 1
            if req["line"] == "issued":
                if req["registerId"] == "DIESEL":
                    self.today["diesel"] += req["qty"]
                if req["registerId"] == "LPG":
                    self.today["lpg"] += req["qty"]
                if req["registerId"] == "CO2_GAS":
                    self.today["co2"] += req["qty"]
            self.packet(dev, kind, label, registerId=req["registerId"], qty=req["qty"])
            if kind != "rollup":
                self.log("flow", f"{next((d['label'] for d in DEVICES if d['id'] == dev), dev)}: {label} ({fmt(req['qty'])} {req['registerId']})")

    def resolved(self, item_id: str, action: str, qty: Optional[float] = None, rule: str = "", register_id: str = ""):
        q = next((x for x in self.quarantine if x["id"] == item_id), None)
        self.quarantine = [x for x in self.quarantine if x["id"] != item_id]
        if action == "reject":
            self.log("info", f"{rule} item rejected and discarded.")
            return
        self.packet(q["device"] if q else "stores", "resolve", "Resolved", registerId=register_id, qty=qty)
        self.log("ok", f"{rule} resolved by custodian: {'posted ' + fmt(qty) if action == 'fix' else 'confirmed as real and posted'}.")

    def device_status(self, device: str, online: bool, queued: int = 0):
        was = self.online.get(device, True)
        self.online[device] = online
        self.queued[device] = queued
        label = next((d["label"] for d in DEVICES if d["id"] == device), device)
        if was and not online:
            self.log("warn", f"{label} went offline: entries are saved on the device.")
        elif online and not was:
            self.log("ok", f"{label} back online: syncing saved entries (each posts once).")

    # ---------- day roll ----------
    def _roll_day(self):
        kg = self.kg_today()
        b = self.today["bodies"]
        self.log("ok", f"Day closed: {b} bodies, {fmt(js_round(self.today['kwh']))} kWh, {to_fixed_str(kg / 1000, 2)} t CO₂e, {to_fixed_str(kg / b, 0) if b else '—'} kg per body.")
        e = self.ems.roll_day()
        self.log("ok", f"EMS day summary: ₹{fmt(js_round(e['naiveInr'] - e['costInr']))} saved vs no optimisation, {fmt(js_round(e['solar']))} kWh solar, {js_round(e['exportKwh']):.0f} kWh exported, {js_round(e['eveningCut']):.0f} kWh taken off the evening peak.")
        self.today = {"bodies": 0, "kwh": 0.0, "diesel": 0.0, "lpg": 0.0, "co2": 0.0, "peakKva": 0.0, "packets": 0, "flagged": 0, "posted": 0}
        self.oem_today = {"A": 0, "B": 0, "C": 0}

    def kg_today(self) -> float:
        return self.ems.today["kgMarket"] + self.today["diesel"] * EF["diesel"] + self.today["lpg"] * EF["lpg"] + self.today["co2"] * EF["co2"]

    # ---------- snapshot for the UI ----------
    def snapshot(self, passports: bool = True) -> dict:
        e = self.ems
        h = utc_hour(self.clock)
        cur = e.current(self.block) if e.market else None
        return {
            "clock": self.clock, "contractKva": self.contract_kva, "pf": self.pf, "flexQueue": self.flex_queue, "meterCum": self.meter_cum, "meterKwh": self.meter_kwh,
            "shift": "A" if 6 <= h < 14 else "B" if 14 <= h < 22 else "C", "block": self.block, "month": month_of(self.clock) if self.clock else None,
            "kw": sum(self.last[k] for k in ("comp", "weld", "paint", "light", "util")), "kgToday": self.kg_today(),
            "today": self.today, "totals": self.totals, "last": self.last, "series": self.series, "events": self.events[:80], "quarantine": self.quarantine,
            "tokens": [{"id": t["id"], "station": t["station"], "oem": t["oem"], "order": t["order"], "since": t.get("since")} for t in self.tokens],
            "passports": self.passports if passports else [], "oemToday": self.oem_today, "machineAlerts": self.machine_alerts, "online": self.online, "queued": self.queued,
            "stations": STATIONS, "meters": METERS, "devices": DEVICES, "oems": self.oems,
            "ems": {"settings": vars(e.settings), "solarKwp": e.assets.solarKwp, "bess": {"capKwh": e.assets.bessCapKwh, "powerKw": e.assets.bessPowerKw, "soc": e.soc},
                    "gen": {"kw": e.assets.gensetKw, "on": e.gen_on}, "market": e.market, "tomorrow": e.tomorrow, "current": cur, "plan": e.plan, "flows": e.flows,
                    "today": e.today, "naive": e.naive, "blockLog": e.block_log, "decisions": e.decisions, "totals": e.totals, "last24": e.last24() if e.block_log else None,
                    "drEvents": e.dr_events, "drKwh": e.dr_kwh, "islandMin": e.island_min, "cloud": e.cloud, "spikeUntil": e.spike_until, "stressEventUntil": e.stress_event_until},
        }
