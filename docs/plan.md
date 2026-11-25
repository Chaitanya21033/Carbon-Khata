# CarbonKhata: build plan (for approval)

Status: **draft, waiting for approval**. No product code has been written yet.

## 0. What I read and checked

The repository root currently *is* the prototype (the zip contents), not a `reference/` folder.

| Area | Files | Notes |
|---|---|---|
| Seed libraries | `src/data/register_types.json`, `emission_factors.json`, `validation_rules.json` | 24 register types, 8 factors (v1), rules V01–V12 + DQ score weights |
| Domain | `src/domain/ledger.ts`, `validation.ts`, `emissions.ts`, `measures.ts`, `exports.ts`, `fmcg.ts`, `seed.ts`, `synth.ts`, `samples.ts`, `util.ts`, `types.ts` | Pure functions; deterministic seeded RNG (mulberry32); 24 months of history with planted errors |
| Simulator | `src/sim/engine.ts` (plant, minute steps), `grid.ts` (market + EMS + naive twin), `cluster.ts` (pool, exchanges, scoreboard), `bus.ts` | EMS physics and accounting run per simulated minute |
| UI | `src/screens/*` (13 screens), `src/ui/*`, `src/styles.css`, `src/i18n.ts`, `src/App.tsx` | Role-based nav (6 roles), dark mode, Hindi labels, mobile bottom nav |
| Demo-only UI | `src/sim/ControlPanel.tsx`, `SimProvider.tsx`, `Pipeline.tsx` | Controls go to the simulator app; `Pipeline` (data-flow canvas) stays in the product |
| Tests | 5 files | **38 tests, all passing** (`npx vitest run`, 0.7 s). The README says 35; the true count is 38. |

Numbers from the reference on the seeded day (2026-11-11, from a script I ran against `SimEngine`):

| Metric | Optimiser ON | Naive twin | Change |
|---|---|---|---|
| Day cost | ₹26,579 | ₹32,880 | **−19.2 %** |
| Evening (18–22 h) import | 446 kWh | 1,322 kWh | **−66.2 %** |
| Peak import | 380 kW | 513 kW | at the cap |
| Export | 132 kWh | 0 | |

These become the regression targets for the Python port.

## 1. Where the reference and the brief disagree (I need answers)

Each item has my recommended default. If you approve the plan without comment, I'll use the defaults.

1. **Reference location.** The brief says `reference/`; the repo has the files at the root. *Default:* `git mv` everything into `reference/` (kept runnable with `npm test`), then build `web/`, `api/` and `sim/` alongside it.
2. **"Double-entry" ledger.** The reference ledger is a *quantity register* ledger: signed lines (opening/received/issued/closing/reading/adjustment), with corrections done as reversal plus a new entry. It is not debit/credit accounting. *Default:* keep the reference semantics exactly so the tests port 1:1. Store a derived `direction` (`in` / `out` / `stock` / `reading`) on each line. Use true paired debit/credit lines only where two parties exist: cluster exchange sender/receiver and credit-vs-OEM allocation. The alternative is full debit/credit pairs (e.g. Stores ↔ Consumption) on every line, which changes every query and every ported test.
3. **Steel factor.** The factor library has `EF_STEEL_IN_REF` = 2,200 kg/t (2.2). The brief and the simulator use 2.3 kg/kg for OEM A/B and 1.55 for OEM C. *Default:* keep both. The library value is the generic Scope 3 reference. The passport uses an OEM-specific steel factor (`oem_steel_factor`, versioned, with source "BF-BOF India average" / "mill-certified"), as the reference engine does.
4. **Plant clock and timezone.** The reference engine, grid and cluster treat **UTC hours as plant-local hours**, while FMCG uses real IST (+5:30). *Default:* the DB stores UTC `timestamptz`, and all block, shift and tariff logic runs in `Asia/Kolkata`. The ported tests shift their start times by 5 h 30 min so they reproduce the same curves, and the numbers in §0 stay the targets.
5. **"EMS every 15 minutes" vs a 60× simulator.** A wall-clock APScheduler job cannot keep up with a simulator running an hour per second. *Default:* the API has a **plant clock**. In production it is wall time. When telemetry is ahead of wall time (simulated plant), block boundaries are driven by telemetry timestamps. The product code is identical in both cases; only the clock source differs, chosen by the timestamps that arrive. APScheduler still runs the wall-clock jobs (market/weather fetch, month close reminders, credit roll-up).
6. **Where EMS physics lives.** The reference couples the decision (`Ems.decide`) with the asset physics (battery SoC, flow balance) and the accounting (`Ems.minute`). *Default:*
   - `api/ems`: decision, naive twin and accounting.
   - `sim`: the physical assets. It receives setpoints over MQTT (`plant/{id}/ems/setpoint`) and reports metered flows and SoC back.
   - A real site would put a PLC or inverter controller in place of the simulator.
   - An in-process integration test wires both sides together to hit the §0 numbers.
