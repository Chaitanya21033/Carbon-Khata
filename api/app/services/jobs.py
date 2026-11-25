"""Wall-clock jobs (APScheduler). EMS dispatch itself is driven by the plant clock: the site controller asks for a plan at
every 15-minute block boundary; the 15-minute job below covers sites whose controller only pulls (real-time plants)."""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

log = logging.getLogger("carbonkhata.jobs")


def _market_weather():
    from . import integrations
    integrations.solar_forecast(force=True)
    integrations.grid_carbon()


def _ems_wallclock():
    """Real-time plants: if telemetry is current (within 2 minutes of wall time) and no plan was requested for this block, plan it."""
    from ..live import registry
    now = registry.wall_plant_ms()
    for tw in list(registry.TWINS.values()):
        if tw.clock and abs(now - tw.clock) < 120_000 and tw.ems.plan["block"] != tw.block and tw.series:
            l = tw.series[-1]
            base = sum(l[k] for k in ("comp", "weld", "paint", "light", "util"))
            sp, _ = tw.ems.on_block(tw.clock, tw.block, base, tw.flex_queue, tw.working(tw.clock), False, l["solar"], tw.ems.soc)
            registry.publish(f"plant/{tw.tenant_id}/ems/setpoint", sp)


def _save():
    from ..live import registry
    for tw in list(registry.TWINS.values()):
        registry.save_state(tw)


def start() -> BackgroundScheduler:
    s = BackgroundScheduler(timezone="Asia/Kolkata")
    s.add_job(_market_weather, "interval", hours=1, id="market_weather", next_run_time=None)
    s.add_job(_ems_wallclock, "cron", minute="0,15,30,45", id="ems_dispatch")
    s.add_job(_save, "interval", minutes=1, id="save_twins")
    s.start()
    return s
