# CarbonKhata API reference

Base URL: `http://localhost:8000` · interactive docs (OpenAPI / Swagger) at **/docs** · all product routes under `/api/v1`.

**Auth.** Users: `POST /api/v1/auth/otp/request` → `POST /api/v1/auth/otp/verify` → `Authorization: Bearer <JWT>`. Devices (meter gateways, MES, feeds, the simulator): `X-Device-Key: <key>` (see `DEVICE_KEYS` in .env). SSE: `GET /api/v1/stream?token=<JWT>`.

**Idempotency.** `POST /api/v1/ledger/entries` accepts an `Idempotency-Key` header (or `idempotencyKey` in the body). The same key twice returns `{"result": "duplicate"}` and the original entry; nothing is posted twice. Production, batch, pool and weighbridge feeds are idempotent on their natural keys.

**Roles.** operator · custodian · owner · oem (vehicle OEM or FMCG brand) · cluster (coordinator) · admin. Every route checks role and tenant in the API (`app/security.py`), not only in the UI.

**MQTT topics** (broker `localhost:1883`): `plant/{plantId}/meter/{meterId}` (1-minute readings; `incomer` closes the frame), `plant/{plantId}/asset/{solar|bess|genset|flex}`, `plant/{plantId}/ems/request` → `plant/{plantId}/ems/setpoint`, `plant/{plantId}/ems/replan`, `plant/{plantId}/device/{deviceId}/status`.

## Auth

| Method | Path | What it does |
|---|---|---|
| POST | `/api/v1/auth/otp/request` | Otp Request |
| POST | `/api/v1/auth/otp/verify` | Otp Verify |
| GET | `/api/v1/auth/demo-users` | Persona list for the sign-in role picker (fictional demo accounts). |
| GET | `/api/v1/me` | Me |
| POST | `/api/v1/auth/support-session` | Read-only support view as the demo plant's owner (30 minutes, audited). |

## Workspace

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/workspace` | Everything the plant screens need, computed server-side from the ledger (role-filtered). |

## Ledger

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/registers` | Registers |
| GET | `/api/v1/ledger/entries` | List Entries |
| POST | `/api/v1/ledger/entries` | Post an entry. Send an Idempotency-Key (header or body): the same key twice posts once (offline sync). |
| POST | `/api/v1/ledger/entries/{entry_id}/reverse` | Reverse Entry |
| POST | `/api/v1/ledger/lines/correct` | Correct Line |
| GET | `/api/v1/ledger/stock` | Ledger Stock |
| GET | `/api/v1/ledger/export.csv` | Ledger Csv |

## Periods

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/periods` | Periods |
| POST | `/api/v1/periods/{month}/close` | action: submit (custodian) | approve / close | return | reopen (owner, reason required). |

## Validation

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/validation/queue` | Validation Queue |
| POST | `/api/v1/validation/issues/{issue_id}/decide` | Decide Issue |
| POST | `/api/v1/validation/issues/bulk-accept` | Bulk Accept |
| POST | `/api/v1/validation/held/{entry_id}/decide` | A held entry (V01, V10, V12…) reaches emissions only after it is fixed or confirmed here. |
| POST | `/api/v1/validation/meter-glitch/{item_id}/decide` | Decide Glitch |

## Capture

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/meters` | Meters |
| GET | `/api/v1/meters/{meter_id}/latest` | Latest cumulative register from the smart-meter feed (HES pull if configured, else the live feed). |
| POST | `/api/v1/meters/{meter_id}/readings` | A register reading (smart-meter API pull, or typed by hand). Non-monotonic readings are flagged V11. |
| POST | `/api/v1/bills` | Electricity bill → ledger reading lines (GRID_KWH, GRID_KVAH, PF, MD_KVA, BILL_INR) with checks. |
| POST | `/api/v1/documents` | Upload Document |
| POST | `/api/v1/documents/{doc_id}/read` | Structured fields for an uploaded bill. With smart meters the energy figures come from the meter feed; the bill |

## Live

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/live/state` | Live State |
| GET | `/api/v1/stream` | Server-Sent Events: twin snapshots, data-flow packets, ledger changes, EMS decisions, passports, batches, cluster. |
| POST | `/api/v1/production/events` | Line events (body started / moved station / finished). Idempotent on (serial, kind, station). |

## Energy

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/energy/market` | 96 fifteen-minute blocks: DAM, G-DAM, RTM, DISCOM ToD tariff, regional net demand, marginal EF, stress. |
| GET | `/api/v1/energy/forecast` | Energy Forecast |
| GET | `/api/v1/energy/grid-intensity` | Grid Intensity |
| GET | `/api/v1/energy/plan` | Energy Plan |
| GET | `/api/v1/energy/decisions` | Energy Decisions |
| GET | `/api/v1/energy/twin` | Optimised plant vs the naive twin (same load, no optimiser): today and the rolling last 24 h. |
| GET | `/api/v1/energy/settings` | Get Settings |
| PUT | `/api/v1/energy/settings` | Put Settings |
| POST | `/api/v1/energy/market/events` | Feed events from the market-data / DISCOM adapters: RTM price spike, RTM uplift under cloud, demand-response call. |
| GET | `/api/v1/energy/compare-lp` | Day-ahead linear programme (PuLP/CBC) on yesterday's metered load and solar, vs the rule-based dispatch actually run. |

## Reports

| Method | Path | What it does |
|---|---|---|
| PATCH | `/api/v1/measures/{code}` | Set Measure |
| GET | `/api/v1/measures` | Get Measures |
| POST | `/api/v1/exports/log` | Log Export |
| GET | `/api/v1/emissions/summary` | period: YYYY-MM, 'FY2025' (Apr 2025–Mar 2026) or omitted for the last 12 months. Held lines are excluded. |
| GET | `/api/v1/passports` | Per-part carbon passports. An OEM sees only its own parts from suppliers that granted access. |
| GET | `/api/v1/passports/{serial}` | Passport |
| GET | `/api/v1/reports/oem/{oem}` | OEM supplier file (json | csv | passports | cbam). Built from the ledger and the passports issued to that OEM. |
| GET | `/api/v1/reports/brsr/p6` | BRSR Principle 6 indicators for a financial year (default: the last 12 closed-or-open history months). |
| GET | `/api/v1/reports/pcf` | Pcf |
| GET | `/api/v1/reports/lender-pack` | Lender |

## Public

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/public/part/{code}` | Public Part |
| GET | `/api/v1/public/batch/{code}` | Public Batch |

