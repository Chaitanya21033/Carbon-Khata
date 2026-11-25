"""Site controller physics: executes the EMS setpoint on the plant's assets every minute.
In production this is the inverter / battery / genset PLC; here it is part of the simulator.
Port of the physics half of Ems.minute() in reference/src/sim/grid.ts."""
from __future__ import annotations

from dataclasses import dataclass

IMPORT_CAP_KW = 380.0
EXPORT_CAP_KW = 220.0


@dataclass
class Assets:
    solarKwp: float = 250
    bessCapKwh: float = 400
    bessPowerKw: float = 150
    bessEff: float = 0.92
    gensetKw: float = 150
    flexRunKw: float = 60


@dataclass
class SiteState:
    """Physical state of the site's assets, owned by the site controller (simulator or a real PLC)."""
    soc: float = 0.55
    gen_on: bool = False


def site_minute(st: SiteState, assets: Assets, sp: dict, solar: float, base_load_kw: float, flex_pending_kwh: float, grid_down: bool) -> dict:
    """Execute one minute of the current setpoint. Returns metered flows (kW averaged over the minute)."""
    flex_run = min(assets.flexRunKw, flex_pending_kwh * 60) if sp["flexOn"] and flex_pending_kwh > 0 else 0
    shed = sp["shed"]
    load = max(0.0, base_load_kw + flex_run - shed)
    gen_kw = assets.gensetKw if sp["genset"] else 0
    st.gen_on = bool(sp["genset"])
    bess_out = bess_in = 0.0
    cap = assets.bessCapKwh
    need = load - solar - gen_kw
    if sp["bess"] <= 0 and sp["enabled"] and not grid_down and need > IMPORT_CAP_KW and st.soc > 0.08:
        bess_out = min(assets.bessPowerKw, need - IMPORT_CAP_KW, (st.soc - 0.05) * cap * 60)
    elif sp["bess"] > 0:
        room = (st.soc - (0.02 if grid_down else sp["reserveSoc"])) * cap * 60
        bess_out = max(0.0, min(sp["bess"], room, max(0.0, load - solar - gen_kw) + (EXPORT_CAP_KW if sp["export"] else 0)))
    elif sp["bess"] < 0:
        room = (1 - st.soc) * cap * 60
        headroom = max(0.0, -need) if grid_down else max(0.0, IMPORT_CAP_KW - need)
        bess_in = max(0.0, min(-sp["bess"], room, headroom))
    supply = solar + gen_kw + bess_out
    deficit = load + bess_in - supply
    f = {"load": load, "flexRun": flex_run, "solar": solar, "bessOut": bess_out, "bessIn": bess_in, "genset": gen_kw, "green": 0.0, "rtm": 0.0, "dam": 0.0, "discom": 0.0, "export": 0.0, "curtail": 0.0, "shed": shed}
    if deficit > 0:
        if grid_down:
            f["shed"] += deficit; f["load"] -= deficit; deficit = 0
        else:
            g = min(deficit, sp["greenKw"] or deficit) if sp["buy"] == "green" else 0
            f["green"] = g; deficit -= g
            if sp["buy"] == "rtm":
                f["rtm"] = deficit
            elif sp["buy"] == "dam":
                f["dam"] = deficit
            else:
                f["discom"] = deficit
    elif deficit < 0:
        surplus = -deficit
        if not grid_down and sp["export"]:
            f["export"] = min(EXPORT_CAP_KW, surplus)
        elif not grid_down and sp["enabled"]:
            f["export"] = min(EXPORT_CAP_KW, surplus)
        f["curtail"] = surplus - f["export"]
    st.soc = max(0.0, min(1.0, st.soc + (bess_in * assets.bessEff - bess_out / assets.bessEff) / 60 / cap))
    return f
