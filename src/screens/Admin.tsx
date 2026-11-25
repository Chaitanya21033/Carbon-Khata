import { useMemo, useState } from 'react';
import { PLANT_MONTHS, REGISTERS, useStore } from '../state/store';
import { monthEmissions, periodTotals } from '../domain/emissions';
import { RULES } from '../domain/validation';
import { SAMPLE_SUPPLIERS, STAGES, seeded } from '../domain/samples';
import { fmt, monthLabel } from '../domain/util';
import type { EmissionFactor } from '../domain/types';
import { Icon } from '../ui/Icon';
import { PLANT } from '../domain/seed';
import { Chip, Kpi, PageHead, SampleTag } from '../ui/kit';
import { HBar } from '../ui/Charts';

const go = (r: string) => { location.hash = `/${r}`; };
const late = (c: { stage: number; daysTotal: number }) => c.daysTotal > STAGES[c.stage - 1].target + 3 && c.stage < 10;

export function AdminOverview() {
  const { s, d } = useStore();
  const blocks = d.openIssues.filter((i) => i.severity === 'block').length;
  const breaches = s.cases.filter(late);
  const tiles = [
    { l: 'Tenants', v: s.cases.length, sub: 'Suppliers in pipeline', r: 'pipeline' },
    { l: 'Active plants', v: s.cases.filter((c) => c.stage >= 9).length, sub: 'Entries in last 7 days', r: 'pipeline' },
    { l: 'Avg DQ (demo plant)', v: fmt(d.dqAvg, 0), sub: PLANT.tenant, r: 'dqc' },
    { l: 'Open blocks', v: blocks, sub: 'Across tenants', r: 'dqc' },
    { l: 'Exports this month', v: s.exportsLog.length, sub: 'OEM, BRSR, passport', r: 'audit' },
    { l: 'SLA breaches', v: breaches.length, sub: 'Stage target + 3 days', r: 'pipeline' },
  ];
  return (
    <div className="stack">
      <PageHead title="Platform overview" sub="Daily loop: pipeline → data-quality centre → support → libraries. Click any tile for the filtered list." />
      <div className="grid g6">{tiles.map((t) => <button key={t.l} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => go(t.r)}><span className="k-label">{t.l}</span><span className="k-value">{t.v}</span><span className="k-sub">{t.sub}</span></button>)}</div>
      <div className="grid g2">
        <div className="card stack-sm">
          <h3>Needs attention</h3>
          {breaches.map((c) => <div key={c.id} className="row-between small"><span><strong>{c.supplier}</strong> {c.sample && <SampleTag />} · {STAGES[c.stage - 1].name}</span><Chip tone="block">{c.daysTotal} days</Chip></div>)}
          {blocks > 0 && <div className="row-between small"><span><strong>{PLANT.tenant}</strong> · {blocks} must-fix issues</span><button className="btn sm" onClick={() => go('dqc')}>Open</button></div>}
          <div className="row-between small"><span>AI meter-read override rate (7 days)</span><Chip tone="ok">4% · alert at 10%</Chip></div>
        </div>
        <div className="card stack-sm">
          <h3>System health</h3>
          {[['Sync queue failures (24 h)', '0'], ['Background jobs pending', '3'], ['Validation run (nightly)', 'OK · 02:00 IST'], ['Factor library', `v${Math.max(...s.factors.filter((f) => f.code === 'EF_GRID_IN').map((f) => f.version))} grid factor`]].map(([a, b]) => <div key={a} className="row-between small"><span>{a}</span><strong>{b}</strong></div>)}
        </div>
      </div>
    </div>
  );
}

