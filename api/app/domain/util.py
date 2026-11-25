"""Numeric and formatting helpers that reproduce the JavaScript behaviour of the reference prototype exactly.

The reference relies on JS semantics (Math.round, Number.prototype.toFixed, 32-bit integer maths, en-IN number
formatting). Each helper here mirrors one of those so seeded data and calculated figures match bit for bit.
"""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, Sequence

U32 = 0xFFFFFFFF


def imul(a: int, b: int) -> int:
    """Math.imul: 32-bit multiply, returned as an unsigned 32-bit int."""
    return ((a & U32) * (b & U32)) & U32


def js_round(x: float) -> float:
    """Math.round: halves round towards +infinity."""
    return float(math.floor(x + 0.5))


def to_fixed(x: float, d: int) -> float:
    """+x.toFixed(d): exact-decimal rounding, ties away from zero."""
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return x
    q = Decimal(1).scaleb(-d)
    return float(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def to_fixed_str(x: float, d: int) -> str:
    q = Decimal(1).scaleb(-d)
    s = str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))
    return "0" if s in ("-0", "0") and d == 0 else s


def round_to(x: float, d: int = 0) -> float:
    """synth.ts `round`: Math.round(x * 10^d) / 10^d."""
    p = 10 ** d
    return js_round(x * p) / p


def num(x: float):
    """Return an int when the float is integral (so JSON matches the JS output)."""
    if isinstance(x, float) and x.is_integer() and abs(x) < 2**53:
        return int(x)
    return x


def median(xs: Sequence[float]) -> float:
    if not xs:
        return math.nan
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def nearest_median(values: Sequence[float | None], i: int, n: int) -> tuple[float, int]:
    """Median of the n nearest other points (by position), ties broken toward earlier months."""
    pts = [(v, j) for j, v in enumerate(values) if j != i and v is not None and not (isinstance(v, float) and math.isnan(v))]
    pts.sort(key=lambda x: (abs(x[1] - i), x[1]))
    vals = [v for v, _ in pts[:n]]
    return median(vals), len(vals)


def linreg(xs: Sequence[float], ys: Sequence[float]) -> dict:
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    b = sxy / sxx
    a = my - b * mx
    r2 = (sxy * sxy) / (sxx * syy)
    return {"a": a, "b": b, "r2": r2, "meanY": my}


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONTHS_HI = ["जन", "फ़र", "मार्च", "अप्रै", "मई", "जून", "जुल", "अग", "सित", "अक्टू", "नव", "दिस"]


def month_label(m: str, lang: str = "en", short: bool = True) -> str:
    y, mm = (int(p) for p in m.split("-"))
    name = (MONTHS_HI if lang == "hi" else MONTHS)[mm - 1]
    return f"{name} {str(y)[2:]}" if short else f"{name} {y}"


def fy(m: str) -> str:
    y, mm = (int(p) for p in m.split("-"))
    start = y if mm >= 4 else y - 1
    return f"FY {start}-{str(start + 1)[2:]}"


def fy_months(fy_start_year: int) -> list[str]:
    return [add_months(f"{fy_start_year}-04", k) for k in range(12)]


def add_months(m: str, k: int) -> str:
    y, mm = (int(p) for p in m.split("-"))
    t = y * 12 + (mm - 1) + k
    return f"{t // 12}-{(t % 12) + 1:02d}"


def _group_in(int_part: str) -> str:
    if len(int_part) <= 3:
        return int_part
    head, tail = int_part[:-3], int_part[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join(groups + [tail])


def fmt(n: float | None, digits: int = 0) -> str:
    """Indian digit grouping (en-IN): 12,34,567.89"""
    if n is None or (isinstance(n, float) and math.isnan(n)):
        return "—"
    neg = n < 0
    s = to_fixed_str(abs(n), digits)
    ip, _, fp = s.partition(".")
    out = _group_in(ip) + (f".{fp}" if fp else "")
    return f"-{out}" if neg and out.strip("0.,") else out


def lakh(n: float, digits: int = 2) -> str:
    return f"₹{fmt(n / 1e5, digits)} L"


def parse_csv(text: str) -> list[dict[str, str]]:
    lines = text.strip().splitlines()
    head = [h.strip() for h in lines[0].split(",")]
    rows = []
    for line in lines[1:]:
        cells = line.split(",")
        rows.append({h: (cells[i] if i < len(cells) else "").strip() for i, h in enumerate(head)})
    return rows


def sum_(xs: Iterable[float]) -> float:
    t = 0.0
    for x in xs:
        t += x
    return t
