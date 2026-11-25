import { useSim } from '../live/LiveProvider';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Qr, packLink } from '../ui/Qr';
import { OEMS, type OemId, type Passport } from '../live/engine';
import { useState } from 'react';
import { PLANT_MONTHS, REGISTERS, useStore } from '../state/store';
import { canonical, prakritiCSV } from '../domain/exports';
import { periodTotals } from '../domain/emissions';
import { PLANT } from '../domain/seed';
import { SAMPLE_SUPPLIERS, STAGES } from '../domain/samples';
import { fmt, monthLabel } from '../domain/util';
import { Icon } from '../ui/Icon';
import { Chip, Drawer, Kpi, PageHead, SampleTag, Seg, download } from '../ui/kit';
import { ChartCard, HBar, LineChart } from '../ui/Charts';

function usePlantRow() {
  const { s, d } = useStore();
  const tot = periodTotals(d.emissions);
  const fy24 = periodTotals(d.emissions.filter((r) => r.month >= '2025-04' && r.month <= '2026-03'));
  const fy25 = periodTotals(d.emissions.filter((r) => r.month >= '2026-04'));
  return { id: 'demo', name: PLANT.tenant, cluster: 'Jamshedpur', commodity: 'Tipper bodies', stage: 7, consent: s.consent, dq: Math.round(d.dqAvg), intensity: tot.intensity, trend: ((fy25.intensity - fy24.intensity) / fy24.intensity) * 100, sample: false as const };
}

export function OemOverview() {
  const { s, d, actions, notify } = useStore();
  const plantRow = usePlantRow();
  const rows = [plantRow, ...SAMPLE_SUPPLIERS];
  const [detail, setDetail] = useState(false);
  const [req, setReq] = useState('');
  const consented = rows.filter((r) => r.consent);
  const dqBands = [['≥ 80', (x: number) => x >= 80], ['60–79', (x: number) => x >= 60 && x < 80], ['< 60', (x: number) => x > 0 && x < 60]] as const;
  const bulk = () => {
    if (!s.consent) return notify(`${PLANT.tenant} has not consented. Only consented suppliers are exported.`);
    const c = canonical({ supplier: PLANT.tenant, plant: PLANT.plant, product: 'Tipper body', oemVendorCode: 'UAC-ADT-001', registers: REGISTERS, idx: d.idx, factors: s.factors, months: PLANT_MONTHS, dq: d.dq, issues: d.issues, issueStates: s.issueStates, closed: Object.fromEntries(PLANT_MONTHS.map((m) => [m, s.closes[m]?.status === 'closed'])) });
    download('oem_bulk_supplier_export.csv', prakritiCSV(c), 'text/csv');
    notify('Bulk file downloaded (real supplier data only; sample suppliers are not exported).');
  };
  return (
    <div className="stack">
      <PageHead title="Supplier overview" sub="Consented supplier data across your supply base. You can read and request; you can never edit supplier data." actions={<button className="btn primary" onClick={bulk}><Icon name="download" size={16} />Bulk export (consented)</button>} />
      <div className="banner info"><Icon name="info" />All suppliers and figures in this portal are simulated. Click {PLANT.tenant} for its live consented summary.</div>
      <div className="grid g4">
        <Kpi label="Suppliers nominated" value={rows.length} sub="In this programme" />
        <Kpi label="Consented" value={consented.length} sub={`${rows.length - consented.length} not yet`} />
        <Kpi label="Median DQ score" value={fmt([...consented.map((r) => r.dq)].sort((a, b) => a - b)[Math.floor(consented.length / 2)] ?? 0)} unit="/100" />
        <Kpi label="Live on platform" value={rows.filter((r) => r.stage >= 9).length} sub="Go-live or later" />
      </div>
      <div className="grid g3">
        <div className="card span2" style={{ padding: 0 }}>
          <div className="table-wrap" style={{ border: 0 }}><table className="t">
            <thead><tr><th>Supplier</th><th>Cluster</th><th>Stage</th><th>Consent</th><th className="r">DQ</th><th className="r">kg CO₂e / unit</th><th className="r">YoY</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={r.id === 'demo' && r.consent ? 'clickable' : ''} onClick={() => r.id === 'demo' && r.consent && setDetail(true)}>
                <td><strong>{r.name}</strong> {r.sample && <SampleTag />}<br /><span className="xs muted">{r.commodity}</span></td>
                <td>{r.cluster}</td>
                <td className="small">{STAGES[r.stage - 1].name}</td>
                <td>{r.consent ? <Chip tone="ok">{r.consent}</Chip> : <Chip>not consented</Chip>}</td>
                <td className="r">{r.consent ? r.dq : '—'}</td>
                <td className="r">{r.consent && r.intensity ? fmt(r.intensity, 1) : '—'}</td>
                <td className="r">{r.consent && r.trend ? <span style={{ color: r.trend < 0 ? 'var(--success)' : 'var(--danger)' }}>{r.trend > 0 ? '+' : ''}{fmt(r.trend, 1)}%</span> : '—'}</td>
              </tr>
            ))}</tbody></table></div>
        </div>
        <div className="card stack-sm">
          <h3>Data-quality distribution</h3>
          <p className="xs muted">Consented suppliers only</p>
          {dqBands.map(([l, f]) => { const n = consented.filter((r) => f(r.dq)).length; return <div key={l} className="stack-sm" style={{ gap: 4 }}><div className="row-between small"><span>{l}</span><strong>{n}</strong></div><HBar value={n} max={consented.length || 1} color={l === '≥ 80' ? 'var(--success)' : l === '< 60' ? 'var(--danger)' : 'var(--accent)'} /></div>; })}
          <div className="divider" />
          <p className="small">Units differ by commodity, so intensity is compared within a commodity, not across the table.</p>
        </div>
      </div>
      {detail && (
        <Drawer title={`${PLANT.tenant} (consented summary)`} onClose={() => setDetail(false)} footer={<><input className="input" style={{ flex: 1 }} placeholder="Request a correction or clarification…" value={req} onChange={(e) => setReq(e.target.value)} /><button className="btn primary" disabled={!req.trim()} onClick={() => { actions.oemRequest(req); setReq(''); notify('Request sent to the supplier’s data-quality queue'); }}>Send</button></>}>
          <div className="stack">
            <div className="grid g2"><Kpi label="kg CO₂e / body" value={fmt(plantRow.intensity, 1)} /><Kpi label="DQ score" value={plantRow.dq} unit="/100" /></div>
            <ChartCard title="Intensity trend" sub="kg CO₂e per tipper body">
              <LineChart labels={d.emissions.map((r) => monthLabel(r.month))} series={[{ name: 'kg/body', color: 'var(--c1)', values: d.emissions.map((r) => r.intensity) }]} height={180} />
            </ChartCard>
            <p className="small muted">Summary consent: totals, intensity and DQ only. Costs, bills and raw ledger stay with the supplier.</p>
          </div>
        </Drawer>
      )}
    </div>
  );
}

