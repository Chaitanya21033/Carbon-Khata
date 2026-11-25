# CarbonKhata architecture

## Processes

```
          ┌──────────── sim/ (separate process; demo only) ──────────────┐
          │ plant model (stations, loads, people, site controller),       │
          │ Annapurna line MES + QC lab, cluster member meters,           │
          │ market / DISCOM event feed, control API :5175                 │
          └──┬──────────────────────┬──────────────────────┬─────────────┘
             │ MQTT meter frames     │ REST + device key      │ MQTT setpoints
             ▼                       ▼ + Idempotency-Key      ▲
   Mosquitto :1883 ──────────► api/ (FastAPI :8000) ──────────┘
                                │ ingestion → live checks → ledger → emissions
                                │ EMS block loop + naive twin, passports, credits,
                                │ FMCG release gate + recall, cluster pool + exchanges
                                │ APScheduler, integrations (adapters), audit, SSE
                                ▼
                     PostgreSQL 16 + TimescaleDB :5432
                                ▲
   web/ (React + Vite :5173) ───┘  product UI: TanStack Query + Server-Sent Events
   sim/control-panel (:5174)  ──►  simulator control API only (never the product API)
```

| Piece | Folder | Notes |
|---|---|---|
| Product API | `api/app` | `routers/core.py` (auth, workspace, ledger, periods, validation, capture, sharing, onboarding, admin) and `routers/ops.py` (live, energy, reports, public, credits, FMCG, cluster, feeds) |
| Domain logic | `api/app/domain` | Pure Python ports of the prototype: `ledger`, `validation` (V01–V12), `emissions`, `measures`, `exports` (OEM file, BRSR P6, PCF, CBAM-style, lender pack), `grid` (market model, EMS brain, naive twin), `fmcg`, `cluster`, `live_checks`, `synth` + `seed` (bit-exact dummy history) |
| Live twin | `api/app/live` | `registry.py` consumes MQTT, answers EMS plan requests and persists intervals, decisions and passports. `twin.py` builds the plant's live state from the feeds |
| Services | `api/app/services` | `ledger.py` (posting, idempotency, holds, corrections, close, cached derived figures), `integrations.py` (adapters), `lp.py` (optional PuLP optimiser), `jobs.py` (APScheduler) |
| Simulator | `sim/simulator` | `engine.py` (the plant and its people), `site.py` (site controller physics), `feeds.py` (FMCG MES, cluster meters), `transport.py` (MQTT + REST), `service.py` (clock + control API) |
| Dummy-data generators | `demo_data/` | FMCG batch facts and cluster member loads. Used by the simulator and by the seed back-fill only (a test enforces this) |
| Web | `web/src` | Prototype screens and design system, fed by `state/store.tsx` (workspace + actions over REST) and `live/LiveProvider.tsx` (snapshot + SSE) |

## Data flow for one meter minute

1. The site controller (the simulator) publishes `plant/vbw/meter/{comp,weld,paint,light,util}`, `asset/{solar,bess,genset,flex}` and then `meter/incomer`, which closes the minute.
2. `registry._handle` assembles the frame. `PlantTwin.telemetry` then:
   - does the EMS accounting and the naive twin;
   - attributes energy to the bodies on the line;
   - raises alerts (V06 demand, compressor idle draw);
   - emits a data-flow packet over SSE.
3. Every 15 minutes the interval kWh per meter is written to `meter_reading`. Every hour the roll-ups (grid import, solar, green open access, export, genset gas) are posted to the ledger with idempotency keys `mtr-{register}-{ts}`.
4. At each block boundary the controller publishes `ems/request`. The API closes the previous block (writing `ems_decision`), runs `EmsBrain.decide` and replies on `ems/setpoint`.

## Data flow for one shop-floor entry

`POST /api/v1/ledger/entries` (with an Idempotency-Key):
1. A repeated key returns `duplicate`.
2. Locked months are refused.
3. A full register gets its opening carried forward.
4. The live checks run: V12 (negative stock), V01 (more than 5× a typical entry), V10 (slip already used).
5. A failing entry is stored with `status = held` and never reaches emissions, passports or reports until someone decides it at `POST /validation/held/{id}/decide` (fix, confirm or reject).
6. History issues (V01–V12 over months) are recomputed from the ledger. Lines with an open blocking issue are excluded from the report index (`repIdx`).

## Tenancy and roles

Every tenant-owned row carries `tenant_id`. `security.plant_tenant_for` decides whose plant data a caller may read:

| Caller | Can read |
|---|---|
| Plant roles | Their own plant only |
| OEM | Suppliers that granted consent (`oem_supplier_link`). Passports are filtered to the OEM's own `oem_code` |
| FMCG brand | Batches of its own brand only |
| Cluster coordinator | Cluster aggregates. No plant ledger routes |
| Admin | Everything (support), including a read-only, audited session as owner |
| Device | Its own tenant's feeds |

## Time

Plant logic (blocks, shifts, ToD tariff) uses plant-local time (IST). On the wire and in the database, timestamps are ISO-8601 with `+05:30` or UTC. Inside the twin and EMS, plant time is kept as "IST wall clock in milliseconds", as the prototype did, so the ported maths is identical. The API's plant clock follows the telemetry, so a simulator running at 60× drives the 15-minute EMS cycle. A real plant drives it at wall-clock speed, and an APScheduler job covers sites whose controller only pulls.

## Persistence

All schema is in Alembic (`api/alembic/versions/0001_initial_schema.py`). The migration also:
- installs an append-only trigger on `audit_event`. Each row is also hash-chained (`GET /audit/verify`);
- turns `meter_reading` into a TimescaleDB hypertable when the extension is present.

The twin's working state is saved to `plant_state` every 15 s and restored on restart. Decisions, passports, held entries and intervals are rows in their own tables.
