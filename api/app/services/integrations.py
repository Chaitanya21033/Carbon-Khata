"""External data sources. Each has an interface, a live adapter and a mock adapter; keys come from .env.
The UI shows each source's status: live / simulated / needs_key / adapter."""
from __future__ import annotations

import datetime as dt
import logging
import math
import re
import time
from typing import Protocol

import httpx

from ..config import settings
from ..domain.grid import market_day

log = logging.getLogger("carbonkhata.integrations")
SITE = {"lat": 22.8, "lon": 86.18, "name": "Jamshedpur", "zone": "IN-EA"}
_status: dict[str, dict] = {}


def set_status(sid: str, status: str, note: str):
    _status[sid] = {"status": status, "note": note, "at": time.time()}


# ---------------- market prices (IEX) ----------------
class MarketAdapter(Protocol):
    name: str
    def day(self, day_index: int) -> list[dict]: ...


class MockIexAdapter:
    """Replays the reference's 96-block DAM / G-DAM / RTM shape. A licensed feed plugs in behind the same interface."""
    name = "iex_mock"

    def day(self, day_index: int) -> list[dict]:
        return market_day(day_index, 0)


class LicensedIexAdapter(MockIexAdapter):
    name = "iex_licensed"

    def day(self, day_index: int) -> list[dict]:
        try:
            d = (dt.date(1970, 1, 1) + dt.timedelta(days=day_index)).isoformat()
            r = httpx.get(f"{settings.iex_api_url.rstrip('/')}/market/{d}", headers={"Authorization": f"Bearer {settings.iex_api_key}"}, timeout=8)
            r.raise_for_status()
            return r.json()["blocks"]
        except Exception as e:
            set_status("iex", "simulated", f"Licensed feed failed ({e}); mock replay used.")
            return super().day(day_index)


def market_adapter() -> MarketAdapter:
    if settings.iex_api_url and settings.iex_api_key:
        set_status("iex", "live", "Licensed market-data feed")
        return LicensedIexAdapter()
    set_status("iex", "adapter", "IEX data is for registered members. Mock feed replays the 96-block DAM / G-DAM / RTM shape through the same adapter.")
    return MockIexAdapter()


# ---------------- solar forecast (Open-Meteo, free, no key) ----------------
_solar_cache: dict = {}


def simulated_solar() -> list[dict]:
    start = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    out = []
    for i in range(48):
        d = start + dt.timedelta(hours=i)
        h = (d.hour + 5.5) % 24
        sun = max(0.0, math.sin((math.pi * (h - 6.2)) / 12.6))
        cloud = 20 + 25 * max(0.0, math.sin(i / 7))
        out.append({"time": d.isoformat(), "ghi": round(820 * sun * (1 - cloud / 160)), "cloud": round(cloud)})
    return out


def solar_forecast(force: bool = False) -> dict:
    if not force and _solar_cache.get("at", 0) > time.time() - 3600:
        return _solar_cache["data"]
    data = None
    if settings.open_meteo_enabled:
        try:
            r = httpx.get("https://api.open-meteo.com/v1/forecast", params={"latitude": SITE["lat"], "longitude": SITE["lon"], "hourly": "shortwave_radiation,cloud_cover",
                                                                          "forecast_days": 2, "timezone": "Asia/Kolkata"}, timeout=8)
            r.raise_for_status()
            j = r.json()
            hours = [{"time": t, "ghi": j["hourly"]["shortwave_radiation"][i] or 0, "cloud": j["hourly"]["cloud_cover"][i] or 0} for i, t in enumerate(j["hourly"]["time"])]
            data = {"source": "live", "hours": hours, "note": f"Open-Meteo forecast for {SITE['name']}, fetched {dt.datetime.now().strftime('%H:%M')}"}
            set_status("weather", "live", data["note"])
        except Exception as e:
            set_status("weather", "simulated", f"Live call failed ({type(e).__name__}); modelled clear-sky curve shown.")
    if data is None:
        data = {"source": "simulated", "hours": simulated_solar(), "note": _status.get("weather", {}).get("note", "Modelled clear-sky curve")}
        if "weather" not in _status:
            set_status("weather", "simulated", data["note"])
    _solar_cache.update(at=time.time(), data=data)
    return data


def pv_kwh(hours: list[dict], kwp: float) -> float:
    return sum((h["ghi"] / 1000) * kwp * 0.8 for h in hours)