7. **Product-side checks currently in the simulator.** `engine.check()` (live V01 "5× typical", V10 duplicate slip, V12 negative stock) runs inside the simulator. That is product logic. *Default:* move it to the API ingestion path. The simulator then sends raw data only, and a typo injected from the control panel is held by the **API**.
8. **Passports.** The reference attributes energy to each body per minute inside the simulator. *Default:* the simulator posts production events over REST (body started with OEM/PO/steel kg, station moves, body finished). The API attributes sub-meter energy to work-in-progress by station from the 1-minute readings, and issues the passport. Totals will be close to the reference but not bit-identical. Acceptance checks:
   - one passport per finished body;
   - total = S1 + S2 + steel;
   - attributed kWh ≤ metered kWh.
9. **FMCG batches.** In the reference these are a pure function of the clock. *Default:* the simulator posts batch starts, lot usage and QC results over REST, the same way a line MES or LIMS would. The API stores them, runs the release gate and runs recall. The fmcg tests port against the API logic, including "recall finds exactly the batches that used the lot".
10. **"Adityapur Green Cluster".** The reference doesn't name the cluster; it says "Jamshedpur cluster". *Default:* name the cluster entity "Adityapur Green Cluster (demo)" and keep all 13 fictional members from `cluster.ts`.
11. **Hard-coded figures in reference screens.** These conflict with "every number from the ledger":
    - `Sustain.tsx` uses a literal 0.71 and a dummy ₹/body turnover.
    - `Cluster.tsx` has a literal "≈ 2,760 t/yr".
    - `cluster.advance()` seeds year-to-date figures with constants (₹4.85 L/month pool saving, ₹61k/month penalty avoided).

    *Default:*
    - Factors are always read from the factor library.
    - Turnover becomes a seeded `financials` register (dummy).
    - The cluster year-to-date figures become seeded pool and exchange ledger history from 1 Apr 2026, so the scoreboard is a sum over ledger rows.
12. **Extra screens.** The reference has screens the brief doesn't list: OEM *Supplier overview* and *Supplier programme*, and Admin *Platform overview* and *Factor & rule libraries*. *Default:* port them too. They read the sample suppliers and cases from `samples.ts`, labelled as sample data.
13. **Rule V11 and the low-confidence AI read.** The rule params say `min_confidence: 0.85`. *Default:* below 0.85, a Claude vision read is saved as held (V11) until a person confirms or retypes it.
14. **Running here vs Windows.** I work in a Linux cloud container. It has Node 22 and Python 3.13, but no running Docker daemon and no PowerShell. *Default:*
    - I target Python 3.12 (no 3.13-only features) and Node 20 LTS.
    - I test each phase here against a local Postgres and Mosquitto.
    - I'll try to install `pwsh` to at least run the `.ps1` scripts.
    - You do the final "fresh Windows laptop" check with `docs/runbook.md`.

## 2. Architecture