export function OemProgramme() {
  const { s, actions, notify } = useStore();
  const [codes, setCodes] = useState('');
  const seats = 25;
  const used = s.cases.filter((c) => c.sponsor === 'OEM-sponsored').length;
  const funnel = STAGES.map((st) => ({ ...st, count: s.cases.filter((c) => c.stage >= st.n).length }));
  return (
    <div className="stack">
      <PageHead title="Supplier programme" sub="Nominate suppliers, fund their Basic seats and watch them onboard." />
      <div className="grid g3">
        <Kpi label="Sponsored seats" value={`${used} / ${seats}`} sub="Basic tier, OEM-funded" />
        <Kpi label="Reached baseline" value={s.cases.filter((c) => c.stage >= 8).length} sub="Stage 8 or later" />
        <Kpi label="Median days to baseline" value="11" sub="Target ≤ 14 (sample)" />
      </div>
      <div className="grid g2">
        <div className="card stack-sm">
          <h3>Onboarding funnel</h3>
          {funnel.map((f) => <div key={f.n} className="stack-sm" style={{ gap: 3 }}><div className="row-between small"><span>{f.n}. {f.name}</span><strong>{f.count}</strong></div><HBar value={f.count} max={s.cases.length} /></div>)}
        </div>
        <div className="card stack-sm">
          <h3>Nominate suppliers</h3>
          <p className="small muted">Paste vendor codes and names, one per line (e.g. <span className="mono">V10442, Supplier K: springs, Pune</span>). Each becomes a lead with a sponsored seat.</p>
          <textarea className="input" rows={6} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={'V10442, Supplier K: springs, Pune\nV10518, Supplier L: brackets, Pithampur'} />
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!codes.trim()} onClick={() => {
            const lines = codes.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((l) => l[1]);
            lines.forEach((l) => actions.addCase(l[1], l[2] ?? '—', 'OEM-sponsored'));
            notify(`${lines.length} supplier(s) nominated. Invites go out on WhatsApp, SMS and email.`); setCodes('');
          }}>Nominate</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Part passports: each OEM sees only its own bodies ----------
export function OemParts() {
  const { passports, hiddenOtherOems } = useSim();
  const { s } = useStore();
  const fixed = s.role === 'oem' ? (s.me?.tenant.code as OemId | undefined) : undefined;
  const [pick, setOem] = useState<OemId>('A');
  const oem = fixed ?? pick;
  const [qr, setQr] = useState<Passport | null>(null);
  const notify = useStore().notify;
  const share = s.credits.alloc.SOLAR ?? 0.6;
  const mine = passports.filter((p) => p.oem === oem);
  const others = fixed ? hiddenOtherOems : passports.length - mine.length;
  const avg = (f: (p: Passport) => number) => (mine.length ? mine.reduce((a, p) => a + f(p), 0) / mine.length : 0);
  const cbam = oem === 'C';
  const dl = async () => {
    const body = JSON.stringify({ format: cbam ? 'CBAM-style embedded emissions per item (demo)' : 'Supplier part carbon passport (demo)', supplier: PLANT.tenant, buyer: OEMS[oem].name, items: mine.map((p) => ({ serial: `VBW-${p.id}`, order: p.order, completed: new Date(p.t).toISOString(), direct_kgco2e: +p.s1.toFixed(1), indirect_electricity_kgco2e: +p.s2.toFixed(1), precursor_steel_kgco2e: +p.steel.toFixed(0), steel_kg: p.steelKg, steel_ef: OEMS[oem].steelEf, electricity_kwh: +p.kwh.toFixed(1), renewable_share_after_credit_carve_out: +(p.renewableShare * (1 - share)).toFixed(3), total_kgco2e: +p.total.toFixed(0) })) }, null, 2);
    await download(`passports_${OEMS[oem].name.replace(' ', '_')}.json`, body, 'application/json');
    notify(`${mine.length} passports downloaded for ${OEMS[oem].name}`);
  };
  return (
    <div className="stack">
      <PageHead title="Part passports" sub="Every body carries its own carbon: steel, gases and the exact power mix of the minutes it was on the line. A supplier serving several OEMs sends each OEM only its own parts."
        actions={<>{!fixed && <Seg label="OEM" value={oem} onChange={setOem} options={(Object.keys(OEMS) as OemId[]).map((k) => ({ v: k, l: OEMS[k].name }))} />}<button className="btn primary" disabled={!mine.length} onClick={dl}><Icon name="download" size={16} />Download</button></>} />
      <div className="banner info"><Icon name="eye" />Viewing as {OEMS[oem].name} ({OEMS[oem].sub}). {others} bodies made for other OEMs are hidden from this view.</div>
      <div className="grid g4">
        <Kpi label="Parts received" value={mine.length} sub="latest 300 issued" />
        <Kpi label="Plant emissions / part" value={fmt(avg((p) => p.s1 + p.s2), 0)} unit="kg CO₂e" sub="Scope 1 + 2 at the supplier" />
        <Kpi label="Steel (precursor) / part" value={fmt(avg((p) => p.steel) / 1000, 2)} unit="t CO₂e" sub={OEMS[oem].steelNote} />
        <Kpi label="Renewable power" value={fmt(avg((p) => p.renewableShare) * (1 - share) * 100, 0)} unit="%" sub={`net of ${Math.round(share * 100)}% sold as credits`} />
      </div>
      <p className="small muted">Circularity: this supplier's steel off-cuts (≈34 t/month) go to a foundry in its cluster under a metered exchange. The recycled-content claim sits with the foundry, so it is not added to these parts.</p>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ border: 0, maxHeight: 520 }}><table className="t"><thead><tr><th>Serial</th><th>Order</th><th>Completed</th><th className="r">kWh</th><th className="r">Direct kg</th><th className="r">Electricity kg</th><th className="r">Steel kg CO₂e</th><th className="r">Total kg</th><th className="r">Renewable</th><th>QR</th></tr></thead>
          <tbody>{mine.length === 0 ? <tr><td colSpan={10} className="muted">No parts for {OEMS[oem].name} yet. Passports appear as bodies pass final inspection.</td></tr> : mine.map((p) => <tr key={p.id}><td className="mono">VBW-{p.id}</td><td>{p.order}</td><td className="small">{new Date(p.t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}</td><td className="r">{fmt(p.kwh, 0)}</td><td className="r">{fmt(p.s1, 0)}</td><td className="r">{fmt(p.s2, 0)}</td><td className="r">{fmt(p.steel, 0)}</td><td className="r"><strong>{fmt(p.total, 0)}</strong></td><td className="r">{fmt(p.renewableShare * (1 - share) * 100, 0)}%</td><td><button className="btn sm ghost" onClick={() => setQr(p)} aria-label={`QR for body ${p.id}`}><Icon name="qr" size={16} /></button></td></tr>)}</tbody></table></div>
      </div>
      {qr && <PartQrDrawer p={qr} onClose={() => setQr(null)} />}
      {cbam && <p className="xs muted">OEM C exports to the EU: the download is shaped like an embedded-emissions declaration per item (direct, indirect, precursor). Lower-carbon steel from a certified mill cuts its precursor emissions by about a third.</p>}
    </div>
  );
}

// ---------- QR per tipper body: inspection results + carbon passport ----------
export function partInspection(id: number) {
  const r = (k: number) => ((id * 9301 + k * 49297) % 233280) / 233280;
  return [
    { name: 'Weld visual inspection (ISO 5817 level C)', value: 'No defects', ok: true },
    { name: 'Body dimensions (L × W, ±3 mm)', value: `${(5600 + Math.round((r(1) - 0.5) * 4))} × ${(2400 + Math.round((r(2) - 0.5) * 4))} mm`, ok: true },
    { name: 'Paint dry-film thickness (≥ 80 µm)', value: `${Math.round(86 + r(3) * 18)} µm`, ok: true },
    { name: 'Cross-cut adhesion (class ≤ 1)', value: `Class ${r(4) > 0.8 ? 1 : 0}`, ok: true },
    { name: 'Hydraulic hoist leak test', value: 'No leak at 180 bar', ok: true },
  ];
}

export function PartQrDrawer({ p, onClose }: { p: Passport; onClose: () => void }) {
  const link = packLink(`p-${p.publicCode ?? p.id}`);
  return (
    <Drawer title={`Body VBW-${p.id}`} onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <Qr text={link} size={150} />
          <div className="stack-sm small"><span>{OEMS[p.oem].name} · {p.order}</span><span>{fmt(p.total, 0)} kg CO₂e incl. steel</span><a className="btn sm" href={`#p-${p.publicCode ?? p.id}`}>Open passport page</a></div>
        </div>
        <p className="xs muted">The QR plate is riveted to the body. Scanning it opens inspection results and the carbon passport, for the OEM's line, the dealer or a fleet buyer.</p>
      </div>
    </Drawer>
  );
}

interface PublicPart { serial: string; product: string; maker: string; plant: string; finished: string; inspection: string; carbon: { plant_kg: number; steel_kg: number; total_kg: number; renewable_share: number }; note: string }
export function PartPublic({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['public', 'p', id], queryFn: () => api<PublicPart>(`/public/part/${encodeURIComponent(id)}`, { noAuth: true }), retry: false });
  const p = q.data;
  if (q.isLoading) return <div className="pub"><div className="card">Loading passport…</div></div>;
  if (!p) return <div className="pub"><div className="card"><h2>Part {id} not found</h2><p className="small muted" style={{ marginTop: 6 }}>This code is not in the record.</p></div></div>;
  return (
    <div className="pub">
      <div className="pub-head" style={{ background: '#0B5D3B' }}>
        <span className="xs" style={{ opacity: 0.85 }}>{p.maker} · {p.plant}</span>
        <h1 style={{ color: '#fff' }}>{p.product} {p.serial}</h1>
        <span className="small" style={{ opacity: 0.9 }}>completed {new Date(p.finished).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
      </div>
      <div className="banner ok"><Icon name="check" />{p.inspection}</div>
      <div className="card stack-sm"><h3>Carbon passport</h3>
        {[['Purchased steel', p.carbon.steel_kg], ['Plant (direct + electricity)', p.carbon.plant_kg]].map(([k, v]) => <div key={k as string} className="row-between small"><span>{k}</span><span className="num">{fmt(v as number, 0)} kg CO₂e</span></div>)}
        <div className="row-between small"><span>Renewable electricity</span><span className="num">{Math.round(p.carbon.renewable_share * 100)}%</span></div>
        <div className="row-between"><strong>Total</strong><strong className="num">{fmt(p.carbon.total_kg, 0)} kg CO₂e</strong></div>
      </div>
      <p className="xs muted" style={{ textAlign: 'center' }}>{p.note}</p>
    </div>
  );
}
