"""Live transport: the simulator talks to CarbonKhata exactly like real devices do.
Meters and the site controller use MQTT; phones, the line MES and feeds use REST with a device key + Idempotency-Key."""
from __future__ import annotations

import datetime as dt
import json
import logging
import threading
import time
import uuid

import httpx
import paho.mqtt.client as mqtt

log = logging.getLogger("sim.transport")
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def iso(clock: int) -> str:
    return (dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=clock)).replace(tzinfo=IST).isoformat()


class Api:
    def __init__(self, base: str, keys: dict[str, str]):
        self.base = base.rstrip("/")
        self.keys = keys
        self.c = httpx.Client(timeout=10)
        self.retry: list[tuple] = []
        self.errors = 0

    def call(self, method: str, path: str, device: str, body=None, idem: str | None = None, queue_on_fail: bool = True):
        h = {"X-Device-Key": self.keys[device]}
        if idem:
            h["Idempotency-Key"] = idem
        try:
            r = self.c.request(method, f"{self.base}{path}", json=body, headers=h)
            if r.status_code >= 500:
                raise httpx.HTTPError(f"{r.status_code}")
            if r.status_code >= 400:
                log.info("API %s %s → %s %s", method, path, r.status_code, r.text[:160])
            return r.json() if r.headers.get("content-type", "").startswith("application/json") else None
        except httpx.HTTPError as e:
            self.errors += 1
            if queue_on_fail:
                self.retry.append((method, path, device, body, idem))
            log.warning("API unreachable (%s); will retry %s", e, path)
            return None

    def flush(self):
        q, self.retry = self.retry, []
        for item in q[:50]:
            self.call(*item)
        self.retry.extend(q[50:])


class LiveTransport:
    def __init__(self, api: Api, mqtt_host: str, mqtt_port: int, plant: str = "vbw"):
        self.api = api
        self.plant = plant
        self.pending: dict[str, dict] = {}
        self.cv = threading.Condition()
        self.on_replan = lambda: None
        self.m = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"carbonkhata-sim-{uuid.uuid4().hex[:6]}")
        self.m.on_connect = lambda c, u, f, rc, p=None: c.subscribe([(f"plant/{plant}/ems/setpoint", 0), (f"plant/{plant}/ems/replan", 0)])
        self.m.on_message = self._msg
        self.m.reconnect_delay_set(1, 10)
        self.m.connect_async(mqtt_host, mqtt_port, keepalive=30)
        self.m.loop_start()

    def _msg(self, c, u, msg):
        p = json.loads(msg.payload)
        if msg.topic.endswith("/replan"):
            self.on_replan()
            return
        with self.cv:
            if p.get("reqId"):
                self.pending[p["reqId"]] = p
                self.cv.notify_all()

    def pub(self, sub: str, payload: dict):
        self.m.publish(f"plant/{self.plant}/{sub}", json.dumps(payload), qos=0)

    # ---- Transport protocol ----
    def request_plan(self, req: dict) -> dict | None:
        rid = uuid.uuid4().hex[:10]
        self.pub("ems/request", {**req, "ts": req["ts"], "reqId": rid})
        deadline = time.monotonic() + 3
        with self.cv:
            while rid not in self.pending and time.monotonic() < deadline:
                self.cv.wait(0.2)
            return self.pending.pop(rid, None)

    def telemetry(self, f: dict):
        ts = iso(f["ts"])
        if "glitch" in f:
            self.pub("meter/incomer", {"ts": ts, "glitch": f["glitch"]})
            return
        for k, v in f["meters"].items():
            self.pub(f"meter/{k}", {"ts": ts, "kw": v})
        fl = f["flows"]
        self.pub("asset/solar", {"ts": ts, "kw": fl["solar"], "curtailKw": fl["curtail"]})
        self.pub("asset/bess", {"ts": ts, "soc": f["soc"], "inKw": fl["bessIn"], "outKw": fl["bessOut"]})
        self.pub("asset/genset", {"ts": ts, "kw": fl["genset"]})
        self.pub("asset/flex", {"ts": ts, "pendingKwh": f["flexPendingKwh"], "runKw": fl["flexRun"], "demandKw": f["flexGenKw"]})
        self.pub("meter/incomer", {"ts": ts, "loadKw": fl["load"], "importBySource": {k: fl[k] for k in ("green", "rtm", "dam", "discom")}, "exportKw": fl["export"],
                                   "shedKw": fl["shed"], "kva": f["kva"], "pf": f["pf"], "gridDown": f["gridDown"], "dgKw": f["dgKw"]})

    def post_entry(self, req: dict, device: str):
        body = {k: v for k, v in req.items() if not k.startswith("_") and k != "ts"}
        self.api.call("POST", "/api/v1/ledger/entries", "sim-vbw", body, idem=req["idempotencyKey"])

    def production(self, evt: dict):
        self.api.call("POST", "/api/v1/production/events", "sim-vbw", {**evt, "ts": iso(evt["ts"])})

    def device_status(self, device: str, online: bool, queued: int):
        self.pub(f"device/{device}/status", {"online": online, "queued": queued})