export function Pipeline() {
  const { s, actions, notify } = useStore();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [name, setName] = useState('');
  return (
    <div className="stack">
      <PageHead title="Onboarding pipeline" sub="Columns are the 11 onboarding stages. Drag a card to move it (logged). Red edge = past the stage target + 3 days." />
      <div className="row">
        <input className="input" style={{ maxWidth: 320 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New lead: supplier name" />
        <button className="btn primary" disabled={!name.trim()} onClick={() => { actions.addCase(name.trim(), '—', 'Self-serve'); setName(''); notify('Lead created and assigned to the queue'); }}><Icon name="plus" size={16} />Add lead</button>
      </div>
      <div className="kanban">
        {STAGES.map((st) => {
          const cards = s.cases.filter((c) => c.stage === st.n);
          return (
            <div key={st.n} className={`kcol ${over === st.n ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(st.n); }} onDragLeave={() => setOver(null)}
              onDrop={() => { if (drag) actions.moveCase(drag, st.n); setDrag(null); setOver(null); }}>
              <div className="row-between"><strong className="small">{st.n}. {st.name}</strong><Chip>{cards.length}</Chip></div>
              <span className="xs muted">Target: day {st.target}</span>
              {cards.map((c) => (
                <div key={c.id} className={`kcard ${late(c) ? 'late' : ''}`} draggable onDragStart={() => setDrag(c.id)}>
                  <div className="row-between"><strong>{c.supplier}</strong>{!c.sample && <Chip tone="ok">demo plant</Chip>}</div>
                  <div className="xs muted">{c.cluster} · {c.sponsor}</div>
                  <div className="xs muted">Associate: {c.associate} · day {c.daysTotal}</div>
                  <select className="input" style={{ minHeight: 32, fontSize: 12, marginTop: 6 }} value={c.stage} onChange={(e) => actions.moveCase(c.id, Number(e.target.value))} aria-label={`Move ${c.supplier}`}>
                    {STAGES.map((x) => <option key={x.n} value={x.n}>Move to {x.n}. {x.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DqCentre() {
  const { s, d, notify } = useStore();
  const months = PLANT_MONTHS.slice(-12);
  const rnd = seeded(7);
  const tenants = [{ name: PLANT.tenant, sample: false, vals: months.map((m) => d.dq[m]) },
    ...SAMPLE_SUPPLIERS.filter((x) => x.stage >= 7).map((x) => ({ name: x.name, sample: true, vals: months.map(() => Math.round(Math.min(100, Math.max(20, x.dq + (rnd() - 0.5) * 30)))) }))];
  const color = (v: number) => (v >= 80 ? '#9FD5AE' : v >= 60 ? '#FFE08A' : v >= 40 ? '#F7B267' : '#F2857B');
  const hits = RULES.map((r) => ({ code: r.code, name: r.name, n: d.issues.filter((i) => i.rule === r.code).length })).filter((r) => r.n);
  const maxHits = Math.max(...hits.map((h) => h.n));
  return (
    <div className="stack">
      <PageHead title="Data-quality command centre" sub="The platform never edits supplier data. It can only comment or request." actions={<button className="btn" onClick={() => notify(`Reminder sent to ${tenants.length} custodians (WhatsApp + email)`)}><Icon name="users" size={16} />Message custodians</button>} />
      <div className="card">
        <div className="card-head"><h3>DQ score by tenant and month</h3><div className="legend">{[['≥80', '#9FD5AE'], ['60–79', '#FFE08A'], ['40–59', '#F7B267'], ['<40', '#F2857B']].map(([l, c]) => <span key={l}><i style={{ background: c }} />{l}</span>)}</div></div>
        <div className="table-wrap" style={{ border: 0 }}><table className="t heat">
          <thead><tr><th className="sticky-col">Tenant</th>{months.map((m) => <th key={m} className="r" style={{ padding: '6px 2px' }}>{monthLabel(m)}</th>)}</tr></thead>
          <tbody>{tenants.map((t) => <tr key={t.name}><td className="sticky-col small">{t.name} {t.sample && <SampleTag />}</td>{t.vals.map((v, i) => <td key={i} className="h" style={{ background: color(v) }} title={`${t.name} ${monthLabel(months[i])}: ${v}`}>{v}</td>)}</tr>)}</tbody>
        </table></div>
      </div>
      <div className="card stack-sm">
        <h3>Rule hit counts (demo plant history)</h3>
        {hits.map((h) => <div key={h.code} className="stack-sm" style={{ gap: 3 }}><div className="row-between small"><span><Chip>{h.code}</Chip> {h.name}</span><strong>{h.n}</strong></div><HBar value={h.n} max={maxHits} color="var(--accent)" /></div>)}
        <p className="xs muted">Open now: {d.openIssues.length}. Resolved or confirmed: {d.issues.length - d.openIssues.length}. Comments sent by OEMs: {s.comments.length}.</p>
      </div>
    </div>
  );
}

export function Libraries() {
  const { s, d, actions, notify } = useStore();
  const [code, setCode] = useState('EF_GRID_IN');
  const [val, setVal] = useState('0.727');
  const [from, setFrom] = useState('2026-04-01');
  const [src, setSrc] = useState('CEA baseline database (next version, value to confirm)');
  const cur = s.factors.filter((f) => f.code === code).sort((a, b) => b.version - a.version)[0];
  const draft: EmissionFactor | null = cur && Number(val) > 0 ? { ...cur, kgco2e_per_unit: Number(val), version: cur.version + 1, valid_from: from, valid_to: null, source: src, status: 'active' } : null;
  const impact = useMemo(() => {
    if (!draft) return null;
    const next = s.factors.map((f) => (f.code === draft.code && f.valid_to === null && f.valid_from < draft.valid_from ? { ...f, valid_to: draft.valid_from } : f)).concat(draft);
    const before = periodTotals(d.emissions);
    const after = periodTotals(PLANT_MONTHS.map((m) => monthEmissions(REGISTERS, d.idx, next, m)));
    const affected = PLANT_MONTHS.filter((m) => `${m}-01` >= draft.valid_from).length;
    return { before: before.total / 1000, after: after.total / 1000, affected };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, val, from, s.factors, d]);
  return (
    <div className="stack">
      <PageHead title="Libraries" sub="Emission factors, validation rules and register types are versioned with effective dates. Publishing shows the impact first; history is recalculated side by side, never overwritten." />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ border: 0 }}><table className="t">
          <thead><tr><th>Code</th><th>Activity</th><th>Scope</th><th className="r">kg CO₂e / unit</th><th>v</th><th>Valid</th><th>Source</th><th>Status</th></tr></thead>
          <tbody>{[...s.factors].sort((a, b) => a.code.localeCompare(b.code) || a.version - b.version).map((f) => <tr key={f.code + f.version}><td className="mono">{f.code}</td><td>{f.activity}</td><td>{f.scope}</td><td className="r">{f.kgco2e_per_unit}</td><td>{f.version}</td><td className="small">{f.valid_from} → {f.valid_to ?? 'open'}</td><td className="small" style={{ whiteSpace: 'normal', minWidth: 220 }}>{f.source}</td><td><Chip tone={f.status === 'active' ? 'ok' : f.status === 'provisional' ? 'warn' : 'neutral'}>{f.status}</Chip></td></tr>)}</tbody>
        </table></div>
      </div>
      <div className="card stack">
        <h3>Publish a new factor version</h3>
        <div className="grid g4">
          <div className="field"><label htmlFor="fc">Factor</label><select id="fc" className="input" value={code} onChange={(e) => setCode(e.target.value)}>{Array.from(new Set(s.factors.map((f) => f.code))).map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label htmlFor="fv">New value</label><input id="fv" className="input num" value={val} onChange={(e) => setVal(e.target.value)} /></div>
          <div className="field"><label htmlFor="ff">Valid from</label><input id="ff" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label htmlFor="fs">Source</label><input id="fs" className="input" value={src} onChange={(e) => setSrc(e.target.value)} /></div>
        </div>
        {impact && <div className="banner info"><Icon name="info" />Impact preview: {PLANT.tenant} Scope 1+2 for the 24-month history goes from {fmt(impact.before, 1)} t to {fmt(impact.after, 1)} t ({impact.after >= impact.before ? '+' : ''}{fmt(impact.after - impact.before, 1)} t); {impact.affected} months affected. 1 tenant notified.</div>}
        <p className="xs muted">The value pre-filled here is a placeholder for the demo, not an official figure.</p>
        <div className="row"><button className="btn primary" disabled={!draft} onClick={() => { actions.addFactorVersion(draft!); notify(`${code} v${draft!.version} published. Dashboards recalculated.`); }}>Publish version</button><button className="btn" onClick={actions.resetFactors}>Restore v1 library</button></div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Rule</th><th>Name</th><th>Severity</th><th>Parameters</th></tr></thead>
          <tbody>{RULES.map((r) => <tr key={r.code}><td className="mono">{r.code}</td><td>{r.name}</td><td>{r.severity.replace(/_/g, ' ')}</td><td className="mono">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</td></tr>)}</tbody></table></div>
      </div>
      <p className="small muted">Register library: {REGISTERS.length} register definitions in this tenant. Measures library: {s.measures.length} costed measures plus contract-demand and leak programmes.</p>
    </div>
  );
}

export function Billing() {
  const { s } = useStore();
  const sponsored = s.cases.filter((c) => c.sponsor === 'OEM-sponsored').length;
  return (
    <div className="stack">
      <PageHead title="Billing & sponsorships" sub="Tiers and prices below are illustrative for the prototype." />
      <div className="grid g3">
        {[['Basic', 'Free to supplier (OEM-sponsored seat)', ['Registers, validation, month close', 'Scope 1 + 2 dashboard', 'OEM export + passport']], ['Pro', 'Paid by supplier, per plant / month', ['Sub-meters via channel partner', 'M&V reports for lenders', 'GreenCo tracker, leak programme']], ['OEM programme', 'Paid by OEM, per supplier seat / year', ['Supplier portfolio view', 'Bulk exports, correction requests', 'Onboarding service + SLA']]].map(([t, w, f]) => (
          <div key={t as string} className="card stack-sm"><div className="row-between"><h3>{t}</h3><SampleTag /></div><p className="small muted">{w}</p><ul className="small">{(f as string[]).map((x) => <li key={x}>{x}</li>)}</ul></div>
        ))}
      </div>
      <div className="card stack-sm">
        <h3>Sponsorships</h3>
        <div className="row-between small"><span>Demo OEM programme: Basic seats used</span><strong>{sponsored} / 25</strong></div>
        <HBar value={sponsored} max={25} />
        <p className="xs muted">Sponsors see seat usage only, never supplier data unless the supplier consents.</p>
      </div>
    </div>
  );
}

export function AuditSupport() {
  const { s, actions, notify } = useStore();
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const rows = s.audit.filter((a) => !q || `${a.action} ${a.entity} ${a.detail} ${a.actor}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack">
      <PageHead title="Audit & support" />
      <div className="grid g2">
        <div className="card stack-sm">
          <h3>Support inbox</h3>
          {[[PLANT.tenant, 'Cannot find the paint thinner register on phone', 'open'], ['Supplier C: wiring harness', 'Bill upload says PDF unreadable', 'open'], ['Supplier A: pressings', 'Add Marathi language for operators', 'planned']].map(([t, m, st]) => <div key={m} className="row-between small"><span><strong>{t}</strong><br /><span className="muted">{m}</span></span><Chip tone={st === 'open' ? 'warn' : 'info'}>{st}</Chip></div>)}
        </div>
        <div className="card stack-sm">
          <h3>View as supplier (read-only)</h3>
          <p className="small muted">For support only. 30-minute, read-only, logged, and visible to the supplier.</p>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required), e.g. ticket: thinner register" />
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!reason.trim()} onClick={() => { actions.impersonate(reason); location.hash = '/dashboard'; notify('Read-only session started (audited)'); }}><Icon name="eye" size={16} />View plant as owner</button>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Audit log</h3><div className="row"><input className="input" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actions, users, entities" aria-label="Search audit log" /><button className="btn sm" onClick={actions.reset}>Reset demo data</button></div></div>
        <div className="table-wrap" style={{ maxHeight: 460 }}><table className="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
          <tbody>{rows.slice(0, 200).map((a) => <tr key={a.id}><td className="small">{new Date(a.at).toLocaleString('en-IN')}</td><td className="small">{a.actor}</td><td className="mono">{a.action}</td><td className="small">{a.entity}</td><td className="small" style={{ whiteSpace: 'normal', minWidth: 260 }}>{a.detail}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}
