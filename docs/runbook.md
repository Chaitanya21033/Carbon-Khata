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

## Without Docker

If Docker is not running, `setup.ps1` switches to **no-Docker mode** by itself (force it with `-NoDocker`):
- **Database:** `DATABASE_URL=embedded` runs real PostgreSQL 16 from the `pgserver` pip package. Its data is kept in `%LOCALAPPDATA%\CarbonKhata\pgdata`.
- **Meter data:** `MQTT_ENABLED=false` makes the simulator post the same meter topics to `POST /api/v1/ingest/messages` over HTTP, so no broker is needed.

Everything else is identical, and all tests pass in this mode. To move to Docker later, start Docker Desktop and run `setup.ps1` again.

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

## Phones on the same Wi-Fi (live capture demo)

When `dev.ps1` starts, it prints the laptop's Wi-Fi address, for example `http://192.168.1.23:5173`. The product header also has an **Open on phone** button that shows a QR code for that address.

1. **Firewall.** Easiest: run `powershell -ExecutionPolicy Bypass -File scripts\allow-phone.ps1` once. It asks for admin, marks the Wi-Fi as Private and opens ports 5173/5174. Otherwise: the first time, Windows asks whether Node.js may use the network: tick **Private networks** and click Allow. If you missed the prompt, run this once in an **administrator** PowerShell:
   ```powershell
   netsh advfirewall firewall add rule name="CarbonKhata dev" dir=in action=allow protocol=TCP localport=5173,5174 profile=private
   ```
   Also make sure the Wi-Fi is set as a *Private* network in Windows.
2. **Phone (operator).**
   1. Open the address and sign in as **Store keeper (Operator)**.
   2. Open **Capture**. You can take a photo under **Photo evidence**, or post a register entry with **Attach slip photo**.
3. **Laptop (custodian or owner).** Keep **Live plant** open. The entry animates through the data-flow diagram, and the photo appears under *Photos from the shop floor* with a toast.
4. **Where the photos go.** They are saved on the laptop in `captures\<date>\HHMMSS_<kind>_<user>_<slip>.jpg`, inside the project folder. Each upload is also in the audit log. Uploading the same file twice is refused (V10).

## Field-device pages (sensors and CO₂ analysers)

Open `http://<laptop-ip>:5174/#/devices` (also linked from the demo controls). It shows one page per device: 5 sub-meters, the main incomer, the solar inverter, the battery, the genset, and 3 CO₂ analysers (genset stack, paint-oven flue, welding-bay air). You can open the pages on different phones.

Each page shows:
- the live reading and the last two hours;
- **Change the reading**: set a fixed value or add an offset, for N plant-minutes or until reset;
- **Stop reporting**: simulates a dead gateway.

Each page reads from the simulator's device API: `GET/POST /sim/devices/{id}`, `/override` and `/online`.

The product only sees what the devices report: `GET /api/v1/sensors` and `GET /api/v1/sensors/{id}`. On **Live plant** it raises alerts when:
- welding-bay CO₂ goes above 1,000 ppm;
- the genset stack analyser drifts more than 15 % from the CO₂ calculated from metered kWh;
- a device stops reporting.

Try setting welding-bay air to 1,350 ppm, or the genset stack to +40 % at night when the genset runs.

## Where every API is (from the laptop or a phone)

| What | Address |
|---|---|
| Product API docs (Swagger, try-it-out) | `http://<laptop-ip>:5173/docs`. Click **Authorize** and paste your token (Data sources → APIs & endpoints → Copy my token) |
| Product API (JSON) | `http://<laptop-ip>:5173/api/v1/...`, e.g. `/sensors`, `/live/state`, `/energy/twin`, `/passports`, `/documents`. In a browser, add `?token=<your token>` |
| Device API (no login) | `http://<laptop-ip>:5174/sim/devices`, `/sim/devices/{id}`, `POST /sim/devices/{id}/override`, `POST /sim/devices/{id}/online` |
| Device API docs | `http://<laptop-ip>:5174/sim/docs` |
| Device pages | `http://<laptop-ip>:5174/#/devices` |

The product's *Data sources* drawer lists all of these as clickable links, already signed in with your session.

If the phone shows **"This site can't be reached"**, work through these in order:
1. Open `http://<laptop-ip>:5173` **on the laptop itself**. If that fails, restart `dev.ps1`: the server must have been started after pulling this version.
2. Run `scripts\allow-phone.ps1` (firewall and Private network).
3. Office and college Wi-Fi often blocks devices from talking to each other ("client isolation"). Turn on the **phone's hotspot**, connect the laptop to it, restart `dev.ps1`, and open the new address it prints.
