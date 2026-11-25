"""Optional optimiser: a 96-block linear programme (PuLP + CBC) over the same assets and prices as the rule-based EMS.
Run on the last 24 h of metered load and solar, so it shows how much a full-day optimiser would have saved over the rules."""
from __future__ import annotations

from ..domain.grid import CEA_EF, DAY_MS, EXPORT_CAP_KW, GENSET_EF, GENSET_FUEL_INR, IMPORT_CAP_KW, OA_ADDER, market_day


def optimise(ems) -> dict:
    log = ems.block_log[-96:]
    if len(log) < 8:
        return {"available": False, "note": "Needs at least two hours of metered blocks."}
    try:
        import pulp
    except ImportError:
        return {"available": False, "note": "PuLP is not installed."}
    a, s = ems.assets, ems.settings
    cp = s.carbonPrice / 1000
    days: dict = {}
    m = pulp.LpProblem("ems_day", pulp.LpMinimize)
    B = range(len(log))
    V = lambda n, ub=None: {b: pulp.LpVariable(f"{n}_{b}", 0, ub) for b in B}
    gd, gr, gm, gg, ch, dis, gen, ex, cu = V("gd"), V("gr"), V("gm"), V("gg", s.greenCapKw), V("ch", a.bessPowerKw), V("dis", a.bessPowerKw), V("gen", a.gensetKw), V("ex", EXPORT_CAP_KW), V("cu")
    soc = {b: pulp.LpVariable(f"soc_{b}", s.reserveSoc * a.bessCapKwh, a.bessCapKwh) for b in range(len(log) + 1)}
    cost = []
    for b in B:
        lb = log[b]
        d = lb["t"] // DAY_MS
        if d not in days:
            days[d] = market_day(d)
        mb = days[d][lb["block"]]
        load = lb["load"] * 4
        solar = sum(lb["supply"][k] for k in ("solar",)) * 4 + lb["export"] * 0  # solar used on site (kW)
        m += solar + dis[b] + gen[b] + gd[b] + gr[b] + gm[b] + gg[b] == load + ch[b] + ex[b] + cu[b]
        m += gd[b] + gr[b] + gm[b] + gg[b] <= IMPORT_CAP_KW
        m += soc[b + 1] == soc[b] + (ch[b] * a.bessEff - dis[b] * (1 / a.bessEff)) * 0.25
        cost.append(0.25 * (gd[b] * (mb["discom"] + cp * CEA_EF) + gr[b] * (mb["rtm"] + OA_ADDER["grey"] + cp * CEA_EF) + gm[b] * (mb["dam"] + OA_ADDER["grey"] + cp * CEA_EF)
                            + gg[b] * (mb["gdam"] + OA_ADDER["green"]) + gen[b] * (GENSET_FUEL_INR + cp * GENSET_EF) - ex[b] * (mb["rtm"] - 0.6)))
    m += soc[0] == 0.55 * a.bessCapKwh
    m += soc[len(log)] >= 0.55 * a.bessCapKwh
    m += pulp.lpSum(cost)
    m.solve(pulp.PULP_CBC_CMD(msg=False, timeLimit=20))
    if pulp.LpStatus[m.status] != "Optimal":
        return {"available": False, "note": f"Solver status {pulp.LpStatus[m.status]}"}
    carbon_rules = sum(l["kg"] for l in log) * cp
    rules = sum(l["cost"] for l in log) + carbon_rules
    lp = pulp.value(m.objective)
    naive = sum(l["naiveCost"] for l in log) + sum(l["naiveKg"] for l in log) * cp
    return {"available": True, "blocks": len(log), "lpCostInr": lp, "rulesCostInr": rules, "naiveCostInr": naive, "lpVsRulesPct": (lp / rules - 1) * 100 if rules else None,
            "note": "Costs include the internal carbon price. LP keeps the metered load fixed (no flexible-load shifting) and ends the day at the starting battery level."}
