"""Bit-exact port of the reference's seeded generator (mulberry32 + Box–Muller), see reference/src/domain/synth.ts."""
from __future__ import annotations

import math

U32 = 0xFFFFFFFF


def imul(a: int, b: int) -> int:
    return ((a & U32) * (b & U32)) & U32


class Rng:
    def __init__(self, seed: int):
        self.a = seed & U32

    def next(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & U32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & U32)) & U32
        return ((t ^ (t >> 14)) & U32) / 4294967296

    def normal(self, sd: float = 1.0) -> float:
        u = max(1e-9, self.next())
        v = self.next()
        return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v) * sd

    def int(self, lo: int, hi: int) -> int:
        return lo + math.floor(self.next() * (hi - lo + 1))


def rng(seed: int) -> Rng:
    return Rng(seed)