## Credits

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/credits/vintages` | Monthly solar vintages: net tonnes = solar kWh × grid EF × (1 − 10 % buffer), split credits / OEM claim. |
| PUT | `/api/v1/credits/allocation` | Credits share + OEM-claim share always sum to 1 (double-counting guard). |
| PUT | `/api/v1/credits/price` | Set Price |
| POST | `/api/v1/credits/verify` | Submit a vintage: submitted → validated → verified → issued (demo verifier/registry adapter, a few seconds apart). |
| POST | `/api/v1/credits/transfer` | Transfer |

## Fmcg

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/fmcg/batches` | Batches |
| POST | `/api/v1/fmcg/batches` | Line MES reports a batch: product, slot, ingredient lots used and the QC test plan. Idempotent on code. |
| GET | `/api/v1/fmcg/lots` | Lots |
| POST | `/api/v1/fmcg/batches/{code}/tests` | QC lab / line result. A failed test holds the batch (release gate) and blocks dispatch. |
| POST | `/api/v1/fmcg/batches/{code}/tests/{name}/override` | Override Test |
| POST | `/api/v1/fmcg/recall` | Flag a lot: every finished batch that used it becomes RECALLED (traced through lot usage), packs and distributors listed. |
| GET | `/api/v1/fmcg/recall` | Recalls |
| POST | `/api/v1/fmcg/recall/notify` | Notify |
| POST | `/api/v1/fmcg/lots/{lot}/clear` | Clear Lot |

## Cluster

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/cluster/members` | Cluster Members |
| GET | `/api/v1/cluster/pool/today` | Block-by-block pool settlement for today: schedule vs actual, individual vs pooled deviation and DSM charges, cost vs going alone. |
| GET | `/api/v1/cluster/exchanges` | Cluster Exchanges |
| POST | `/api/v1/cluster/exchanges/{xid}/agree` | Agree |
| PUT | `/api/v1/cluster/exchanges/{xid}/split` | Set Split |
| POST | `/api/v1/cluster/exchange-lines/{lid}/confirm` | Both sides agree on the corrected weight: the held line becomes 'resolved' with received = sent. |
| GET | `/api/v1/cluster/scoreboard` | Year-to-date (from 1 April): sums of exchange accrual rows and daily pool settlements. |
| GET | `/api/v1/cluster/split` | Gain-sharing (₹) and carbon-claim owner per exchange: every tonne is claimed exactly once. |
| POST | `/api/v1/cluster/feed/pool` | One 15-minute block of member meter data (schedule, actual kW). Settles the block and accrues exchanges. |
| POST | `/api/v1/cluster/feed/weighbridge` | Sender and receiver weighbridge tickets for one load. >2 % apart → held as a mismatch. |
| POST | `/api/v1/cluster/feed/event` | Member notices: over-draw, join / leave, a material need, heat-exchanger trip / restore. |

## Oem

| Method | Path | What it does |
|---|---|---|
| POST | `/api/v1/sharing/consent` | Set Consent |
| POST | `/api/v1/sharing/links` | Add Share |
| POST | `/api/v1/sharing/links/{lid}/revoke` | Revoke Share |
| POST | `/api/v1/oem/requests` | Oem Request |
| POST | `/api/v1/oem/requests/{cid}/close` | Close Request |
| GET | `/api/v1/oem/suppliers` | Suppliers that granted this OEM access (real link), plus clearly-labelled sample records for the overview. |

## Onboarding

| Method | Path | What it does |
|---|---|---|
| POST | `/api/v1/onboarding/kyb/gstin` | Kyb Gstin |
| POST | `/api/v1/onboarding/kyb/udyam` | Kyb Udyam |
| POST | `/api/v1/onboarding/import/csv` | Validate a supplier's monthly sheet live (nothing is posted): rows, months, registers, V01–V12 hits, baseline. |
| GET | `/api/v1/onboarding/sample.csv` | Sample Csv |
| GET | `/api/v1/onboarding/cases` | Cases |
| POST | `/api/v1/onboarding/cases` | Add Case |
| POST | `/api/v1/onboarding/cases/{cid}/move` | Move Case |

## Admin

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/factors` | List Factors |
| POST | `/api/v1/factors` | New factor version. The previous open version is closed the day before; past months keep their factor. |
| GET | `/api/v1/rules` | Rules |
| GET | `/api/v1/audit` | Audit Log |
| GET | `/api/v1/audit/verify` | Re-walk the hash chain. Any edited or deleted row breaks it. |
| GET | `/api/v1/sources` | Sources |
| GET | `/api/v1/admin/overview` | Admin Overview |

## Ops

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Health |