```
          ┌──────────── sim/ (separate process, port 5174) ─────────────┐
          │ plant model (stations, loads, assets), market replay,       │
          │ FMCG line, cluster members, demo control panel (React)      │
          └──┬──────────────────────┬──────────────────────┬───────────┘
             │ MQTT readings         │ REST + Idempotency-Key  │ MQTT setpoints (sub)
             ▼                       ▼                         ▲
   Mosquitto (1883) ─────────► api/ (FastAPI, port 8000) ──────┘
                                │ ingestion → validation → ledger → emissions
                                │ EMS block loop, passports, credits, FMCG, cluster
                                │ APScheduler jobs, integrations (adapters), audit
                                │ SSE /api/v1/stream
                                ▼
                     Postgres 16 + TimescaleDB (5432)
                                ▲
                       web/ (React + Vite, port 5173) ── product UI, TanStack Query, SSE
```

- **Separation rule:** `sim/` talks to the API only through the public MQTT topics and the public REST endpoints, using a normal device or user token. A CI test greps `web/` and the `api/` routers for any simulator import or control route and fails if it finds one.
- **MQTT topics:**
  - `plant/{plantId}/meter/{meterId}`: 1-minute interval readings `{ts, kwh, kw, kva, pf}`.
  - `plant/{plantId}/asset/{assetId}`: solar, battery (SoC), genset flows.
  - `plant/{plantId}/ems/setpoint`: published by the API.
  - `plant/{plantId}/clock`: heartbeat.

  Messages carry a `msg_id`, and the API deduplicates on it.
- **Idempotency:** all REST writes accept an `Idempotency-Key`, stored with a unique constraint per tenant. A repeat returns the original response; this is the offline-queue rule from the reference.
- **Held data:** anything that fails a blocking rule is written as a `ledger_entry` with `status = held` plus a `validation_result`. Emissions, passports and reports filter on `status = posted`, so a held line can never leak into them.
- **SSE:** an in-process pub/sub that emits typed events (`packet`, `ledger.posted`, `validation.held`, `ems.decision`, `passport.issued`, `batch.updated`, `cluster.*`). The data-flow canvas maps event kinds to the same routes as `Pipeline.routeFor`.

## 3. Folder layout

```
carbonkhata/
  reference/                 # untouched prototype (npm test still passes)
  api/
    pyproject.toml           # fastapi, sqlalchemy 2, alembic, pydantic 2, psycopg 3, apscheduler,
                             # aiomqtt, pyjwt, httpx, anthropic, pulp (optional), pytest
    alembic/                 # migrations from day one
    app/
      main.py  config.py  db.py  deps.py (auth, tenancy)  events.py (SSE bus)  clock.py
      core/rng.py            # bit-exact mulberry32 port (Math.imul / >>> semantics)
      modules/
        auth/  tenancy/  audit/
        registers/  ledger/  validation/  emissions/  measures/  reports/
        meters/  documents/  ingestion/ (mqtt consumer, REST capture)
        production/  passports/
        energy/ (market, tariff, ems_rules, ems_opt, naive_twin, jobs)
        credits/  fmcg/  cluster/  onboarding/  integrations/ (interfaces + live + mock)
      seed/                  # port of seed.ts + synth.ts + samples, cluster, fmcg catalogues
    tests/
      domain/  (ported acceptance, fmcg, cluster, ems)  api/ (auth, tenancy, idempotency, reversal, close)
      integration/ (sim + api in-process: §0 numbers)
  sim/
    pyproject.toml
    simulator/ engine.py plant.py assets.py market_replay.py fmcg_line.py cluster_members.py
               transport.py (MQTT + REST client)  control_api.py (FastAPI, port 5175, internal)
    control-panel/           # small React app on 5174 (port of ControlPanel.tsx + same CSS)
    tests/                   # ported engine.test.ts
  web/                       # Vite React TS, ported screens + ui kit + styles.css, TanStack Query
  infra/ docker-compose.yml  mosquitto/mosquitto.conf  .env.example
  scripts/ setup.ps1 dev.ps1 seed.ps1 test.ps1
  docs/ plan.md architecture.md api.md runbook.md decisions.md demo-script.md
```

## 4. Data model (full)

Every tenant-owned table has `tenant_id` (FK `tenant`). Access checks live in one dependency (`require_scope`), and the tenancy tests call every router.

