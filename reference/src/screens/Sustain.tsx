import { useMemo, useState } from 'react';
import { PLANT_MONTHS, REGISTERS, useStore, type VintageStatus } from '../state/store';
import { useSim } from '../sim/SimProvider';
import { OPEN_MONTH } from '../domain/synth';
import { PLANT } from '../domain/seed';
import { lineEntries, value } from '../domain/ledger';
import { monthEmissions, periodTotals } from '../domain/emissions';
import { evaluate } from '../domain/measures';
import { fmt, lakh, monthLabel, sha256 } from '../domain/util';
import { Icon } from '../ui/Icon';
import { Chip, Kpi, PageHead, Seg, download } from '../ui/kit';

const EF = 0.71;
const BUFFER = 0.1;
const STEPS: VintageStatus[] = ['monitoring', 'submitted', 'validated', 'verified', 'issued'];
const STEP_LABEL: Record<VintageStatus, string> = { monitoring: 'Monitoring (live)', submitted: 'Monitoring report submitted', validated: 'Validated', verified: 'Verified by accredited verifier', issued: 'Issued on registry' };

function useMonthSum(reg: string, months: string[]) {
  const { d } = useStore();
  return months.reduce((s, m) => s + (value(d.idx, reg, m, 'reading') ?? 0), 0);
}

