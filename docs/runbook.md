# Runbook: a fresh Windows laptop to a running demo (about 15 minutes)

## 1. Install the prerequisites (about 8 minutes, one time)

| Tool | Where | Notes |
|---|---|---|
| Git for Windows | git-scm.com | Default options |
| Node.js 20 LTS | nodejs.org | Default options |
| Python 3.12 | python.org | Tick **"Add python.exe to PATH"** |
| Docker Desktop | docker.com | Use the WSL 2 backend. Start it once and wait for "Engine running" |

Open a **new** PowerShell window after installing, so the PATH is refreshed.

## 2. Get the code (1 minute)

```powershell
cd C:\dev
git clone https://github.com/Chaitanya21033/Carbon-Khata.git carbonkhata
cd carbonkhata
```

## 3. Set up (about 4 minutes, one time)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

The script does the following:
1. Checks the tools.
2. Creates `.venv` and installs the Python packages.
3. Installs the npm packages (`web`, `sim\control-panel`).
4. Copies `infra\.env.example` to `.env`.
5. Starts PostgreSQL 16 (TimescaleDB) and Mosquitto in Docker.
6. Runs the migrations.
7. Loads the demo data (about 2 seconds).

## 4. Run (30 seconds)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 -Demo
```

| What | URL |
|---|---|
| Product | http://localhost:5173 |
| Demo controls (open on a second screen) | http://localhost:5174 |
| API docs | http://localhost:8000/docs |

On the first start the simulator replays the previous 24 hours through MQTT and REST (10–20 s), so every chart opens full. Logs from all four processes appear in the same window, colour-coded. Press **Ctrl+C** to stop everything.

## 5. Sign in

Pick a demo account on the sign-in screen and press **Send code**. In dev mode the code is printed in the `[api]` log and shown on the screen, so you can press **Fill dev code** and then **Verify**.

| Account | Role | Sees |
|---|---|---|
| ramesh@vardhan.example | Operator | Capture, live plant |
| priya@vardhan.example | ESG custodian | Everything for Vardhan Body Works |
| owner@vardhan.example | Owner | Same as custodian. Approves or reopens month close |
| esg@oem-a.example, -b, -c | OEM viewer | Only its own parts and files. OEM C gets the CBAM-style file |
| meena@annapurna.example | Co-packer QC & ESG | Batch tracing, recall, cluster |
| quality@brand-a.example, brand-b | Brand viewer | Only its own brand's batches |
| coordinator@adityapur.example | Cluster coordinator | Cluster pool, exchanges, scoreboard |
| ops@carbonkhata.example | Platform admin | Onboarding pipeline, DQ centre, factor library, audit log, support view |

## Everyday tasks

| Task | Command |
|---|---|
| Run all tests (pytest + vitest) | `powershell -ExecutionPolicy Bypass -File scripts\test.ps1` |
| Reload the demo data (wipes the DB) | `powershell -ExecutionPolicy Bypass -File scripts\seed.ps1` |
| Product only, no simulator (real devices) | `scripts\dev.ps1 -NoSim` |
| Stop Docker services | `docker compose -f infra\docker-compose.yml down` (add `-v` to delete the database volume) |

## Keys and integrations (`.env`)

| Variable | Effect |
|---|---|
| `ELECTRICITYMAPS_API_KEY` | Live grid carbon. Without it the drawer shows "needs key" and the CEA factor is used |
| `SMART_METER_API_URL` / `SMART_METER_API_KEY` | Pull register readings from a head-end system. Without them the MQTT feed is used |
| `IEX_API_URL` / `IEX_API_KEY` | A licensed market-data feed. Without them the mock replays the 96-block shape |
| `KYB_API_URL` / `KYB_API_KEY` | GSTIN/Udyam lookup. Without them only the format is checked |
| `SMTP_URL` | E-mail OTP codes. Set `OTP_DEV_ECHO=false` for real use |
| `JWT_SECRET`, `DEVICE_KEYS` | **Change these** for any shared deployment |
| `DEMO_RESET_ENABLED=false` | Disables the demo reset route |

Open-Meteo (solar forecast) needs no key. On a laptop with internet it shows **live**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `setup.ps1` says Docker is not running | Start Docker Desktop and wait for "Engine running" |
| Port 5432 or 1883 already in use | Stop the other PostgreSQL or Mosquitto, or change the ports in `infra\docker-compose.yml` and `.env` |
| "Cannot reach the CarbonKhata server" on sign-in | The API is not running: check the `[api]` lines in the `dev.ps1` window |
| Live plant shows "Waiting for the plant's live feed" | The simulator is not running (`dev.ps1` without `-NoSim`), or Mosquitto is down |
| Scripts blocked by execution policy | Use `powershell -ExecutionPolicy Bypass -File …` as shown |
| Start over completely | `docker compose -f infra\docker-compose.yml down -v`, then `scripts\setup.ps1` |
