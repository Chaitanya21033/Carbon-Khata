"""Adityapur Green Cluster (fictional): what each member's meter reports, block by block.
Port of the load model in reference/src/sim/cluster.ts (deterministic hash noise)."""
from __future__ import annotations

import math

U32 = 0xFFFFFFFF
DAY = 86_400_000
MIN = 60_000


def _hash(*n: float) -> float:
    h = 2166136261
    for v in n:
        h = (h ^ (math.floor(v * 1000) & U32)) & U32
        h = (h * 16777619) & U32
    return (h % 100000) / 100000


def _gauss(*n: float) -> float:
    u = _hash(*n) or 1e-5
    v = _hash(*n, 7)
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)


def shape_at(shape: str, h: float) -> float:
    if shape == "flat":
        return 0.88 + 0.06 * math.sin(h)
    if shape == "day":
        return (0.55 if 13 <= h < 14 else 0.92) if 8 <= h < 20 else 0.16
    if shape == "two":
        return 0.9 if 6 <= h < 22 else 0.22
    if shape == "paint":
        return 0.95 if 9 <= h < 18 else 0.12
    return 0.95 if (h >= 22 or h < 6) else 0.25 if h >= 18 else 0.6


def member_load(m: dict, t: int, actual: bool, overdraw_until: int = 0) -> float:
    h = (t % DAY) / 3_600_000
    base = m["kw"] * shape_at(m["shape"], h)
    if not actual:
        return base
    blk = (t % DAY) // (15 * MIN)
    day = t // DAY
    v = base * (1 + m["err"] * _gauss(day, blk, m["kw"], m["x"]))
    if m["id"] == "fab3" and t < overdraw_until:
        v *= 1.45
    return max(0.0, v)


def weighbridge(clock: int, qty_per_month: float) -> tuple[float, float]:
    sent = round(qty_per_month / 30 / 3 * (0.8 + _hash(clock) * 0.4), 2)
    received = round(sent * (1 + (_hash(clock, 3) - 0.5) * 0.008), 2)
    return sent, received
