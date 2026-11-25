# Demo script (about 12 minutes)

**Setup.** Put the product (http://localhost:5173) on the main screen and the demo controls (http://localhost:5174) on a second screen. Use speed **5×** at the start. Every company and figure is fictional.

## 1. Measure (3 min)

Sign in as **Priya (ESG custodian)**. The code is shown in dev mode: press *Fill dev code*.

1. Open **Live plant**:
   - Point out the 1-minute smart-meter load, the bodies on the line, and CO₂ today.
   - In the data-flow diagram, every dot is a real MQTT or REST packet arriving at the API.
2. On the controls screen, press **Typo: extra zero**:
   - A red dot goes to *Held for review* (V01: 32,000 kg of steel is 10× a normal entry).
   - On the product, press **Post 3,200**. The entry posts, and the emissions and reports update. A held entry never reaches the reports before this.
3. Press **Duplicate slip** (held as V10) and **Issue more than stock** (held as V12).
4. Switch the **Stores phone** offline and wait a few plant-minutes:
   - Entries queue on the phone.
   - Switch it back online: each entry posts exactly once, because of the idempotency key.
5. Open **Capture & checks → Data checks**:
   - 24 months of history with planted mistakes, found by V01–V12.
   - Try to close **Mar 2025**: it is blocked by V01. Accept the issue with a note, submit, then sign in as the **owner** to approve.

## 2. Optimise (3 min)

Open **Energy & grid**. Against the no-optimiser twin over the last 24 h, the plant shows:
- about 15–19 % lower cost;
- evening import down about 66 %;
- peak demand held at 380 kW (the twin would draw about 510 kW).

The seeded day reproduces the prototype exactly: −19.2 % and −66.2 %.

On the controls screen, try these in turn:
1. **IEX price spike**: the EMS re-plans the block and discharges the battery.
2. **DISCOM DR call**: the battery and genset come on, non-critical load is shed, and surplus is exported.
3. **Cloud over solar**: solar output drops and the EMS switches to the battery and green power.
4. **Grid outage**: the plant rides through on solar, battery and genset.

Then press **Compare last 24 h** to set the LP optimiser against the rules that actually ran.

## 3. Report (2 min)

1. Open **Part passports**: carbon per tipper body, routed to its OEM. Open a QR: the public page works on a phone with no login.
2. Sign in as **OEM A**: only OEM A's bodies are visible, and there is a count of the hidden ones. OEM B's file returns 403.
3. Sign in as **OEM C**: a CBAM-style embedded-emissions file (direct, indirect and precursor steel at 1.55 kg/kg).
4. Open **Credits & BRSR**:
   - Solar vintages: kWh × grid factor × 0.9.
   - Move the allocation slider between credits and OEM claims. The double-counting guard keeps the two shares summing to 100 %.
   - Submit a vintage: submitted → validated → verified → issued.
   - Show the BRSR P6 indicators.

## 4. FMCG (2 min)

1. Sign in as **Meena (Annapurna Foods)**. Show the batches, the tests, the release gate (failed tests hold a batch) and the ingredient lots.
2. On the controls screen, press **Flag a bad ingredient lot**: every batch that used the seasoning lot is RECALLED, with its packs and distributors listed.
3. Open a batch QR: the consumer page says *Do not consume*.
4. Sign in as **Brand B**: it sees only its own products.

## 5. Cluster (2 min)

Sign in as the **Cluster coordinator**. Walk through:
- the map with live flows;
- the energy pool: pooled deviation is far below the sum of individual deviations, with the hedge and the trader margin;
- the year-to-date scoreboard, built from ledger rows since 1 April.

On the controls screen, try these in turn:
1. **Foundry short of scrap**: a match appears; press *Agree exchange* to create a paired line.
2. **Weighbridge mismatch**: the line is held until both sides confirm.
3. **Heat exchanger trips**: heat flows pause.
4. **Member over-draws**: the pool absorbs it.
5. **New member joins**: the tool room buys through the pool.

## 6. Platform (1 min)

Sign in as **Ops admin**:
1. Publish a new **grid factor version** from 1 Oct: October changes and September keeps v1.
2. Open the audit log: it is append-only, and the hash chain verifies.
3. Open a read-only support session as the owner. The session is audited.

**Reset.** Use *Reset all demo data* on the controls screen, or run `scripts\seed.ps1`.
