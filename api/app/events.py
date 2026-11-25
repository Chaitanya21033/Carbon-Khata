"""In-process event bus for Server-Sent Events. Thread-safe publish (MQTT runs in a worker thread)."""
from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

_loop: asyncio.AbstractEventLoop | None = None
_subs: set["Subscriber"] = set()
_lock = threading.Lock()


class Subscriber:
    def __init__(self, tenants: set[str] | None, kinds: set[str] | None = None):
        self.q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.tenants = tenants  # None = all (admin)
        self.kinds = kinds


def bind_loop(loop: asyncio.AbstractEventLoop):
    global _loop
    _loop = loop


def subscribe(tenants: set[str] | None, kinds: set[str] | None = None) -> Subscriber:
    s = Subscriber(tenants, kinds)
    with _lock:
        _subs.add(s)
    return s


def unsubscribe(s: Subscriber):
    with _lock:
        _subs.discard(s)


def _deliver(tenant: str | None, kind: str, data: str):
    with _lock:
        subs = list(_subs)
    for s in subs:
        if s.tenants is not None and tenant is not None and tenant not in s.tenants:
            continue
        if s.kinds and kind not in s.kinds:
            continue
        try:
            s.q.put_nowait((kind, data))
        except asyncio.QueueFull:
            pass


def publish(tenant: str | None, kind: str, payload: Any):
    data = json.dumps(payload, default=str, separators=(",", ":"))
    if _loop is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is _loop:
        _deliver(tenant, kind, data)
    else:
        _loop.call_soon_threadsafe(_deliver, tenant, kind, data)