**Organisations and access**
- `tenant(id, kind[plant|oem|brand|cluster|platform], name, plant_name, gstin, udyam, contract_kva, lat, lon, tz)`
- `app_user(id, email, name, lang, active)`
- `role_assignment(user_id, tenant_id, role[operator|custodian|owner|oem|cluster|admin])`
- `oem(id = tenant)`, `oem_supplier_link(oem_id, supplier_tenant_id, consent[summary|detailed], granted_by, granted_at, revoked_at)`
- `otp_challenge(email, code_hash, expires_at, attempts)`, `refresh_token`
- `device(id, tenant_id, kind, name, token_hash, online_at)`: the simulator and real gateways authenticate as devices
- `idempotency_record(tenant_id, key, route, response_hash, response_json, created_at)`, unique `(tenant_id, key)`
- `audit_event(id, at, actor_user_id, actor_device_id, tenant_id, action, entity, entity_id, detail_json, prev_hash, hash)`: append-only and hash-chained; a DB trigger forbids UPDATE and DELETE

**Registers and ledger**
- `register_type(code, name, unit, category, factor_code, cylinder_size, per_sku, hazardous, issue_tags)`: from JSON
- `register(id, tenant_id, code, label, label_hi, unit, category, mode[full|issue_only|reading], required, conv_unit_label, conv_factor, factor_code)`
- `period(tenant_id, month, status[open|in_review|closed|reopened], reopened_count, submitted_by, approved_by)` plus `period_event` (history)
- `ledger_entry(id, tenant_id, register_id, month, line, direction, qty, unit, status[posted|held|reversed|rejected], reverses_entry_id, corrects_entry_id, reason, doc_ref, source[import|app|bill|meter|ai], idempotency_key, posted_by, posted_at, issue_tag)`
- `validation_result(id, tenant_id, rule, severity, blocks_close, register_id, month, line, entry_id, field, expected, actual, message_en, message_hi, status[open|held|confirmed|rejected|accepted|dismissed], decided_by, decided_at, note)`
- `validation_rule(code, …params json, version)`

**Factors and emissions**
- `emission_factor(id, code, activity, scope, unit, kg_per_unit, source, version, valid_from, valid_to, status)`, unique `(code, version)`, never updated. A change inserts a new version, closes `valid_to` on the old one and writes an audit event.
- `oem_steel_factor(oem_id, kg_per_kg, note, version, valid_from)`
- `emission_line(entry_id, factor_id, kg_co2e, computed_at)`: materialised for posted entries and rebuilt on reversal, so you can trace any figure to its entry and factor version

**Meters and documents**
- `meter(id, tenant_id, code, label, kind[main|sub|solar|bess|genset|flex], unit)`
- `meter_reading(meter_id, ts, kwh, kw, kva, pf, source, msg_id)`: a Timescale hypertable on `ts` (plain index fallback)
- `bill(id, tenant_id, month, kwh, kvah, pf, md_kva, amount_inr, document_id, status)`
- `document(id, tenant_id, kind[meter_photo|bill|invoice|csv], path, sha256, ai_fields_json, ai_confidence, ai_model, ai_status, confirmed_by, confirmed_at)`

**Production and passports**
- `production_order(id, tenant_id, oem_id, po, product)`
- `part_serial(id, tenant_id, serial, order_id, steel_kg, started_at, finished_at, station, public_code)`
- `production_event(id, serial_id, kind, station, ts)`
- `passport(id, serial_id, oem_id, kwh, s1_kg, s2_kg, steel_kg_co2, renewable_share, total_kg, factor_versions_json, issued_at, hash)`