export function Credits() {
  const { s, d, actions, notify } = useStore();
  const { engine } = useSim();
  const allMonths = [...PLANT_MONTHS, OPEN_MONTH];
  const vintages = allMonths.filter((m) => (value(d.idx, 'SOLAR_KWH', m, 'reading') ?? 0) > 0);
  const share = s.credits.alloc.SOLAR ?? 0.6;
  const [buyer, setBuyer] = useState('Demo buyer (voluntary)');

  const rows = vintages.map((m) => {
    const kwh = value(d.idx, 'SOLAR_KWH', m, 'reading') ?? 0;
    const readings = lineEntries(d.idx, 'SOLAR_KWH', m, 'reading').filter((e) => !e.reversesId).length;
    const gross = (kwh * EF) / 1000;
    const net = gross * (1 - BUFFER);
    const credit = net * share;
    const oem = net * (1 - share);
    const v = s.credits.vintages[m] ?? { status: 'monitoring' as VintageStatus, history: [] };
    return { m, kwh, readings, gross, net, credit, oem, v, dq: d.dq[m] };
  });
  const tot = rows.reduce((a, r) => ({ gross: a.gross + r.gross, credit: a.credit + r.credit, oem: a.oem + r.oem }), { gross: 0, credit: 0, oem: 0 });
  const verifiedEE = s.measures.filter((m) => m.status === 'verified' && m.co2Counted && m.code !== 'SOLAR');
  const eeT = verifiedEE.reduce((a, m) => a + evaluate(m, d.tariff, EF).co2t, 0);
  const annualSolarT = (250 * 4.5 * 365 * EF) / 1000 * (1 - BUFFER);
  const issued = rows.filter((r) => r.v.status === 'issued').reduce((a, r) => a + (r.v.tonnes ?? 0), 0);

  const monitoringReport = async (r: typeof rows[number]) => {
    const body = JSON.stringify({
      project: 'Rooftop solar 250 kWp, grid displacement (demo)', plant: `${PLANT.tenant}, ${PLANT.plant}`, vintage: r.m,
      method: 'Net generation × grid emission factor (CEA) × (1 − 10% conservativeness buffer)', grid_ef_kg_per_kwh: EF,
      generation_kwh: Math.round(r.kwh), hourly_meter_readings: r.readings, gross_t: +r.gross.toFixed(3), net_t: +r.net.toFixed(3),
      allocation: { carbon_credits_t: +r.credit.toFixed(3), oem_value_chain_claim_t: +r.oem.toFixed(3) },
      double_counting_guard: 'Tonnes allocated to credits are excluded from the renewable share reported to OEMs and from market-based Scope 2 claims.',
      data_quality_score: r.dq ?? null, generated_at: new Date().toISOString(), status: 'DEMO — not a certified document',
    }, null, 2);
    const sha = await sha256(body);
    await download(`monitoring_report_${r.m}.json`, body.replace('"status"', `"sha256_of_ledger_lines": "${sha.slice(0, 16)}…",\n  "status"`), 'application/json');
  };

  return (
    <div className="stack">
      <PageHead title="Carbon credits" sub="Credits are generated from the same verified ledger as BRSR and OEM reports. Every tonne has exactly one owner." />
      <div className="banner warn"><Icon name="shield" />Demo pipeline. Real credits need a registered project under a recognised scheme (for example India's Carbon Credit Trading Scheme offset mechanism, Verra or Gold Standard), validation and verification by an accredited body, and issuance on that registry. CarbonKhata prepares verification-ready evidence; it does not certify.</div>
      <div className="grid g4">
        <Kpi label="Eligible so far" value={fmt(tot.gross * (1 - BUFFER), 2)} unit="t CO₂e" sub={`after ${BUFFER * 100}% buffer · ${vintages.length} vintage(s)`} />
        <Kpi label="Allocated to credits" value={fmt(tot.credit, 2)} unit="t" sub={`${Math.round(share * 100)}% of solar reductions`} />
        <Kpi label="Issued (demo)" value={fmt(issued, 0)} unit="t" sub={`≈ ₹${fmt(issued * s.credits.pricePerT)} at ₹${fmt(s.credits.pricePerT)}/t`} tone={issued ? 'ok' : undefined} />
        <Kpi label="Full-year potential" value={fmt(annualSolarT + eeT, 0)} unit="t/yr" sub={`solar ${fmt(annualSolarT, 0)} + verified efficiency ${fmt(eeT, 0)}`} />
      </div>

      <div className="grid g2">
        <div className="card stack-sm">
          <h3>Projects and what counts</h3>
          <div className="stack-sm">
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}><div style={{ width: 90, flex: 'none' }}><Chip tone="ok">yes</Chip></div><div><strong className="small">Rooftop solar (self-consumed + exported)</strong><br /><span className="xs muted">Displaces grid power; metered hourly into the ledger</span></div></div>
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}><div style={{ width: 90, flex: 'none' }}><Chip tone={verifiedEE.length ? 'ok' : 'warn'}>{verifiedEE.length ? 'yes' : 'after M&V'}</Chip></div><div><strong className="small">Efficiency measures (LED, VFD)</strong><br /><span className="xs muted">Only once savings are verified against an output-adjusted baseline (Savings page)</span></div></div>
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}><div style={{ width: 90, flex: 'none' }}><Chip tone="neutral">no</Chip></div><div><strong className="small">Green open-access power</strong><br /><span className="xs muted">The renewable attribute belongs to the generator; counted as market-based Scope 2 only</span></div></div>
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}><div style={{ width: 90, flex: 'none' }}><Chip tone="neutral">no</Chip></div><div><strong className="small">Load shifting / demand response</strong><br /><span className="xs muted">Reported as grid-support impact ({fmt((engine?.ems.totals.avoidedKg ?? 0) / 1000, 2)} t at marginal factor), not sold</span></div></div>
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}><div style={{ width: 90, flex: 'none' }}><Chip tone="neutral">no</Chip></div><div><strong className="small">Gas genset instead of grid</strong><br /><span className="xs muted">Fossil fuel switch; shows in Scope 1 and 2, not credited</span></div></div>
          </div>
        </div>
        <div className="card stack-sm">
          <h3>Who owns each tonne (double-counting guard)</h3>
          <p className="small muted">Solar reductions can be sold as credits, or passed to your OEMs as a value-chain reduction on their parts. Not both.</p>
          <label className="field"><span className="label-text">{Math.round(share * 100)}% to carbon credits · {Math.round((1 - share) * 100)}% to OEM value-chain claim</span>
            <input type="range" min={0} max={100} step={5} value={share * 100} disabled={s.role !== 'owner' && s.role !== 'custodian'} onChange={(e) => actions.setAlloc('SOLAR', Number(e.target.value) / 100)} /></label>
          <div className="row" style={{ height: 26, borderRadius: 8, overflow: 'hidden', gap: 0 }}>
            <div style={{ width: `${share * 100}%`, background: 'var(--primary)', height: '100%' }} />
            <div style={{ width: `${(1 - share) * 100}%`, background: 'var(--c5)', height: '100%' }} />
          </div>
          <div className="row-between small"><span><span className="dot" style={{ background: 'var(--primary)' }} />Credits {fmt(tot.credit, 2)} t</span><span><span className="dot" style={{ background: 'var(--c5)' }} />OEM claim {fmt(tot.oem, 2)} t</span></div>
          <p className="xs muted">Part passports sent to OEMs show renewable power net of what was sold as credits. Every change here is in the audit log.</p>
        </div>
      </div>

      <div className="card stack-sm">
        <div className="card-head"><h3>Pooled cluster project</h3><Chip tone="info">Adityapur Green Cluster</Chip></div>
        <p className="small">The cluster's 3 MWp group-captive solar park is registered as one project with one verifier. Each member's credits follow the kWh it was allocated, from the same pool ledger.</p>
        <div className="grid g3">
          <Kpi label="Cluster project" value="≈ 2,760" unit="t/yr" sub="3 MWp solar after 10% buffer" />
          <Kpi label="Verification cost" value="₹6.0 L" sub="one audit, split across 10 users" />
          <Kpi label="Your share of cost" value="₹0.6 L" sub="vs ₹4–6 L to verify a rooftop alone" tone="ok" />
        </div>
        <p className="xs muted">Exchange-based reductions (scrap, heat, water) stay with the member named in each exchange agreement and are not credited twice. See Cluster symbiosis → Scoreboard & split.</p>
      </div>

      <div className="card">
        <div className="card-head"><h3>Vintages</h3>
          <div className="row"><span className="small muted">Price</span><input className="input num" style={{ width: 110, minHeight: 34 }} value={s.credits.pricePerT} onChange={(e) => actions.setCreditPrice(Number(e.target.value.replace(/\D/g, '')) || 0)} aria-label="Credit price ₹ per tonne" /><span className="small muted">₹/t</span></div></div>
        {rows.length === 0 ? <p className="small muted">No solar generation in the ledger yet.</p> : rows.map((r) => {
          const idx = STEPS.indexOf(r.v.status);
          return (
            <div key={r.m} className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
              <div className="row-between">
                <div><strong>{monthLabel(r.m, 'en', false)}</strong> <span className="small muted">· {fmt(r.kwh, 0)} kWh solar · {r.readings} metered readings · DQ {r.dq ?? 'live'}</span></div>
                <div className="row"><Chip tone="ok">{fmt(r.credit, 2)} t to credits</Chip>{r.m === OPEN_MONTH && <Chip tone="info">month open: still accruing</Chip>}</div>
              </div>
              <div className="wsteps">{STEPS.map((st, i) => <div key={st} className={`wstep ${i < idx ? 'done' : i === idx ? 'cur' : ''}`} style={{ cursor: 'default' }}><span className="n">{i < idx ? '✓' : i + 1}</span>{STEP_LABEL[st]}</div>)}</div>
              {r.v.serials && <p className="small mono">Serials (demo): {r.v.serials}{r.v.buyer ? ` · transferred to ${r.v.buyer}` : ''}</p>}
              <div className="row">
                <button className="btn sm" onClick={() => monitoringReport(r)}><Icon name="download" size={16} />Monitoring report</button>
                {r.v.status === 'monitoring' && <button className="btn sm primary" disabled={r.credit < 0.01} onClick={() => { actions.requestVerification(r.m, Math.max(1, r.credit)); notify('Submitted. The demo verifier will respond in a few seconds.'); }}>Request verification</button>}
                {r.v.status === 'issued' && !r.v.buyer && <><input className="input" style={{ width: 220, minHeight: 34 }} value={buyer} onChange={(e) => setBuyer(e.target.value)} aria-label="Buyer" /><button className="btn sm" onClick={() => actions.retireCredits(r.m, buyer)}>Transfer {r.v.tonnes} t · {lakh((r.v.tonnes ?? 0) * s.credits.pricePerT)}</button></>}
              </div>
              {r.v.history.length > 0 && <div className="xs muted">{r.v.history.map((h) => `${STEP_LABEL[h.status]} (${h.by}, ${new Date(h.at).toLocaleTimeString('en-IN')})`).join(' → ')}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- BRSR ----------------
const GJ = { kwh: 0.0036, dieselL: 0.043 * 0.832, lpgKg: 0.0473, ngScm: 0.0373 };
// IPCC 2006 stationary combustion defaults (kg/TJ) and IPCC AR5 GWP
const NON_CO2 = { diesel: { ch4: 3, n2o: 0.6 }, lpg: { ch4: 1, n2o: 0.1 }, ng: { ch4: 1, n2o: 0.1 } };
const GWP = { ch4: 28, n2o: 265 };
const REVENUE_PER_BODY = 620000; // ₹, dummy

export function Brsr() {
  const { s, d, notify } = useStore();
  const [p, setP] = useState<'ytd' | 'fy'>('ytd');
  const months = p === 'ytd' ? [...PLANT_MONTHS.filter((m) => m >= '2026-04'), OPEN_MONTH] : PLANT_MONTHS.filter((m) => m >= '2025-04' && m <= '2026-03');
  const rows = useMemo(() => months.map((m) => monthEmissions(REGISTERS, d.idx, s.factors, m)), [d.idx, s.factors, months.join()]);
  const t = periodTotals(rows);
  const sum = (r: string, line: 'issued' | 'reading' = 'reading') => months.reduce((a, m) => a + (value(d.idx, r, m, line) ?? 0), 0);
  const grid = useMonthSum('GRID_KWH', months), solar = sum('SOLAR_KWH'), green = sum('GREEN_OA_KWH'), exported = sum('GRID_EXPORT_KWH'), gas = sum('GENSET_GAS_SCM');
  const diesel = sum('DIESEL', 'issued'), lpg = sum('LPG', 'issued');
  const reElec = (solar + green) * GJ.kwh, nonReElec = grid * GJ.kwh;
  const fuelGJ = diesel * GJ.dieselL + lpg * GJ.lpgKg + gas * GJ.ngScm;
  const totalGJ = reElec + nonReElec + fuelGJ;
  const units = t.output, turnoverCr = (units * REVENUE_PER_BODY) / 1e7;
  const tj = { diesel: diesel * GJ.dieselL / 1000, lpg: lpg * GJ.lpgKg / 1000, ng: gas * GJ.ngScm / 1000 };
  const ch4 = (tj.diesel * NON_CO2.diesel.ch4 + tj.lpg * NON_CO2.lpg.ch4 + tj.ng * NON_CO2.ng.ch4) / 1000; // t
  const n2o = (tj.diesel * NON_CO2.diesel.n2o + tj.lpg * NON_CO2.lpg.n2o + tj.ng * NON_CO2.ng.n2o) / 1000;
  const s1 = t.scope1 / 1000 + ch4 * GWP.ch4 + n2o * GWP.n2o;
  const s2Market = t.scope2 / 1000;
  const s2Location = ((grid + green) * 0.71) / 1000;
  const water = { bore: sum('WATER_BORE', 'issued') / 1000, supply: sum('WATER_SUPPLY', 'issued') / 1000 };
  const sludge = sum('SLUDGE', 'issued') / 1000;
  const scrap = REGISTERS.filter((r) => r.category === 'scrap').reduce((a, r) => a + sum(r.id, 'issued'), 0) / 1000;
  const dqAvg = months.reduce((a, m) => a + (d.dq[m] ?? 100), 0) / months.length;
  const openBlocks = d.openIssues.filter((i) => months.includes(i.month) && i.severity === 'block').length;
  const closed = months.filter((m) => s.closes[m]?.status === 'closed').length;

  const tableRows: [string, string, number | string, string][] = [
    ['6.1', 'Electricity from renewable sources (A)', reElec, 'GJ'],
    ['6.1', 'Fuel from renewable sources (B)', 0, 'GJ'],
    ['6.1', 'Total renewable energy (A+B+C)', reElec, 'GJ'],
    ['6.1', 'Electricity from non-renewable sources (D)', nonReElec, 'GJ'],
    ['6.1', 'Fuel from non-renewable sources (E): diesel, LPG, natural gas', fuelGJ, 'GJ'],
    ['6.1', 'Total non-renewable energy (D+E+F)', nonReElec + fuelGJ, 'GJ'],
    ['6.1', 'Total energy consumed', totalGJ, 'GJ'],
    ['6.1', 'Renewable share', totalGJ ? (reElec / totalGJ) * 100 : 0, '%'],
    ['6.1', 'Energy intensity per ₹ crore turnover', turnoverCr ? totalGJ / turnoverCr : 0, 'GJ/₹ Cr'],
    ['6.1', 'Energy intensity per unit of output', units ? totalGJ / units : 0, 'GJ/body'],
    ['6.3', 'Water withdrawal: groundwater', water.bore, 'kL'],
    ['6.3', 'Water withdrawal: third-party supply', water.supply, 'kL'],
    ['6.7', 'Scope 1 (CO₂, CH₄, N₂O as CO₂e)', s1, 't CO₂e'],
    ['6.7', 'Scope 2, market-based', s2Market, 't CO₂e'],
    ['6.7', 'Scope 2, location-based (CEA)', s2Location, 't CO₂e'],
    ['6.7', 'Scope 1+2 intensity per ₹ crore turnover', turnoverCr ? (s1 + s2Market) / turnoverCr : 0, 't CO₂e/₹ Cr'],
    ['6.7', 'Scope 1+2 intensity per unit', units ? ((s1 + s2Market) * 1000) / units : 0, 'kg CO₂e/body'],
    ['6.9', 'Hazardous waste (paint sludge), to authorised vendor', sludge, 't'],
    ['6.9', 'Metal scrap, sent for recycling', scrap, 't'],
    ['—', 'Electricity exported to grid (not netted from Scope 2)', exported, 'kWh'],
  ];
  const exportJson = async () => {
    const body = JSON.stringify({ report: 'BRSR Section C, Principle 6 (essential indicators) — demo', entity: PLANT.tenant, period: `${months[0]} to ${months[months.length - 1]}`, indicators: tableRows.map(([ref, k, v, u]) => ({ ref, indicator: k, value: typeof v === 'number' ? +v.toFixed(3) : v, unit: u })), gases: { ch4_t: +ch4.toFixed(4), n2o_t: +n2o.toFixed(4), gwp: 'IPCC AR5' }, assurance_readiness: { data_quality_avg: Math.round(dqAvg), open_blocking_issues: openBlocks, months_closed: `${closed}/${months.length}`, traceability: 'Every figure links to ledger lines with source, user and time' } }, null, 2);
    const sha = await sha256(body);
    await download(`brsr_p6_${months[0]}_${months[months.length - 1]}.json`, body, 'application/json');
    notify(`BRSR extract downloaded · SHA-256 ${sha.slice(0, 10)}…`);
  };
  return (
    <div className="stack">
      <PageHead title="BRSR report" sub={`Principle 6 environmental indicators for ${PLANT.tenant}, built straight from the ledger. Values update as the plant runs.`}
        actions={<><Seg label="Period" value={p} onChange={setP} options={[{ v: 'ytd', l: 'FY 26-27 YTD' }, { v: 'fy', l: 'FY 25-26' }]} /><button className="btn" onClick={() => window.print()}><Icon name="print" size={16} />Print</button><button className="btn primary" onClick={exportJson}><Icon name="download" size={16} />Export</button></>} />
      <div className="grid g4">
        <Kpi label="Scope 1 + 2 (market)" value={fmt(s1 + s2Market, 1)} unit="t CO₂e" sub={`location-based ${fmt(s1 + s2Location, 1)} t`} />
        <Kpi label="Renewable energy share" value={fmt(totalGJ ? (reElec / totalGJ) * 100 : 0, 1)} unit="%" sub={`${fmt((solar + green) / 1000, 1)} MWh solar + green`} tone={reElec > 0 ? 'ok' : undefined} />
        <Kpi label="Intensity" value={fmt(units ? ((s1 + s2Market) * 1000) / units : 0, 0)} unit="kg/body" sub={`${fmt(units)} bodies`} />
        <Kpi label="Assurance readiness" value={`${Math.round(dqAvg)}`} unit="/100" tone={openBlocks ? 'warn' : 'ok'} sub={`${openBlocks} blocking issues · ${closed}/${months.length} months closed`} />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Ref</th><th>Indicator</th><th className="r">Value</th><th>Unit</th></tr></thead>
          <tbody>{tableRows.map(([ref, k, v, u]) => <tr key={k}><td className="mono">{ref}</td><td style={{ whiteSpace: 'normal' }}>{k}</td><td className="r"><strong>{typeof v === 'number' ? fmt(v, v < 10 ? 2 : 1) : v}</strong></td><td>{u}</td></tr>)}</tbody></table></div>
      </div>
      <p className="xs muted">Fuel energy uses IPCC 2006 net calorific values; CH₄ and N₂O use IPCC stationary-combustion defaults and AR5 warming potentials; grid factor CEA 0.71 kg/kWh. Turnover is a dummy ₹{fmt(REVENUE_PER_BODY)} per body. Indicator numbering is simplified for the demo.</p>
    </div>
  );
}
