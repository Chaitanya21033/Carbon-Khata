# CarbonKhata — prototype (v2)

A supplier-side carbon and energy platform for MSME manufacturers, built in three layers:

1. **Measure**: shop-floor registers, meters and bills become a checked double-entry ledger, then carbon per part, routed only to the OEM that ordered it.
2. **Optimise**: every 15 minutes the plant decides where to buy power (DISCOM, IEX day-ahead, green day-ahead, real-time), when to charge or discharge the battery, run the gas genset, shift flexible loads and sell surplus, which also eases the evening duck-curve ramp.
3. **Monetise**: verification-ready carbon credits with a double-counting guard, a BRSR Principle 6 report, and data for green loans and subsidies.

**Logins:** pick a role on the sign-in screen (any 6-digit code): Operator (shop-floor capture), ESG custodian, Plant owner, OEM / brand viewer (only consented passports), Platform admin (onboarding pipeline, data-quality centre, libraries, audit, read-only support view).

**All data is simulated.** The demo plant (Vardhan Body Works) is fictional.

## Screens
| Screen | What it shows |
|---|---|
| Live plant | Real-time data flow (meters, phones, bills → sync → checks → ledger → emissions → dashboard / OEM / BRSR), load, production line, event stream, held-for-review queue |
| Energy & grid | Solar forecast (Open-Meteo), grid carbon (Electricity Maps), IEX-shaped market prices, duck curve, 15-minute dispatch, decision log, procurement plan, savings vs a naive twin |
| Capture & checks | Meter and bill photos read by Claude vision, register entry with inline checks, data-quality queue (V01–V12), registers with reversal-based corrections |
| Part passports | Carbon per tipper body (steel, gases, power mix while on the line), filtered per OEM; CBAM-style file for the exporting OEM |
| Batch tracing (FMCG) | A fictional co-packer making biscuits for two brands: batches with QC tests and a release gate, ingredient lots traced to suppliers, mass balance, carbon per pack, a QR per batch opening a public consumer page, and one-click recall that finds every affected batch, pack and distributor. Tipper bodies get a QR too, opening inspection results and the carbon passport. |
| Credits & BRSR | Credit vintages, verify-and-issue pipeline (demo), allocation slider between credits and OEM claims; BRSR P6 indicators from the ledger |
| Cluster symbiosis | Kalundborg-style industrial cluster of 12 fictional plants + a group-captive solar park. Map with live flows (power, heat, scrap, water, waste); energy pool bought through one licensed trader (open-access access for small members, deviation netting, term-contract hedge, bid book); resource exchange with suggested matches and paired sender/receiver ledger lines (mismatch held); year-to-date scoreboard; gain-sharing and carbon-claim split with a double-counting guard. New login: Cluster coordinator. Owners see 'My cluster'. |
| Onboard a supplier | 6-step wizard with GSTIN / Udyam checks, register mapping, CSV import with live validation, baseline and QR go-live kit |

Demo controls (clock, speed, devices, injected errors, DR call, price spike, cloud, outage, optimiser on/off, recall, and cluster events: member over-draws, new member joins, foundry short of scrap, heat exchanger trips, weighbridge mismatch) sit in a separate panel, not in the product.

## APIs
| Source | Status in this build |
|---|---|
| Open-Meteo solar forecast | Live call (free, no key); falls back to a modelled curve |
| Electricity Maps grid carbon | Live call with a free personal key (Data sources panel); falls back to the simulated factor |
| Claude vision (meter and bill photos) | Live inside the claude.ai viewer via the `sample` capability; simulated elsewhere |
| IEX member API | Adapter with a simulated 96-block feed (IEX API access is for registered members) |
| GSTIN / Udyam (Setu, Cashfree) | Adapter with local format checks |

A published claude.ai page blocks calls to outside sites, so Open-Meteo and Electricity Maps go live when you run it locally.

## Run
```bash
npm install
npm run dev           # local, live APIs work here
npm test              # 35 checks: ledger, validation, emissions, simulator, optimiser
npm run build:single  # one self-contained HTML file in dist-single/
```