**Energy**
- `market_block(date, block, dam, gdam, rtm, discom, grid_demand_gw, solar_gw, net_demand_gw, marginal_ef, stress, source)`
- `asset(id, tenant_id, kind, params_json)`: solar 250 kWp; BESS 400 kWh / 150 kW / 20 % reserve / 0.92 eff; genset 150 kW, ₹5.6, 3.3 kWh/scm; flex 60 kW
- `ems_settings(tenant_id, enabled, solver[rules|lp], carbon_price, green_cap_kw, reserve_soc)`
- `ems_decision(tenant_id, ts, block, plan_json, mode, reason, saved_inr, avoided_kg)`
- `ems_block_log(tenant_id, ts, block, supply_json, export, load, naive_import, cost, naive_cost, kg, naive_kg, peak_kw, naive_peak_kw, shifted, gas)`
- `weather_forecast(ts, ghi, cloud, source)`, `grid_intensity(ts, g_per_kwh, zone, source)`

**Credits**
- `credit_vintage(id, tenant_id, period, solar_kwh, gross_t, buffer_pct, net_t, status[monitoring|submitted|validated|verified|issued], serials, buyer)` plus `vintage_event`
- `credit_allocation(tenant_id, vintage_id, credits_share, oem_claim_share, version, set_by)`: paired lines, and they must sum to 1
- `verification_request(id, vintage_id, verifier, status, share_link_expires)`

**FMCG**
- `fmcg_product(id, tenant_id, brand_tenant_id, name, pack_g, packs, film_g, shelf_days, recipe_json, mrp)`
- `material_lot(id, tenant_id, code, material, supplier, coa, kg_co2_per_kg, flagged)`
- `batch(id, tenant_id, code, product_id, line, start, end, micro_at, status, hold_reason, output_kg, input_kg, yield_pct, kwh, lpg_kg, carbon_json, public_code, record_hash)`
- `batch_test(batch_id, stage, name, spec, value, status, by, at)`, `batch_lot_usage(batch_id, lot_id, kg)`
- `recall(id, lot_id, reason, created_by, at)`, `recall_batch(recall_id, batch_id)`
- `distributor_dispatch(batch_id, distributor, packs)`

**Cluster**
- `cluster(id, name)`, `cluster_member(cluster_id, tenant_id, type, kw, shape, err, x, y, joined_at, left_at)`
- `pool_schedule(cluster_id, member_id, date, block, kw)`, `pool_actual(…, kw)`, `pool_settlement(date, block, sched, actual, indiv_dev, pooled_dev, indiv_pen, pooled_pen, pooled_cost, solo_cost, solar)`
- `exchange_agreement(id, cluster_id, from_member, to_members[], kind, what, unit, qty_per_month, inr_per_month, tco2_per_month, sender_share, claim_owner, status[proposed|agreed|paused])`
- `exchange_line(id, agreement_id, sender_entry_id, receiver_entry_id, sent_qty, received_qty, status[matched|held|corrected], t)`: each line posts a paired `ledger_entry` in the sender tenant and in the receiver tenant
- `exchange_need(cluster_id, member_id, what, qty)`: e.g. "foundry short of scrap"

**Onboarding**
- `onboarding_case(id, supplier_name, cluster, sponsor, associate, stage, stage_entered_at, sample)`, `kyb_check(case_id, kind, input, result_json, source)`, `csv_import(id, case_id, rows, issues_json)`

## 5. API (`/api/v1`, OpenAPI at `/docs`)

