# CarbonKhata

A supplier-side ESG and energy platform for Indian MSME manufacturers. All companies and figures in this repository are **fictional demo data**.

- **Measure.** Paper registers, smart-meter feeds and electricity bills become one checked ledger:
  - rules V01–V12 run on every entry;
  - corrections are made by reversal, never by editing;
  - months are closed by the owner.
- **Report.**
  - Scope 1 and 2 emissions from versioned factors.
  - A carbon passport per part for each OEM, including a CBAM-style file for the exporting OEM.
  - BRSR Principle 6 indicators, a PACT-style product carbon footprint, and a lender pack.
- **Optimise.**
  - Every 15 minutes the EMS dispatches across exchange prices, the DISCOM time-of-day tariff, rooftop solar, the battery, the gas genset and flexible loads.
  - Results are compared with a no-optimiser twin; an optional LP optimiser is available.
- **Monetise.**
  - Solar carbon-credit vintages, with a guard against double counting between credits and OEM claims.
- **FMCG.** Batch tracing for a co-packer:
  - QC release gate, ingredient lots, a public QR page per pack, and one-click recall.
- **Cluster.** A Kalundborg-style industrial cluster:
  - an energy pool bought through one licensed trader, with deviation netting;
  - a resource exchange with paired sender and receiver lines;
  - a scoreboard and a split of savings and carbon claims.

## Quick start (Windows)

You need Git, Node.js 20, Python 3.12 and Docker Desktop. Then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 -Demo
```

| What | Address |
|---|---|
| Product | http://localhost:5173 |
| Demo controls (separate app) | http://localhost:5174 |
| API docs | http://localhost:8000/docs |

Tests: `scripts\test.ps1`. Step-by-step setup is in **[docs/runbook.md](docs/runbook.md)**.

## Repository layout

| Folder | What |
|---|---|
| `api/` | Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Pydantic v2. Domain logic (`app/domain`), live twin and MQTT ingestion (`app/live`), services, routers, seed, tests |
| `web/` | React 18, Vite and TypeScript product UI, using TanStack Query and Server-Sent Events |
| `sim/` | Plant simulator service (MQTT and REST, like real devices) and the demo-control panel (`sim/control-panel`) |
| `demo_data/` | Dummy-data generators for the FMCG line and the cluster members (simulator and seed only) |
| `infra/` | `docker-compose.yml` (PostgreSQL 16 / TimescaleDB, Mosquitto) and `.env.example` |
| `scripts/` | `setup.ps1`, `dev.ps1`, `seed.ps1`, `test.ps1` |
| `docs/` | [architecture](docs/architecture.md), [API](docs/api.md), [runbook](docs/runbook.md), [decisions](docs/decisions.md), [demo script](docs/demo-script.md), [plan](docs/plan.md) |
| `reference/` | The original client-side prototype (the functional spec). Its 38 tests still pass |

## Tests

| Suite | What it covers |
|---|---|
| `api/tests/domain` | All the reference domain tests (acceptance, FMCG, cluster), plus a golden check that the seed matches the prototype line by line |
| `api/tests/integration` | EMS and simulator tests: the seeded day gives −19.2 % cost, −66.2 % evening import and a 380 kW peak, exactly as the prototype did |
| `api/tests/api` | OTP auth, roles, tenancy (OEM A cannot see OEM B), idempotency, reversal, month close, held entries, factor versioning, public pages, FMCG recall, cluster mismatch, append-only audit |
| `api/tests/test_separation.py` | The product never imports simulator code or demo controls |
| `sim/tests` | The simulator |
| `web/src/__tests__` | vitest |
