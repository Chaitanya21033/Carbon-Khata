"""Kalundborg-style cluster (Adityapur Green Cluster, fictional): energy pool through one licensed trader,
deviation netting, resource exchanges with paired sender/receiver lines, scoreboard and benefit split.
Port of reference/src/sim/cluster.ts. Member loads arrive as metered block readings; this module settles them."""
from __future__ import annotations

import math

from .grid import BLOCKS, OA_ADDER, discom_tod, market_day

CLUSTER_NAME = "Adityapur Green Cluster (demo)"
MEMBERS = [
    {"id": "vbw", "name": "Vardhan Body Works", "type": "Tipper bodies (fabrication)", "kw": 380, "shape": "day", "err": 0.07, "x": 110, "y": 90, "you": True},
    {"id": "fab2", "name": "Kiran Fabricators", "type": "Chassis brackets", "kw": 260, "shape": "day", "err": 0.09, "x": 110, "y": 280},
    {"id": "fab3", "name": "Shakti Engineering", "type": "Trailer frames", "kw": 310, "shape": "day", "err": 0.09, "x": 110, "y": 470},
    {"id": "fdy", "name": "Subarnarekha Castings", "type": "Grey-iron foundry", "kw": 1450, "shape": "flat", "err": 0.05, "x": 470, "y": 280},
    {"id": "frg", "name": "Dalma Forgings", "type": "Closed-die forge", "kw": 920, "shape": "two", "err": 0.06, "x": 470, "y": 90},
    {"id": "pnt", "name": "Coatwell Finishers", "type": "Job-work paint shop", "kw": 240, "shape": "paint", "err": 0.1, "x": 650, "y": 90},
    {"id": "cem", "name": "Kolhan Cement Grinding", "type": "Slag-cement grinding unit", "kw": 1800, "shape": "night", "err": 0.05, "x": 650, "y": 280},
    {"id": "fm1", "name": "Annapurna Foods", "type": "FMCG co-packer (snacks)", "kw": 520, "shape": "two", "err": 0.07, "x": 650, "y": 470},
    {"id": "fm2", "name": "Swarnrekha Beverages", "type": "FMCG co-packer (drinks)", "kw": 430, "shape": "two", "err": 0.08, "x": 290, "y": 470},
    {"id": "etp", "name": "Cluster CETP", "type": "Common effluent plant", "kw": 140, "shape": "flat", "err": 0.04, "x": 470, "y": 470},
    {"id": "scr", "name": "Green Metal Recyclers", "type": "Scrap sorting & baling", "kw": 190, "shape": "day", "err": 0.1, "x": 290, "y": 280},
    {"id": "sol", "name": "Cluster solar park", "type": "Group-captive 3 MWp + 2 MWh battery", "kw": 0, "shape": "flat", "err": 0, "x": 830, "y": 90},
    {"id": "tool", "name": "Precision Tool Room", "type": "Tool & die (joining)", "kw": 160, "shape": "day", "err": 0.1, "x": 290, "y": 90, "late": True},
]
POOL_NODE = {"x": 830, "y": 280}
OA_THRESHOLD_KW = 1000
TRADER_MARGIN = 0.04
DSM_TOL = 0.02
DSM_RATE = 2.5
HEDGE_SHARE = 0.6
HEDGE_RATE = 4.9
SOLAR_KWP = 3000
SOLAR_TARIFF = 3.3
FY_START_ISO = "2026-04-01"
MIN = 60_000
DAY = 86_400_000