| Group | Endpoints |
|---|---|
| Auth | `POST auth/otp/request`, `POST auth/otp/verify` → access JWT (15 min) + refresh, `POST auth/refresh`, `GET me` (roles, tenants) |
| Registers & ledger | `GET registers`, `GET ledger/entries?register=&month=`, `POST ledger/entries` (Idempotency-Key), `POST ledger/entries/{id}/reverse` (reason required), `POST ledger/lines/correct` (reverse + new), `GET ledger/history`, `GET ledger/export.csv` |
| Periods | `GET periods`, `POST periods/{month}/submit`, `POST periods/{month}/close` (blocked by `blocks_close` results), `POST periods/{month}/reopen` |
| Validation | `GET validation/queue`, `POST validation/{id}/decide` (confirm / reject / fix / accept / dismiss), `GET validation/dq?month=` |
| Capture | `POST meters/{id}/readings`, `GET meters`, `POST bills`, `POST documents` (upload), `POST documents/{id}/read` (AI), `POST documents/{id}/confirm` |
| Emissions & reports | `GET emissions/summary?period=`, `GET emissions/monthly`, `GET measures`, `GET passports?oem=`, `GET passports/{serial}`, `GET reports/oem/{oem}` (json/csv/CBAM), `GET reports/brsr/p6?fy=`, `GET reports/passport-pcf`, `GET reports/lender-pack` |
| Energy | `GET energy/market?date=`, `GET energy/forecast`, `GET energy/plan`, `GET energy/decisions`, `GET energy/twin?date=`, `GET/PUT energy/settings`, `GET energy/grid-intensity` |
| Credits | `GET credits/vintages`, `PUT credits/allocation`, `POST credits/verify`, `POST credits/vintages/{id}/advance` |
| FMCG | `GET/POST fmcg/batches`, `POST fmcg/batches/{id}/tests`, `POST fmcg/batches/{id}/lots`, `GET fmcg/lots`, `POST fmcg/recall`, `GET fmcg/recall/{id}` |
| Production (devices/MES) | `POST production/events`, `POST fmcg/events` |
| Public (no login) | `GET public/batch/{code}`, `GET public/part/{code}`: whitelisted fields only |
| Cluster | `GET cluster/members`, `GET cluster/pool/today`, `GET cluster/exchanges`, `GET cluster/proposals`, `POST cluster/exchanges/{id}/agree`, `PUT cluster/exchanges/{id}/split`, `POST cluster/exchange-lines/{id}/confirm`, `GET cluster/scoreboard`, `GET cluster/split` |
| Onboarding | `POST onboarding/kyb/gstin`, `POST onboarding/kyb/udyam`, `POST onboarding/import/csv` (streamed row-by-row validation), `GET onboarding/cases` |
| Admin | `GET/POST factors` (new version), `GET rules`, `GET audit`, `GET sources` (integration status) |
| Live | `GET stream` (SSE; token in query for EventSource) |

## 6. Porting strategy

