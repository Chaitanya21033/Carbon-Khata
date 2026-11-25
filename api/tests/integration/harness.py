"""In-process wiring of the simulator (site + plant) to the API's product logic (twin, EMS, live checks),
with an in-memory ledger standing in for the database. Same code paths as MQTT/REST, minus the network."""
from app.domain.live_checks import check
from app.domain.seed import registers
from app.live.twin import PlantTwin
from simulator.engine import SimEngine

REGS = {r.id: {"mode": r.mode, "typical": r.typical} for r in registers()}


class Harness:
    def __init__(self, start, stock, enabled=True):
        self.posted, self.held, self.docs = [], [], set()
        self.stock = dict(stock)
        self.twin = PlantTwin("vbw", 450, post_ledger=self._post_rollup)
        self.twin.ems.settings.enabled = enabled
        self.e = SimEngine(start, self, stock=stock)

    # transport protocol
    def request_plan(self, req): return self.twin.request_plan(req)
    def telemetry(self, f): self.twin.telemetry(f)
    def production(self, evt): self.twin.production(evt)
    def device_status(self, *a): pass

    def post_entry(self, req, device):
        if any(p["idempotencyKey"] == req["idempotencyKey"] for p in self.posted):
            return
        flag = check(req, REGS.get(req["registerId"]), self.stock.get(req["registerId"], 0), req["docRef"] in self.docs)
        if flag:
            self.held.append({**req, **flag})
            return
        self._commit(req)

    def _commit(self, req):
        self.posted.append(req)
        self.docs.add(req["docRef"])
        r = req["registerId"]
        if REGS.get(r, {}).get("mode") == "full":
            self.stock[r] = self.stock.get(r, 0) + (req["qty"] if req["line"] == "received" else -req["qty"] if req["line"] == "issued" else 0)

    def _post_rollup(self, req):
        self._commit(req)

    def resolve(self, rule, action, value=None):
        h = next(x for x in self.held if x["rule"] == rule)
        self.held.remove(h)
        qty = value if value is not None else h.get("suggested", h["qty"]) if action == "fix" else h["qty"]
        self._commit({**h, "qty": qty, "idempotencyKey": h["idempotencyKey"] + "-fix", "docRef": h["docRef"] + ("-R" if rule == "V10" else "")})

    def run(self, minutes):
        for _ in range(minutes):
            self.e.step()
        return self
