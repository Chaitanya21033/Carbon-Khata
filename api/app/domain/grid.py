"""Market feed shape, DISCOM tariff, grid-aware EMS (decision + accounting) and the naive twin.

Port of reference/src/sim/grid.ts. The reference ran decision, asset physics and accounting in one object.
Here they are split along the real-world boundary:
  * `market_day`, `discom_tod`, `landed`      – market model (IEX mock adapter + DISCOM tariff)
  * `EmsBrain.decide`                         – the optimiser, runs in the API once per 15-minute block
  * `site_minute`                             – asset physics, runs in the site controller (the simulator)
  * `EmsBrain.account` / `close_block`        – accounting + naive twin, runs in the API on metered flows
Plant clock values are milliseconds of *plant-local* time (IST wall clock written as if it were UTC),
exactly as the reference used them, so hour-of-day maths is unchanged.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .rng import rng
from .util import to_fixed, to_fixed_str

BLOCKS = 96
PRICE_CAP = 10.0
OA_ADDER = {"grey": 1.7, "green": 1.1}
CEA_EF = 0.71
GENSET_EF = 0.61
GENSET_KWH_PER_SCM = 3.3
GENSET_FUEL_INR = 5.6
IMPORT_CAP_KW = 380.0
EXPORT_CAP_KW = 220.0
DISCOM_BASE = 7.0
SOURCES = ("solar", "bess", "genset", "green", "rtm", "dam", "discom")
SOURCE_LABEL = {"solar": "Rooftop solar", "bess": "Battery", "genset": "Gas genset (CHP)", "green": "Green power (G-DAM)", "rtm": "Exchange real-time (RTM)", "dam": "Exchange day-ahead (DAM)", "discom": "DISCOM tariff"}
DAY_MS = 86_400_000


def _interp(pts, h):
    for i in range(len(pts) - 1):
        h0, v0 = pts[i]
        h1, v1 = pts[i + 1]
        if h0 <= h <= h1:
            t = (h - h0) / (h1 - h0)
            return v0 + (v1 - v0) * (0.5 - 0.5 * math.cos(math.pi * t))
    return pts[-1][1]


PRICE_SHAPE = [(0, 4.6), (4, 3.9), (6.5, 5.2), (8.5, 5.8), (10, 3.4), (12.5, 2.4), (15, 3.0), (17, 6.2), (18.5, 9.4), (21, 9.6), (22.5, 7.2), (24, 4.6)]
DEMAND_SHAPE = [(0, 34), (4, 31), (7, 37), (10, 41), (13, 42), (16, 41), (18, 43), (20, 46), (22, 42), (24, 34)]


def discom_tod(h: int) -> float:
    """DISCOM time-of-day energy charge: base ₹7, ×0.8 in solar hours (9–17), ×1.2 in the evening peak (18–22)."""
    if 9 <= h < 17:
        return to_fixed(DISCOM_BASE * 0.8, 2)
    if 18 <= h < 22:
        return to_fixed(DISCOM_BASE * 1.2, 2)
    return DISCOM_BASE


def market_day(day_index: int, cloud: float = 0.0) -> list[dict]:
    """Deterministic 96-block market day shaped like IEX DAM / G-DAM / RTM (mock feed)."""
    r = rng(9001 + day_index * 31)
    day_cloud = 0.15 * r.next()
    out: list[dict] = []
    for b in range(BLOCKS):
        h = b / 4
        sun = max(0.0, math.sin((math.pi * (h - 6.2)) / 12.6))
        solar_gw = 22 * sun * (1 - day_cloud - cloud * 0.6)
        demand = _interp(DEMAND_SHAPE, h) * (1 + r.normal(0.008))
        net = demand - solar_gw
        dam = min(PRICE_CAP, max(1.6, _interp(PRICE_SHAPE, h) + r.normal(0.25) + cloud * 2.5 * sun))
        rtm = min(PRICE_CAP, max(1.2, dam + r.normal(0.6) + (2.5 if r.next() < 0.03 else 0)))
        gdam = min(PRICE_CAP, dam + (-0.2 if sun > 0.3 else 0.9))
        marginal = to_fixed(0.92 - 0.38 * sun + (0.08 if 17.5 <= h < 22 else 0), 3)
        ramp = max(0.0, net - (out[b - 1]["netDemandGW"] if b > 0 else net)) if b > 0 else 0.0
        stress = max(0.0, min(100.0, (net - 26) * 4.2 + ramp * 30))
        out.append({"block": b, "dam": to_fixed(dam, 2), "gdam": to_fixed(gdam, 2), "rtm": to_fixed(rtm, 2), "discom": discom_tod(math.floor(h)),
                    "gridDemandGW": to_fixed(demand, 2), "solarGW": to_fixed(solar_gw, 2), "netDemandGW": to_fixed(net, 2), "marginalEf": marginal, "stress": math.floor(stress + 0.5)})
    return out


def landed(b: dict) -> dict:
    return {"discom": b["discom"], "rtm": b["rtm"] + OA_ADDER["grey"], "dam": b["dam"] + OA_ADDER["grey"], "green": b["gdam"] + OA_ADDER["green"]}


def utc_hour(clock: int) -> int:
    return (clock // 3_600_000) % 24


def utc_minute(clock: int) -> int:
    return (clock // 60_000) % 60


# ---------------------------------------------------------------------------------------------------------
@dataclass
class EmsSettings:
    enabled: bool = True
    carbonPrice: float = 1500
    greenCapKw: float = 150
    reserveSoc: float = 0.2
    solver: str = "rules"  # rules | lp


@dataclass
class Assets:
    solarKwp: float = 250
    bessCapKwh: float = 400
    bessPowerKw: float = 150
    bessEff: float = 0.92
    gensetKw: float = 150
    gensetMinRunBlocks: int = 2
    flexRunKw: float = 60
    flexDeadlineH: int = 21


def blank_today() -> dict:
    return {"kwh": {s: 0.0 for s in SOURCES}, "costInr": 0.0, "exportKwh": 0.0, "exportInr": 0.0, "kgMarket": 0.0, "kgLocation": 0.0, "kgMarginal": 0.0,
            "peakKw": 0.0, "peakEveningImportKwh": 0.0, "shiftedKwh": 0.0, "gasScm": 0.0}


def blank_block() -> dict:
    return {"supply": {s: 0.0 for s in SOURCES}, "export": 0.0, "load": 0.0, "naiveImport": 0.0, "n": 0, "cost": 0.0, "naiveCost": 0.0, "kg": 0.0, "naiveKg": 0.0,
            "evening": False, "peakKw": 0.0, "naivePeakKw": 0.0, "shifted": 0.0, "gas": 0.0}


def blank_plan(block: int = -1) -> dict:
    return {"block": block, "bess": 0.0, "genset": False, "export": False, "flexOn": False, "buy": "discom", "greenKw": 0.0, "shed": 0.0, "reason": ""}


class EmsBrain:
    """The optimiser and its books. Lives in the API, one per plant."""

    def __init__(self, settings: EmsSettings | None = None, assets: Assets | None = None):
        self.settings = settings or EmsSettings()
        self.assets = assets or Assets()
        self.day = -1
        self.market: list[dict] = []
        self.tomorrow: list[dict] = []
        self.cloud = 0.0
        self.stress_event_until = 0
        self.spike_until = 0
        self.plan = blank_plan()
        self.gen_on = False
        self.gen_ran_blocks = 0
        self.soc = 0.55
        self.flows = {k: 0.0 for k in ("load", "flexRun", "solar", "bessOut", "bessIn", "genset", "green", "rtm", "dam", "discom", "export", "curtail", "shed")}
        self.today = blank_today()
        self.naive = {"costInr": 0.0, "kg": 0.0, "peakKw": 0.0, "peakEveningKwh": 0.0, "exportInr": 0.0}
        self.hour = {"solar": 0.0, "green": 0.0, "grid": 0.0, "export": 0.0, "gasScm": 0.0}
        self.block_log: list[dict] = []
        self.decisions: list[dict] = []
        self.dr_events = 0
        self.dr_kwh = 0.0
        self.island_min = 0
        self.totals = {"solarKwh": 0.0, "greenKwh": 0.0, "savedInr": 0.0, "avoidedKg": 0.0, "exportKwh": 0.0, "exportInr": 0.0, "shiftedKwh": 0.0}
        self.block_acc = blank_block()
        self.block_saved = 0.0
        self.block_avoided = 0.0
        self.market_source = None  # optional callable(day_index) -> list[dict] (live adapter)

    # ---- market ----
    def ensure_day(self, day_index: int):
        if self.day == day_index:
            return
        self.day = day_index
        src = self.market_source or (lambda d: market_day(d, 0))
        self.market = src(day_index)
        self.tomorrow = src(day_index + 1)

    def current(self, block: int) -> dict:
        b = dict(self.market[block])
        if self.cloud > 0:
            b["rtm"] = min(PRICE_CAP, b["rtm"] + 1.5 * self.cloud)
        if self.spike_until > 0:
            b["rtm"] = PRICE_CAP
        if self.stress_event_until > 0:
            b["stress"] = max(b["stress"], 92)
        return b

    def _percentile(self, block: int, price: float) -> float:
        nxt = []
        for b in self.market[block:] + self.tomorrow[:block]:
            L = landed(b)
            nxt.append(min(L["discom"], L["rtm"], L["green"]) if L["discom"] > 0 else 0)
        return len([p for p in nxt if p < price]) / len(nxt)

    # ---- decision (once per block) ----
    def decide(self, clock: int, block: int, load_kw: float, flex_pending_kwh: float, working: bool, grid_down: bool, solar: float) -> str:
        mb = self.current(block)
        L = landed(mb)
        cheapest = min(L["discom"], L["rtm"], L["dam"], L["green"])
        pct = self._percentile(block, cheapest)
        net = load_kw - solar
        cp = self.settings.carbonPrice / 1000
        p = blank_plan(block)
        reasons: list[str] = []
        if not self.settings.enabled:
            p["reason"] = "Optimiser off: solar self-use only, everything else from the DISCOM."
            p["flexOn"] = working
            self.plan = p
            return p["reason"]
        a = self.assets
        soc_kwh = self.soc * a.bessCapKwh
        reserve = self.settings.reserveSoc * a.bessCapKwh
        eff = {"discom": L["discom"] + cp * CEA_EF, "rtm": L["rtm"] + cp * CEA_EF, "dam": L["dam"] + cp * CEA_EF, "green": L["green"]}
        buy = sorted(eff.keys(), key=lambda k: eff[k])[0]
        p["buy"] = buy
        if buy == "green":
            p["greenKw"] = min(self.settings.greenCapKw, max(0, net))
        reasons.append(f"buy {buy.upper()} at ₹{to_fixed_str(L['discom'] if buy == 'discom' else L[buy], 2)}")
        stressed = mb["stress"] >= 70 or self.stress_event_until > clock
        expensive = pct >= 0.75 or cheapest >= 8
        cheap = pct <= 0.3
        if grid_down:
            p["bess"] = min(a.bessPowerKw, soc_kwh * 4); reasons.append("grid down: battery carries critical load")
        elif net < 0:
            p["bess"] = -min(a.bessPowerKw, -net); reasons.append("store surplus solar")
        elif (expensive or stressed) and soc_kwh > reserve + 5:
            p["bess"] = min(a.bessPowerKw, (soc_kwh - reserve) * 4); reasons.append(f"grid stress {mb['stress']}: discharge" if stressed else "peak price: discharge")
        elif cheap and self.soc < 0.95:
            p["bess"] = -a.bessPowerKw; reasons.append("cheap block: charge battery")
        genset_cost = GENSET_FUEL_INR + cp * GENSET_EF
        grid_cost = min(eff["discom"], eff["rtm"], eff["green"])
        if grid_down or stressed or grid_cost > genset_cost + 1.2 or (self.gen_on and self.gen_ran_blocks < a.gensetMinRunBlocks):
            p["genset"] = True
            if not self.gen_on:
                reasons.append(f"start genset (₹{to_fixed_str(genset_cost, 2)}/kWh < grid ₹{to_fixed_str(grid_cost, 2)})")
        supply_no_grid = solar + (p["bess"] if p["bess"] > 0 else 0) + (a.gensetKw if p["genset"] else 0)
        if not grid_down and supply_no_grid > load_kw and (mb["rtm"] >= 6 or stressed):
            p["export"] = True; reasons.append(f"export surplus at ₹{to_fixed_str(mb['rtm'], 2)}")
        h_now = utc_hour(clock)
        near_deadline = h_now >= a.flexDeadlineH - 2 or h_now < 6
        p["flexOn"] = flex_pending_kwh > 1 and (net < 0 or cheap or near_deadline) and not stressed and not grid_down
        if flex_pending_kwh > 1 and not p["flexOn"] and working:
            reasons.append("defer flexible load")
        if p["flexOn"]:
            reasons.append("run flexible load on solar" if net < 0 else "run flexible load in cheap block")
        if stressed and not grid_down and self.stress_event_until > clock:
            p["shed"] = min(40, load_kw * 0.12); reasons.append(f"DR: shed {to_fixed_str(p['shed'], 0)} kW non-critical")
        p["reason"] = " · ".join(reasons)
        self.plan = p
        return p["reason"]

    def setpoint(self) -> dict:
        """What the site controller needs to execute the plan."""
        return {**self.plan, "enabled": self.settings.enabled, "reserveSoc": self.settings.reserveSoc}

    # ---- accounting (every metered minute) ----
    def account(self, clock: int, block: int, f: dict, base_load_kw: float, naive_flex_now: float, grid_down: bool, soc: float | None = None):
        self.ensure_day(clock // DAY_MS)
        mb = self.current(block)
        L = landed(mb)
        if soc is not None:
            self.soc = soc
        self.gen_on = bool(self.plan["genset"])
        solar, gen_kw, bess_out, bess_in, load, flex_run, shed = f["solar"], f["genset"], f["bessOut"], f["bessIn"], f["load"], f["flexRun"], f["shed"]
        m = 1 / 60
        T = self.today
        T["kwh"]["solar"] += min(solar, solar) * m; T["kwh"]["bess"] += bess_out * m; T["kwh"]["genset"] += gen_kw * m; T["kwh"]["green"] += f["green"] * m
        T["kwh"]["rtm"] += f["rtm"] * m; T["kwh"]["dam"] += f["dam"] * m; T["kwh"]["discom"] += f["discom"] * m
        export_price = mb["rtm"] - 0.6
        T["exportKwh"] += f["export"] * m; T["exportInr"] += f["export"] * m * export_price
        cost = (f["discom"] * L["discom"] + f["rtm"] * L["rtm"] + f["dam"] * L["dam"] + f["green"] * L["green"] + gen_kw * GENSET_FUEL_INR) * m - f["export"] * m * export_price
        T["costInr"] += cost
        grid_import = f["discom"] + f["rtm"] + f["dam"]
        T["kgMarket"] += (grid_import * CEA_EF + gen_kw * GENSET_EF) * m
        T["kgLocation"] += ((grid_import + f["green"]) * CEA_EF + gen_kw * GENSET_EF) * m
        T["kgMarginal"] += ((grid_import + f["green"] - f["export"]) * mb["marginalEf"] + gen_kw * GENSET_EF) * m
        T["gasScm"] += gen_kw * m / GENSET_KWH_PER_SCM
        T["peakKw"] = max(T["peakKw"], grid_import + f["green"])
        h = utc_hour(clock)
        evening = 18 <= h < 22
        if evening:
            T["peakEveningImportKwh"] += (grid_import + f["green"] - f["export"]) * m
        # naive twin: same base load, flexible load run immediately, solar self-used, rest from DISCOM, spill net-metered at ₹3
        naive_load = base_load_kw + (naive_flex_now or 0)
        naive_import = max(0.0, naive_load - solar)
        naive_spill = max(0.0, solar - naive_load)
        n_cost = naive_import * L["discom"] * m - naive_spill * 3 * m
        self.naive["costInr"] += n_cost
        n_kg = naive_import * CEA_EF * m
        self.naive["kg"] += n_kg
        self.naive["peakKw"] = max(self.naive["peakKw"], naive_import)
        if evening:
            self.naive["peakEveningKwh"] += naive_import * m
        n_marg = (naive_import - naive_spill) * mb["marginalEf"] * m
        saved = n_cost - cost
        avoided = n_marg - ((grid_import + f["green"] - f["export"]) * mb["marginalEf"] + gen_kw * GENSET_EF) * m
        tt = self.totals
        tt["savedInr"] += saved; tt["avoidedKg"] += avoided
        tt["solarKwh"] += solar * m; tt["greenKwh"] += f["green"] * m; tt["exportKwh"] += f["export"] * m; tt["exportInr"] += f["export"] * m * export_price
        if flex_run > 0 and mb["marginalEf"] < 0.8:
            T["shiftedKwh"] += flex_run * m; tt["shiftedKwh"] += flex_run * m
        if shed > 0:
            self.dr_kwh += shed * m
        if grid_down:
            self.island_min += 1
        H = self.hour
        H["solar"] += solar * m; H["green"] += f["green"] * m; H["grid"] += grid_import * m; H["export"] += f["export"] * m; H["gasScm"] += gen_kw * m / GENSET_KWH_PER_SCM
        a = self.block_acc
        s = a["supply"]
        s["solar"] += min(solar, load + bess_in) * m; s["bess"] += bess_out * m; s["genset"] += gen_kw * m; s["green"] += f["green"] * m
        s["rtm"] += f["rtm"] * m; s["dam"] += f["dam"] * m; s["discom"] += f["discom"] * m
        a["export"] += f["export"] * m; a["load"] += load * m; a["naiveImport"] += naive_import * m; a["n"] += 1
        a["cost"] += cost; a["naiveCost"] += n_cost; a["kg"] += (grid_import * CEA_EF + gen_kw * GENSET_EF) * m; a["naiveKg"] += n_kg
        a["evening"] = evening; a["peakKw"] = max(a["peakKw"], grid_import + f["green"]); a["naivePeakKw"] = max(a["naivePeakKw"], naive_import)
        a["gas"] += gen_kw * m / GENSET_KWH_PER_SCM
        if flex_run > 0 and mb["marginalEf"] < 0.8:
            a["shifted"] += flex_run * m
        self.block_saved += saved; self.block_avoided += avoided
        self.flows = dict(f)
        return cost

    def close_block(self, clock: int, block: int) -> dict | None:
        a = self.block_acc
        rec = None
        if a["n"]:
            mb = self.current(block)
            grid_in = a["supply"]["green"] + a["supply"]["rtm"] + a["supply"]["dam"] + a["supply"]["discom"]
            log = {"t": clock, "block": block, "supply": dict(a["supply"]), "export": a["export"], "load": a["load"], "price": mb["rtm"], "naiveImport": a["naiveImport"],
                   "plantNet": grid_in - a["export"], "cost": a["cost"], "naiveCost": a["naiveCost"], "kg": a["kg"], "naiveKg": a["naiveKg"], "evening": a["evening"],
                   "peakKw": a["peakKw"], "naivePeakKw": a["naivePeakKw"], "shifted": a["shifted"], "gas": a["gas"]}
            self.block_log.append(log)
            if len(self.block_log) > 96:
                self.block_log.pop(0)
            pl = self.plan
            mode = "export" if pl["export"] else "discharge" if pl["bess"] > 0 else "charge" if pl["bess"] < 0 else "genset" if pl["genset"] else "grid"
            rec = {"t": clock, "block": block, "text": pl["reason"], "mode": mode, "savedInr": self.block_saved, "avoidedKg": self.block_avoided, "log": log, "plan": dict(pl)}
            self.decisions.insert(0, {k: rec[k] for k in ("t", "block", "text", "mode", "savedInr", "avoidedKg")})
            del self.decisions[60:]
        self.block_acc = blank_block()
        self.block_saved = 0.0
        self.block_avoided = 0.0
        if self.plan["genset"]:
            self.gen_ran_blocks += 1
        else:
            self.gen_ran_blocks = 0
        return rec

    def expire(self, clock: int) -> list[str]:
        """Clear market / grid events whose window has passed. Returns notes for the event log."""
        notes = []
        if self.spike_until and clock > self.spike_until:
            self.spike_until = 0
        if self.stress_event_until and clock > self.stress_event_until:
            self.stress_event_until = 0
            notes.append("Demand-response event over. Normal dispatch resumed.")
        return notes

    def on_block(self, clock: int, block: int, load_kw: float, flex_pending: float, working: bool, grid_down: bool, solar: float, soc: float):
        """Site controller asks for a plan. Closes the previous block (if any) and decides the new one."""
        self.ensure_day(clock // DAY_MS)
        self.soc = soc
        closed = None
        if self.plan["block"] != block:
            if self.plan["block"] >= 0:
                closed = self.close_block(clock, self.plan["block"])
            self.decide(clock, block, load_kw, flex_pending, working, grid_down, solar)
            self.plan["block"] = block
        return self.setpoint(), closed

    def replan(self):
        self.plan["block"] = -1

    def last24(self) -> dict:
        L = self.block_log
        kwh = {s: sum(b["supply"][s] for b in L) for s in SOURCES}

        def sm(f):
            t = 0.0
            for b in L:
                t += f(b)
            return t
        return {"blocks": len(L), "kwh": kwh, "cost": sm(lambda b: b["cost"]), "naiveCost": sm(lambda b: b["naiveCost"]), "kg": sm(lambda b: b["kg"]), "naiveKg": sm(lambda b: b["naiveKg"]),
                "eve": sm(lambda b: b["plantNet"] if b["evening"] else 0), "naiveEve": sm(lambda b: b["naiveImport"] if b["evening"] else 0),
                "peak": max([0] + [b["peakKw"] for b in L]), "naivePeak": max([0] + [b["naivePeakKw"] for b in L]), "export": sm(lambda b: b["export"]),
                "shifted": sm(lambda b: b["shifted"]), "gas": sm(lambda b: b["gas"])}

    def take_hour(self) -> dict:
        h = self.hour
        self.hour = {"solar": 0.0, "green": 0.0, "grid": 0.0, "export": 0.0, "gasScm": 0.0}
        return h

    def roll_day(self) -> dict:
        t, n = self.today, self.naive
        summary = {"costInr": t["costInr"], "naiveInr": n["costInr"], "solar": t["kwh"]["solar"], "exportKwh": t["exportKwh"], "eveningCut": n["peakEveningKwh"] - t["peakEveningImportKwh"]}
        self.today = blank_today()
        self.naive = {"costInr": 0.0, "kg": 0.0, "peakKw": 0.0, "peakEveningKwh": 0.0, "exportInr": 0.0}
        return summary