- **Bit-exact seed.** `core/rng.py` ports mulberry32 and the Box–Muller `normal()` with 32-bit masking. I'll also write a JS-compatible `to_fixed`, because Python's `round()` rounds half to even and JS `toFixed` behaves differently. A golden test compares the Python seed's ledger lines with a JSON dump generated from `reference/` (`synthHistory()` output). The planted months then line up exactly, and T1–T11 port unchanged.
- **38 tests mapped:**
  - acceptance 19 → `api/tests/domain/test_acceptance.py`
  - fmcg 5 → `api/tests/domain/test_fmcg.py`
  - cluster 3 → `api/tests/domain/test_cluster.py`
  - ems 7 → `tests/integration/test_ems.py` (api EMS + sim physics in-process)
  - engine 4 → `sim/tests/test_engine.py` plus integration (the held typo/negative/duplicate checks now assert on the API's quarantine)

  Test names keep the reference IDs (T1…T11 etc.) so the mapping is traceable in `docs/decisions.md`.
- **EMS:** first a 1:1 port of `Ems.decide` and the accounting, which must reproduce 19.2 % / −66.2 % / 380 kW within ±0.5 pp. Then an optional PuLP model behind `ems_settings.solver = lp`: a 96-block LP over buy source, battery and genset with import/export caps and SoC bounds. It is compared side by side on the Energy screen and in a test (LP cost ≤ rules cost).
- **UI:** copy `styles.css`, `ui/*` and `i18n.ts` verbatim. Screens keep their JSX structure; each `useStore()` read becomes a TanStack Query hook. Each screen gets explicit `<Loading/>`, `<Empty/>` and `<ErrorState/>` from the kit. `Pipeline.tsx` keeps its canvas maths and is fed by SSE `packet` events.

## 7. Phases and acceptance

Each phase ends with me running it here, then a message saying how to run it on Windows and what to check.

**Phase 1: Foundation**
- Build: move the reference into `reference/`, scaffold the monorepo, `docker-compose` (TimescaleDB pg16 + Mosquitto), Alembic baseline, the seed (bit-exact), OTP auth + JWT + roles, tenancy dependency, audit log, and the ledger, validation, emissions and measures modules.
- Screens on the real API: Sign-in, Capture & checks, Registers, Data-quality queue.
- Scripts: `setup.ps1`, `dev.ps1`, `seed.ps1`, `test.ps1`.
- Checks:
  - the 19 acceptance tests pass in pytest;
  - API tests for OTP login, OEM A ≠ OEM B, same key twice = one entry, reversal + reason, close blocked by open V05/V12 and allowed after a decision;
  - a held entry is absent from `emissions/summary`;
  - a factor change creates v2 and past months still show v1.

**Phase 2: Live plant**
- Build: Python simulator (port of `engine.ts`), MQTT ingestion, REST device posts with idempotency, API-side live checks (V01/V10/V12/V11), SSE, the Live plant screen with the data-flow canvas, and the separate control-panel app on 5174.
- Checks:
  - the 4 engine tests pass;
  - offline toggle → queued → reconnect posts exactly once;
  - a typo injected from the panel shows up held in the product queue;
  - no control is reachable from 5173 or the API.

**Phase 3: Reports**
- Build: production events → passports per OEM; OEM files (JSON/CSV) plus a CBAM-style file for OEM C; BRSR P6; public QR pages for parts; onboarding wizard with KYB mocks and live CSV import.
- Checks:
  - OEM A login sees only OEM A passports (API 403 otherwise);
  - passport total = S1 + S2 + steel;
  - BRSR P6 numbers equal `reports.brsr` computed from the ledger;
  - a QR page works on a phone without login and shows public fields only.

**Phase 4: Energy + Credits**
- Build: market adapter (IEX mock replaying `marketDay`), Open-Meteo live + mock, EMS block loop, decision log, naive twin, setpoints over MQTT, the Energy screen, and the PuLP option; credit vintages, allocation, verify pipeline, Credits & BRSR screen.
- Checks:
  - the 7 ems tests pass;
  - the seeded day gives ≈19 % saving, ≈−66 % evening import and peak ≤ 380 kW;
  - credits = solar kWh × 0.71 × 0.9;
  - credit share + OEM claim share = 100 %, and credited tonnes leave the OEM renewable share.

**Phase 5: FMCG + Cluster**
- Build: batches, tests, release gate, lots, recall, public batch QR (Annapurna Foods, Brand A/B); cluster pool (schedule, actuals, deviation netting, hedge, trader margin, shared solar), exchanges with paired lines and held mismatches, scoreboard and split, all cluster control events.
- Checks:
  - the 5 fmcg and 3 cluster tests pass;
  - recall finds exactly the batches that used the lot;
  - pooled deviation < 0.6 × the sum of individual deviations;
  - a weighbridge mismatch is held until both sides confirm;
  - the coordinator sees aggregates only.

**Phase 6: Hardening**
- Build: Claude vision for meter and bill reads (`ANTHROPIC_API_KEY`, "AI read, please confirm", V11 below 0.85), Electricity Maps live key, audit-log screen, Data-sources drawer showing live / simulated / needs key / adapter only, docs (`architecture`, `api`, `runbook`, `decisions`, `demo-script`), `dev.ps1 -Demo` one-command demo, empty/loading/error audit on every screen.
- Checks:
  - the runbook takes a fresh Windows laptop to a running demo in under 15 minutes;
  - `.env.example` lists every variable;
  - a secret scan of the repo is clean.

## 8. Dummy data that I will add (in the same style)

- **Users** (domain `.example`, nothing real):
  - Ramesh (operator), Priya (custodian), plant owner, all at Vardhan Body Works;
  - OEM A / B / C viewers;
  - Brand A Foods / Brand B Nutrition viewers;
  - Annapurna Foods custodian;
  - cluster coordinator (Adityapur Green Cluster);
  - platform admin.
- **Cluster:** history from 1 Apr 2026 (pool settlements and exchange lines), so the year-to-date scoreboard comes from ledger rows instead of constants.
- **Turnover:** a dummy `financials` register for Vardhan (for BRSR intensity per ₹ turnover), replacing the hard-coded ₹/body in `Sustain.tsx`.