X = lambda **k: k
BASE_EXCHANGES = [
    X(id="x-scrap", **{"from": "vbw"}, to=["fdy"], kind="material", what="Steel off-cuts and skeleton scrap", qty=34, unit="t", inrPerMonth=238000, tco2PerMonth=51, tMatPerMonth=34, claim="receiver", claimNote="Foundry counts lower-carbon charge mix (Scope 3, purchased goods)", senderShare=0.5),
    X(id="x-scrap2", **{"from": "fab2"}, to=["scr", "fdy"], kind="material", what="Mixed steel scrap via baler", qty=22, unit="t", inrPerMonth=132000, tco2PerMonth=33, tMatPerMonth=22, claim="receiver", claimNote="Foundry counts lower-carbon charge mix", senderShare=0.5, chain=True),
    X(id="x-heat", **{"from": "frg"}, to=["pnt"], kind="heat", what="Furnace exhaust heat to oven pre-heat", qty=42, unit="MWh-th", inrPerMonth=221000, tco2PerMonth=8.1, mwhPerMonth=42, claim="receiver", claimNote="Paint shop burns less PNG: its own Scope 1 falls, nothing to transfer", senderShare=0.4),
    X(id="x-sludge", **{"from": "pnt"}, to=["cem"], kind="waste", what="Paint sludge co-processed as kiln fuel", qty=4.5, unit="t", inrPerMonth=27000, tco2PerMonth=4.9, tMatPerMonth=4.5, claim="receiver", claimNote="Cement unit counts the fossil fuel it displaced", senderShare=0.6),
    X(id="x-water", **{"from": "etp"}, to=["fdy", "cem"], kind="water", what="Treated water for cooling and dust suppression", qty=2600, unit="m³", inrPerMonth=70000, tco2PerMonth=0.6, m3PerMonth=2600, claim="split", claimNote="Small pumping saving, split by volume taken", senderShare=0.5),
    X(id="x-slag", **{"from": "fdy"}, to=["cem"], kind="material", what="Foundry slag as blending material (trial)", qty=55, unit="t", inrPerMonth=44000, tco2PerMonth=13.8, tMatPerMonth=55, claim="receiver", claimNote="Cement unit counts clinker it did not need", senderShare=0.5),
    X(id="x-pallet", **{"from": "fm1"}, to=["fab3"], kind="material", what="Wooden pallets and crates reused", qty=900, unit="pcs", inrPerMonth=54000, tco2PerMonth=2.2, tMatPerMonth=9, claim="sender", claimNote="Co-packer reports waste diverted; receivers claim nothing", senderShare=0.5),
    X(id="x-solar", **{"from": "sol"}, to=["vbw", "fab2", "fab3", "fdy", "frg", "pnt", "fm1", "fm2", "etp", "scr"], kind="power", what="Group-captive solar, shared by consumption", qty=360, unit="MWh", inrPerMonth=720000, tco2PerMonth=256, mwhPerMonth=360, claim="consumption", claimNote="Each member claims only the kWh it was allocated (market-based Scope 2)", senderShare=0),
]
PROPOSALS = [
    X(id="p-offcut", **{"from": "fab3"}, to=["fdy"], kind="material", what="Trailer-frame off-cuts (now sold to a kabadi)", qty=14, unit="t", inrPerMonth=98000, tco2PerMonth=21, tMatPerMonth=14, claim="receiver", claimNote="Foundry counts lower-carbon charge mix", senderShare=0.5),
    X(id="p-heat2", **{"from": "frg"}, to=["fm1"], kind="heat", what="Second exhaust loop to snack dryer", qty=26, unit="MWh-th", inrPerMonth=137000, tco2PerMonth=5, mwhPerMonth=26, claim="receiver", claimNote="Co-packer burns less PNG in its own Scope 1", senderShare=0.4),
    X(id="p-food", **{"from": "fm1"}, to=["etp"], kind="waste", what="Food waste to CETP biogas digester", qty=6, unit="t", inrPerMonth=21000, tco2PerMonth=3.4, tMatPerMonth=6, claim="sender", claimNote="Co-packer reports avoided landfill methane", senderShare=0.5),
    X(id="p-water2", **{"from": "etp"}, to=["fm2"], kind="water", what="Polished water for crate washing", qty=900, unit="m³", inrPerMonth=24000, tco2PerMonth=0.2, m3PerMonth=900, claim="split", claimNote="Split by volume", senderShare=0.5),
]
FLOW_COLOR = {"power": "#F2A900", "heat": "#E8743B", "material": "#4C9BE8", "water": "#2EC4B6", "waste": "#8A6FD1"}
FLOW_LABEL = {"power": "Power", "heat": "Heat", "material": "Materials", "water": "Water", "waste": "Waste to resource"}


def park_solar_kw(h: float, cloud: bool) -> float:
    s = math.sin(((h - 6) / 12) * math.pi) if 6 < h < 18 else 0
    return SOLAR_KWP * 0.82 * s * (0.35 if cloud else 1)


def settle_block(b: int, readings: dict, market_block: dict, cloud: bool = False, spike: bool = False) -> dict:
    """readings: {member_id: (scheduled_kw, actual_kw)} for one 15-minute block."""
    h = b / 4
    sched = actual = indiv_dev = indiv_pen = solo = 0.0
    for s, a in readings.values():
        sched += s; actual += a
        d = abs(a - s); indiv_dev += d
        indiv_pen += max(0.0, d - DSM_TOL * s) * 0.25 * DSM_RATE
        solo += a * 0.25 * discom_tod(math.floor(h))
    sol = park_solar_kw(h, cloud)
    pooled_dev = abs(actual - sched)
    pooled_pen = max(0.0, pooled_dev - DSM_TOL * sched) * 0.25 * DSM_RATE
    rtm = 10 if spike else market_block["rtm"]
    net = max(0.0, actual - sol)
    hedged = min(net, sched * HEDGE_SHARE)
    spot = net - hedged
    pooled_cost = (min(sol, actual) * SOLAR_TARIFF + hedged * (HEDGE_RATE + OA_ADDER["grey"] + TRADER_MARGIN) + spot * (min(market_block["dam"], rtm) + OA_ADDER["grey"] + TRADER_MARGIN)) * 0.25 + pooled_pen
    return {"block": b, "sched": sched, "actual": actual, "indivDev": indiv_dev, "pooledDev": pooled_dev, "indivPen": indiv_pen, "pooledPen": pooled_pen, "pooledCost": pooled_cost, "soloCost": solo, "solar": sol}


def reconcile(sent: float, received: float) -> str:
    diff = abs(received - sent) / max(sent, 0.001)
    return "mismatch" if diff > 0.02 else "reconciled"
