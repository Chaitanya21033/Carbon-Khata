"""CarbonKhata API. OpenAPI docs at /docs."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import events
from .config import settings
from .live import registry
from .routers import core, ops

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    events.bind_loop(asyncio.get_running_loop())
    registry.start_mqtt()
    from .services import jobs
    sched = jobs.start() if settings.scheduler_enabled else None
    yield
    if sched:
        sched.shutdown(wait=False)
    registry.stop_mqtt()


app = FastAPI(title="CarbonKhata API", version="1.0.0", lifespan=lifespan,
              description="Supplier-side ESG and energy platform for Indian MSMEs. All demo data is fictional.")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in settings.cors_origins.split(",")], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(core.r)
app.include_router(ops.r)


def _openapi():
    """Add the two auth schemes so 'Authorize' in /docs works: a user JWT (Bearer) or a device key."""
    if app.openapi_schema:
        return app.openapi_schema
    from fastapi.openapi.utils import get_openapi
    sch = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
    sch.setdefault("components", {})["securitySchemes"] = {
        "bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT", "description": "Sign in on the app, then Data sources → APIs → Copy my token"},
        "deviceKey": {"type": "apiKey", "in": "header", "name": "X-Device-Key", "description": "Gateway / device key from DEVICE_KEYS in .env"}}
    sch["security"] = [{"bearerAuth": []}, {"deviceKey": []}]
    app.openapi_schema = sch
    return sch


app.openapi = _openapi


@app.get("/health", tags=["ops"])
def health():
    return {"ok": True, "mqtt": registry._mqtt is not None and registry._mqtt.is_connected()}


@app.exception_handler(ValueError)
async def value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})
