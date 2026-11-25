import { useState } from 'react';
import registerTypes from '../data/register_types.json';
import { REGISTERS, useStore } from '../state/store';
import { ISSUE_ONLY, FACTORS } from '../domain/seed';
import { synthMonthlyCSV } from '../domain/synth';
import { buildIndex } from '../domain/ledger';
import { runValidation } from '../domain/validation';
import { monthEmissions, periodTotals } from '../domain/emissions';
import { fmt, parseCSV } from '../domain/util';
import type { LedgerEntry } from '../domain/types';
import { Icon } from '../ui/Icon';
import { Chip, PageHead, SevChip } from '../ui/kit';
import { verifyGstin, verifyUdyam, type KybResult } from '../api/sources';

const STEPS = [
  { name: 'Account & consent', why: 'So the right person owns the data, and the OEM only sees what you allow.' },
  { name: 'Plant setup', why: 'Contract demand and tariff let us spot penalties and cost savings from day one.' },
  { name: 'Register mapping', why: 'We copy the books you already keep. No new registers to learn.' },
  { name: 'History import', why: '12–24 months of history gives you a baseline in week one, not next year.' },
  { name: 'Validation pass', why: 'Typos in old books are normal. We find them before anyone else does.' },
  { name: 'Baseline & go-live', why: 'Your starting number: kg CO₂e per unit, plus the first savings.' },
];

const KNOWN: Record<string, string> = {
  bodies_produced: 'PROD', production: 'PROD', output: 'PROD', grid_kwh: 'GRID_KWH', kwh: 'GRID_KWH', grid_kvah: 'GRID_KVAH', power_factor: 'PF', max_demand_kva: 'MD_KVA', bill_inr: 'BILL_INR',
  ...Object.fromEntries(ISSUE_ONLY.map((d) => [d.col!, d.code])),
  co2_gas_kg: 'CO2_GAS', lpg_kg: 'LPG', hyd_oil_l: 'HYD_OIL', argon_m3: 'ARGON', oxygen_as_recorded: 'OXYGEN',
};
function guess(col: string): string {
  const c = col.toLowerCase();
  if (KNOWN[c]) return KNOWN[c];
  if (c.includes('diesel')) return 'DIESEL';
  if (c.includes('lpg')) return 'LPG';
  if (c.includes('kwh')) return 'GRID_KWH';
  if (c.includes('bill') || c.includes('amount')) return 'BILL_INR';
  if (c.includes('prod') || c.includes('output')) return 'PROD';
  return '';
}