# ---------------- grid carbon intensity (Electricity Maps; key held by the user for now) ----------------
def grid_carbon(simulated_g: float = 710) -> dict:
    key = settings.electricitymaps_api_key
    if not key:
        set_status("emaps", "needs_key", "Add ELECTRICITYMAPS_API_KEY to .env to use the live figure. Using the CEA factor.")
        return {"source": "needs_key", "gPerKwh": simulated_g, "zone": SITE["zone"], "note": _status["emaps"]["note"]}
    try:
        r = httpx.get("https://api.electricitymap.org/v3/carbon-intensity/latest", params={"zone": SITE["zone"]}, headers={"auth-token": key}, timeout=8)
        r.raise_for_status()
        j = r.json()
        set_status("emaps", "live", f"Electricity Maps, zone {j.get('zone', SITE['zone'])}")
        return {"source": "live", "gPerKwh": j["carbonIntensity"], "zone": j.get("zone", SITE["zone"]), "datetime": j.get("datetime"), "note": _status["emaps"]["note"]}
    except Exception as e:
        set_status("emaps", "simulated", f"Live call failed ({type(e).__name__}); using the CEA factor.")
        return {"source": "simulated", "gPerKwh": simulated_g, "zone": SITE["zone"], "note": _status["emaps"]["note"]}


# ---------------- smart meters (head-end system) ----------------
def smart_meter_status():
    if settings.smart_meter_api_url:
        set_status("smartmeter", "live", "Head-end system API configured; 1-minute push over MQTT plus REST pull for gaps.")
    else:
        set_status("smartmeter", "simulated", "Smart meters push 1-minute frames over MQTT (plant/{plantId}/meter/{meterId}). The demo plant's meters are simulated.")


def smart_meter_latest(meter_id: str) -> dict | None:
    """Pull the latest register reading from the HES API (if configured)."""
    if not settings.smart_meter_api_url:
        return None
    try:
        r = httpx.get(f"{settings.smart_meter_api_url.rstrip('/')}/meters/{meter_id}/latest", headers={"Authorization": f"Bearer {settings.smart_meter_api_key}"}, timeout=6)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("HES pull failed: %s", e)
        return None


# ---------------- GSTIN / Udyam (KYB) ----------------
STATE = {"20": "Jharkhand", "21": "Odisha", "27": "Maharashtra", "29": "Karnataka", "06": "Haryana", "09": "Uttar Pradesh", "24": "Gujarat", "33": "Tamil Nadu", "19": "West Bengal", "07": "Delhi"}


def verify_gstin(g: str) -> dict:
    v = g.strip().upper()
    ok = bool(re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", v))
    set_status("kyb", "adapter", "Format and state code checked locally. A GSP / KYC vendor plugs in behind the same adapter.")
    if not ok:
        return {"ok": False, "source": "adapter", "note": "Not a valid 15-character GSTIN."}
    return {"ok": True, "name": "Shakti Pressings Pvt Ltd (demo)", "status": "Active", "state": STATE.get(v[:2], f"State code {v[:2]}"), "source": "adapter",
            "note": "Format and state code checked locally. In production this calls a GSTN-licensed KYB API for name and status."}


def verify_udyam(u: str) -> dict:
    ok = bool(re.fullmatch(r"UDYAM-[A-Z]{2}-\d{2}-\d{7}", u.strip().upper()))
    if not ok:
        return {"ok": False, "source": "adapter", "note": "Format: UDYAM-XX-00-0000000"}
    return {"ok": True, "status": "Registered · Micro/Small (demo)", "source": "adapter", "note": "Format checked locally; a KYB provider returns enterprise class and activity in production."}


def sources() -> list[dict]:
    smart_meter_status()
    market_adapter()
    if "weather" not in _status:
        solar_forecast()
    grid_carbon()
    if "kyb" not in _status:
        set_status("kyb", "adapter", "Format and state code checked locally. A GSP / KYC vendor plugs in behind the same adapter.")
    set_status("otp", "simulated" if not settings.smtp_url else "live", "Sign-in codes print to the API console (dev)." if not settings.smtp_url else "SMTP configured")
    meta = [
        ("smartmeter", "Smart meters (1-minute feed)", "Plant smart meters / head-end system", "Main incomer and sub-meter energy, kVA, PF"),
        ("weather", "Solar forecast", "Open-Meteo (free, no key)", "48-hour irradiance for the EMS"),
        ("emaps", "Grid carbon intensity", "Electricity Maps (zone IN-EA)", "Live gCO₂/kWh for the regional grid"),
        ("iex", "IEX market prices & bidding", "Indian Energy Exchange member API (via a trading member)", "DAM, G-DAM and RTM prices"),
        ("kyb", "GSTIN & Udyam checks", "GSTN-licensed KYB APIs", "Verify a supplier at onboarding"),
        ("otp", "Sign-in codes", "E-mail / SMS gateway", "One-time passwords"),
    ]
    return [{"id": i, "name": n, "provider": p, "role": r, **_status.get(i, {"status": "adapter", "note": ""})} for i, n, p, r in meta]