export default function Onboarding() {
  const { s, actions, notify } = useStore();
  const w = s.wizard;
  const [raw, setRaw] = useState<{ name: string; text: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState(false);
  const [kyb, setKyb] = useState<{ g?: KybResult; u?: KybResult; busy?: boolean }>({});
  const setStep = (n: number) => actions.setWizard({ step: Math.max(0, Math.min(STEPS.length - 1, n)) });
  const udyamOk = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(w.udyam.trim().toUpperCase());
  const gstOk = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(w.gstin.trim().toUpperCase());
  const canNext = [w.company.trim() && udyamOk && gstOk && w.consent, Number(w.contractDemand) > 0, w.registers.length > 0, !!w.importSummary, !!w.importSummary, true][w.step];

  const loadText = (name: string, text: string) => {
    const rows = parseCSV(text);
    const cols = Object.keys(rows[0] ?? {});
    setRaw({ name, text });
    setMapping(Object.fromEntries(cols.map((c) => [c, guess(c)])));
  };

  const commit = () => {
    if (!raw) return;
    const rows = parseCSV(raw.text);
    const cols = Object.keys(rows[0]);
    const monthCol = cols.find((c) => rows.every((r) => /^\d{4}-\d{2}$/.test(r[c])));
    if (!monthCol) return notify('No month column found (expected values like 2024-04).');
    const entries: LedgerEntry[] = [];
    let n = 0;
    for (const r of rows) for (const [c, reg] of Object.entries(mapping)) {
      if (!reg || c === monthCol || r[c] === '') continue;
      const def = REGISTERS.find((x) => x.id === reg); if (!def) continue;
      entries.push({ id: `imp${n++}`, registerId: reg, month: r[monthCol], line: def.mode === 'reading' ? 'reading' : 'issued', qty: Number(r[c]), status: 'posted', by: 'import', at: new Date().toISOString(), source: 'import' });
    }
    const months = rows.map((r) => r[monthCol]);
    const regs = REGISTERS.filter((x) => Object.values(mapping).includes(x.id)).map((x) => (x.mode === 'full' ? { ...x, mode: 'issue_only' as const } : x));
    const idx = buildIndex(entries);
    const issues = runValidation({ registers: regs, idx, plantMonths: months, billMonths: months, contractDemandKva: Number(w.contractDemand) || 600 });
    const byRule: Record<string, number> = {};
    for (const i of issues) byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
    const hasProd = regs.some((x) => x.id === 'PROD');
    const t = hasProd ? periodTotals(months.map((m) => monthEmissions(regs, idx, FACTORS, m))) : null;
    actions.setWizard({ importSummary: { rows: rows.length, months: months.length, registers: new Set(Object.values(mapping).filter(Boolean)).size, issues: byRule, intensity: t?.intensity, kwhPerUnit: t ? t.kwh / t.output : undefined, source: raw.name } });
    notify(`Imported ${entries.length} lines from ${raw.name}`);
  };

  const blocks = w.importSummary ? ['V01', 'V02', 'V05', 'V12'].reduce((a, r) => a + (w.importSummary!.issues[r] ?? 0), 0) : 0;

  return (
    <div className="stack" style={{ maxWidth: 1000 }}>
      <PageHead title="Onboard a supplier" sub="Target: interested → first verified month in 14 days, no hardware. Progress saves after every field; resume from any device."
        actions={<><button className="btn" onClick={() => notify('Calling your field associate… (demo)')}><Icon name="phone" size={16} />Call my associate</button><button className="btn ghost sm" onClick={() => { actions.setWizard({ step: 0, company: '', udyam: '', gstin: '', consent: false, importSummary: undefined }); setRaw(null); }}>Restart</button></>} />
      <div className="wsteps" role="list">
        {STEPS.map((st, i) => (
          <button key={st.name} role="listitem" className={`wstep ${i === w.step ? 'cur' : i < w.step ? 'done' : ''}`} onClick={() => i <= w.step && setStep(i)} aria-current={i === w.step ? 'step' : undefined}>
            <span className="n">{i < w.step ? '✓' : i + 1}</span>{st.name}
          </button>
        ))}
      </div>
      <div className="banner info"><Icon name="info" /><span><strong>Why we need this:</strong> {STEPS[w.step].why}</span></div>

      <div className="card stack">
        {w.step === 0 && (
          <>
            <div className="grid g3">
              <div className="field"><label htmlFor="co">Company (legal name)</label><input id="co" className="input" value={w.company} onChange={(e) => actions.setWizard({ company: e.target.value })} placeholder="e.g. Shakti Pressings Pvt Ltd" /></div>
              <div className="field"><label htmlFor="ud">Udyam number</label><input id="ud" className="input" value={w.udyam} onChange={(e) => actions.setWizard({ udyam: e.target.value })} placeholder="UDYAM-JH-05-0012345" />{w.udyam && <span className="xs" style={{ color: udyamOk ? 'var(--success)' : 'var(--danger)' }}>{udyamOk ? 'Format OK' : 'Format: UDYAM-XX-00-0000000'}</span>}</div>
              <div className="field"><label htmlFor="gs">GSTIN</label><input id="gs" className="input" value={w.gstin} onChange={(e) => actions.setWizard({ gstin: e.target.value })} placeholder="20ABCDE1234F1Z5" />{w.gstin && <span className="xs" style={{ color: gstOk ? 'var(--success)' : 'var(--danger)' }}>{gstOk ? 'Format OK' : '15 characters, e.g. 20ABCDE1234F1Z5'}</span>}</div>
            </div>
            <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-muted)' }}>
              <h3>Data consent (plain language)</h3>
              <ul className="small"><li>Your OEM sees monthly emission totals, intensity per unit and a data-quality score. Nothing else unless you say so.</li><li>They never see your costs, bills, slips or other customers' volumes.</li><li>You can switch this off any time. We log every change.</li></ul>
              <label className="row small" style={{ marginTop: 6 }}><input type="checkbox" checked={w.consent} onChange={(e) => actions.setWizard({ consent: e.target.checked })} /> I agree to share the summary with my OEM</label>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => actions.setWizard({ company: 'Shakti Pressings Pvt Ltd', udyam: 'UDYAM-JH-05-0012345', gstin: '20ABCDE1234F1Z5', consent: true })}>Fill demo values</button>
              <button className="btn sm primary" disabled={kyb.busy || !w.gstin} onClick={async () => { setKyb({ busy: true }); const [g, u] = await Promise.all([verifyGstin(w.gstin), verifyUdyam(w.udyam)]); setKyb({ g, u }); }}>{kyb.busy ? 'Verifying…' : 'Verify GSTIN & Udyam'}</button>
            </div>
            {(kyb.g || kyb.u) && (
              <div className="card stack-sm" style={{ boxShadow: 'none' }}>
                {kyb.g && <div className="row small"><Chip tone={kyb.g.ok ? 'ok' : 'block'}>GSTIN {kyb.g.ok ? 'valid' : 'invalid'}</Chip>{kyb.g.ok && <span>{kyb.g.name} · {kyb.g.status} · {kyb.g.state}</span>}</div>}
                {kyb.u && <div className="row small"><Chip tone={kyb.u.ok ? 'ok' : 'block'}>Udyam {kyb.u.ok ? 'valid' : 'invalid'}</Chip>{kyb.u.ok && <span>{kyb.u.status}</span>}</div>}
                <span className="xs muted">{kyb.g?.note}</span>
              </div>
            )}
          </>
        )}
        {w.step === 1 && (
          <>
            <div className="grid g4">
              <div className="field"><label htmlFor="pr">Main product</label><input id="pr" className="input" value={w.product} onChange={(e) => actions.setWizard({ product: e.target.value })} /></div>
              <div className="field"><label htmlFor="un">Counted in</label><select id="un" className="input" value={w.unit} onChange={(e) => actions.setWizard({ unit: e.target.value })}>{['nos', 'kg', 't', 'sets'].map((u) => <option key={u}>{u}</option>)}</select></div>
              <div className="field"><label htmlFor="cd">Contract demand (kVA)</label><input id="cd" className="input num" inputMode="numeric" value={w.contractDemand} onChange={(e) => actions.setWizard({ contractDemand: e.target.value.replace(/\D/g, '') })} /></div>
              <div className="field"><label htmlFor="ut">Electricity utility</label><input id="ut" className="input" value={w.utility} onChange={(e) => actions.setWizard({ utility: e.target.value })} /></div>
            </div>
            <label className="card row" style={{ boxShadow: 'none', cursor: 'pointer', borderStyle: 'dashed' }}><Icon name="upload" /><span className="small"><strong>Upload one recent electricity bill</strong> (photo or PDF). The AI reader fills kWh, kVAh, PF, maximum demand and amount for you to confirm.</span>
              <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={() => notify('Bill read: 1,57,620 kWh · 1,65,920 kVAh · PF 0.95 · MD 670 kVA · ₹10,93,551 (demo). Please confirm.')} /></label>
          </>
        )}
        {w.step === 2 && (
          <>
            <p className="small muted">Tick the registers this plant already keeps. Units and cylinder sizes convert automatically.</p>
            <div className="grid g3">
              {(registerTypes as { register_types: { code: string; name: string; unit: string; category: string; cylinder_size?: number; hazardous?: boolean }[] }).register_types.map((r) => {
                const on = w.registers.includes(r.code);
                return (
                  <label key={r.code} className="persona" style={{ boxShadow: 'none', background: on ? 'var(--primary-soft)' : undefined }}>
                    <input type="checkbox" checked={on} onChange={() => actions.setWizard({ registers: on ? w.registers.filter((x) => x !== r.code) : [...w.registers, r.code] })} />
                    <span><strong className="small">{r.name}</strong><br /><span className="xs muted">{r.category} · {r.unit}{r.cylinder_size ? ` · ${r.cylinder_size} per cylinder` : ''}{r.hazardous ? ' · hazardous' : ''}</span></span>
                  </label>
                );
              })}
            </div>
            <p className="xs muted">{w.registers.length} registers mapped. Plant-specific SKUs (paint shades, chemicals) can be added after go-live.</p>
          </>
        )}
        {w.step === 3 && (
          <>
            <div className="grid g3">
              <label className="card stack-sm" style={{ boxShadow: 'none', cursor: 'pointer' }}><Icon name="upload" /><strong className="small">a) Excel / CSV template</strong><span className="xs muted">One row per month, one column per register. We map the columns.</span>
                <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) loadText(f.name, await f.text()); }} /></label>
              <button className="card stack-sm" style={{ boxShadow: 'none', cursor: 'pointer', textAlign: 'left' }} onClick={() => setPhoto(true)}><Icon name="camera" /><strong className="small">b) Photo of register pages</strong><span className="xs muted">AI turns each page into a table for you to confirm.</span></button>
              <button className="card stack-sm" style={{ boxShadow: 'none', cursor: 'pointer', textAlign: 'left' }} onClick={() => loadText('sample_supplier_history_24m.csv', synthMonthlyCSV())}><Icon name="file" /><strong className="small">Use a sample history file</strong><span className="xs muted">24 months of dummy data, typos included.</span></button>
            </div>
            {photo && (
              <div className="card" style={{ boxShadow: 'none' }}>
                <div className="row-between"><strong className="small">Register page → extracted table (confirm before import)</strong><Chip tone="warn">2 cells low confidence</Chip></div>
                <div className="table-wrap" style={{ marginTop: 8 }}><table className="t"><thead><tr><th>Month</th><th className="r">Opening</th><th className="r">Received</th><th className="r">Issued</th><th className="r">Closing</th></tr></thead>
                  <tbody><tr><td>Mar 2025</td><td className="r">1,260</td><td className="r">840</td><td className="r" style={{ background: 'var(--accent-soft)' }}>912 ?</td><td className="r">1,188</td></tr><tr><td>Apr 2025</td><td className="r">1,188</td><td className="r">630</td><td className="r">874</td><td className="r" style={{ background: 'var(--accent-soft)' }}>944 ?</td></tr></tbody></table></div>
                <p className="xs muted" style={{ marginTop: 6 }}>Demo of the hydraulic-oil page. Highlighted cells need a human check before they are posted.</p>
              </div>
            )}
            {raw && (
              <div className="stack-sm">
                <div className="row-between"><strong className="small">{raw.name}: map columns to registers</strong><span className="xs muted">{Object.values(mapping).filter(Boolean).length} of {Object.keys(mapping).length} mapped</span></div>
                <div className="table-wrap" style={{ maxHeight: 320 }}><table className="t"><thead><tr><th>Column in file</th><th>Register</th></tr></thead>
                  <tbody>{Object.keys(mapping).map((c) => <tr key={c}><td className="mono">{c}</td><td><select className="input" style={{ minHeight: 34 }} value={mapping[c]} onChange={(e) => setMapping({ ...mapping, [c]: e.target.value })} aria-label={`Register for ${c}`}><option value="">— skip —</option>{REGISTERS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></td></tr>)}</tbody></table></div>
                <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={commit}><Icon name="check" size={16} />Import and run checks</button>
              </div>
            )}
            {w.importSummary && <div className="banner ok"><Icon name="check" />{w.importSummary.source}: {w.importSummary.rows} months, {w.importSummary.registers} registers imported.</div>}
          </>
        )}
        {w.step === 4 && w.importSummary && (
          <>
            <div className="grid g4">
              {Object.entries(w.importSummary.issues).sort().map(([r, n]) => (
                <div key={r} className="card" style={{ boxShadow: 'none' }}><div className="row-between"><Chip>{r}</Chip><SevChip sev={['V01', 'V02', 'V05', 'V10', 'V12'].includes(r) ? 'block' : ['V06', 'V09'].includes(r) ? 'info' : 'warn'} /></div><div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-head)' }}>{n}</div></div>
              ))}
            </div>
            <div className={`banner ${blocks ? 'warn' : 'ok'}`}><Icon name={blocks ? 'alert' : 'check'} />{blocks ? `${blocks} must-fix entries found (extra digits, missing digits). The associate walks the custodian through them in Data quality.` : 'No blocking issues. Ready for baseline.'}</div>
          </>
        )}
        {w.step === 5 && w.importSummary && (
          <>
            <div className="grid g3">
              <div className="card kpi" style={{ boxShadow: 'none' }}><span className="k-label">Baseline</span><span className="k-value">{fmt(w.importSummary.intensity, 1)}<span className="k-unit">kg CO₂e / {w.product.toLowerCase()}</span></span><span className="k-sub">Scope 1 + 2, as imported</span></div>
              <div className="card kpi" style={{ boxShadow: 'none' }}><span className="k-label">Electricity</span><span className="k-value">{fmt(w.importSummary.kwhPerUnit, 0)}<span className="k-unit">kWh / unit</span></span></div>
              <div className="card kpi" style={{ boxShadow: 'none' }}><span className="k-label">Months of history</span><span className="k-value">{w.importSummary.months}</span></div>
            </div>
            <h3>Go-live kit</h3>
            <div className="grid g4">
              {w.registers.slice(0, 8).map((r) => (
                <div key={r} className="card" style={{ boxShadow: 'none', textAlign: 'center' }}><Icon name="qr" size={44} /><div className="xs" style={{ marginTop: 4 }}><strong>{r}</strong><br />Scan → opens the entry form</div></div>
              ))}
            </div>
            <div className="row">
              <button className="btn" onClick={() => window.print()}><Icon name="print" size={16} />Print QR cards</button>
              <button className="btn primary" onClick={() => notify("Baseline sent to the owner's phone on WhatsApp (demo). 30-minute operator training booked.")}><Icon name="share" size={16} />Send baseline to owner</button>
            </div>
          </>
        )}
        <div className="row-between" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <button className="btn" disabled={w.step === 0} onClick={() => setStep(w.step - 1)}>Back</button>
          {w.step < STEPS.length - 1 && <button className="btn primary" disabled={!canNext} onClick={() => setStep(w.step + 1)}>Continue<Icon name="arrowright" size={16} /></button>}
        </div>
      </div>
    </div>
  );
}
