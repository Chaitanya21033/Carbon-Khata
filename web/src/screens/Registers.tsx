import { useMemo, useState } from 'react';
import { BILL_MONTHS, PLANT_MONTHS, REGISTERS, useStore } from '../state/store';
import { balance, buildIndex, correctLine, lineEntries, value, primaryLine } from '../domain/ledger';
import { monthEmissions } from '../domain/emissions';
import { fmt, monthLabel } from '../domain/util';
import type { LineType, Month } from '../domain/types';
import { Icon } from '../ui/Icon';
import { Chip, Drawer, PageHead, SevChip } from '../ui/kit';

export function CorrectionDrawer({ regId, month, line, suggest, onClose, onDone }: { regId: string; month: Month; line: LineType; suggest?: { label: string; value: number }[]; onClose: () => void; onDone?: () => void }) {
  const { s, d, actions, notify, isLocked } = useStore();
  const reg = REGISTERS.find((r) => r.id === regId)!;
  const cur = value(d.idx, regId, month, line);
  const [nv, setNv] = useState(cur !== undefined ? String(cur) : '');
  const [reason, setReason] = useState('');
  const locked = isLocked(month);
  const entries = lineEntries(d.idx, regId, month, line);
  const preview = useMemo(() => {
    const n = Number(nv);
    if (nv === '' || Number.isNaN(n) || n === cur || !PLANT_MONTHS.includes(month)) return null;
    const after = correctLine(s.entries, regId, month, line, n, 'preview', 'preview').entries;
    const a = monthEmissions(REGISTERS, d.idx, s.factors, month).total;
    const b = monthEmissions(REGISTERS, buildIndex(after), s.factors, month).total;
    return Math.abs(a - b) > 0.01 ? { a, b } : null;
  }, [nv, cur, s.entries, s.factors, d.idx, regId, month, line]);
  const save = () => {
    const r = actions.correct(regId, month, line, Number(nv), reason);
    if (!r.ok) return notify(r.msg);
    notify(`Corrected ${reg.label}, ${monthLabel(month)}: ${fmt(cur, 2)} → ${fmt(Number(nv), 2)}. Original kept with a reversal.`);
    onDone?.(); onClose();
  };
  return (
    <Drawer title={`Correct: ${reg.label}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={locked || nv === '' || !reason.trim() || Number(nv) === cur} onClick={save}>Post correction</button></>}>
      <div className="stack">
        <div className="row"><Chip>{monthLabel(month, 'en', false)}</Chip><Chip>{line}</Chip><Chip>{reg.unit || 'ratio'}</Chip></div>
        {locked && <div className="banner block"><Icon name="lock" />This month is {s.closes[month]?.status === 'in_review' ? 'submitted for approval' : 'closed'}. The owner must reopen it (with a reason) before any correction.</div>}
        <div className="grid g2">
          <div className="card" style={{ boxShadow: 'none' }}><div className="xs muted">Current value</div><div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{fmt(cur, 2)}</div></div>
          <div className="field"><label htmlFor="nv">Corrected value</label><input id="nv" className="input num" inputMode="decimal" style={{ fontSize: 20 }} value={nv} onChange={(e) => setNv(e.target.value.replace(/[^\d.-]/g, ''))} disabled={locked} /></div>
        </div>
        {suggest && suggest.length > 0 && <div className="row">{suggest.map((x) => <button key={x.label} className="btn sm" disabled={locked} onClick={() => { setNv(String(Math.round(x.value * 1000) / 1000)); if (!reason) setReason(x.label); }}>{x.label}: {fmt(x.value, 1)}</button>)}</div>}
        <div className="field"><label htmlFor="rs">Reason (required, kept in the audit trail)</label><textarea id="rs" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Extra digit typed; checked against the purchase invoice" disabled={locked} /></div>
        {preview && <div className="banner info"><Icon name="info" />Month emissions change from {fmt(preview.a / 1000, 2)} t to {fmt(preview.b / 1000, 2)} t CO₂e ({preview.b > preview.a ? '+' : ''}{fmt((preview.b - preview.a) / 1000, 2)} t).</div>}
        <div className="banner ok"><Icon name="shield" />Posted entries are never edited. This creates a reversal of the old line plus a new line, both with your reason.</div>
        <div>
          <h3 style={{ marginBottom: 8 }}>Line history</h3>
          <div className="table-wrap"><table className="t"><thead><tr><th>Entry</th><th className="r">Qty</th><th>Status</th><th>By / reason</th></tr></thead>
            <tbody>{entries.map((e) => <tr key={e.id}><td className="mono">{e.reversesId ? 'reversal' : e.correctsId ? 'correction' : e.source}</td><td className="r">{fmt(e.qty, 2)}</td><td>{e.status === 'reversed' ? <Chip tone="neutral">reversed</Chip> : <Chip tone="ok">posted</Chip>}</td><td className="small" style={{ whiteSpace: 'normal', minWidth: 160 }}>{e.by}{e.reason ? ` · ${e.reason}` : ''}<br /><span className="xs muted">{new Date(e.at).toLocaleString('en-IN')}</span></td></tr>)}</tbody></table></div>
        </div>
      </div>
    </Drawer>
  );
}

export default function Registers() {
  const { d, s } = useStore();
  const [sel, setSel] = useState<string | null>(null);
  const [cat, setCat] = useState('all');
  const issuesBy = useMemo(() => {
    const m: Record<string, number> = {};
    for (const i of d.openIssues) if (i.registerId) m[i.registerId] = (m[i.registerId] ?? 0) + 1;
    return m;
  }, [d.openIssues]);
  if (sel) return <LedgerView regId={sel} onBack={() => setSel(null)} />;
  const cats = ['all', ...Array.from(new Set(REGISTERS.map((r) => r.category)))];
  const list = REGISTERS.filter((r) => cat === 'all' || r.category === cat);
  return (
    <div>
      <PageHead title="Registers" sub="Each register keeps the plant's own book logic: opening + received − issued = closing. Tap one to open its ledger." />
      <div className="chips" style={{ marginBottom: 12 }}>{cats.map((c) => <button key={c} aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}</div>
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="t">
          <thead><tr><th>Register</th><th>Category</th><th>Kept as</th><th className="r">Months</th><th>Balance</th><th className="r">Open issues</th></tr></thead>
          <tbody>
            {list.map((r) => {
              const months = r.category === 'utility' ? BILL_MONTHS : PLANT_MONTHS;
              const unb = r.mode === 'full' ? months.filter((m) => !balance(d.idx, r.id, m).ok).length : 0;
              const n = months.filter((m) => value(d.idx, r.id, m, primaryLine(r)) !== undefined).length;
              return (
                <tr key={r.id} className="clickable" onClick={() => setSel(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(r.id)}>
                  <td><strong>{s.lang === 'hi' && r.labelHi ? r.labelHi : r.label}</strong> <span className="muted xs">{r.unit}</span></td>
                  <td>{r.category}</td>
                  <td className="small">{r.mode === 'full' ? 'Opening / received / issued / closing' : r.mode === 'issue_only' ? 'Issues only' : 'Monthly reading'}</td>
                  <td className="r">{n}</td>
                  <td>{r.mode !== 'full' ? <span className="muted xs">n/a</span> : unb ? <SevChip sev="block" label={`${unb} unbalanced`} /> : <SevChip sev="ok" />}</td>
                  <td className="r">{issuesBy[r.id] ? <Chip tone="warn">{issuesBy[r.id]}</Chip> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LedgerView({ regId, onBack }: { regId: string; onBack: () => void }) {
  const { d, isLocked } = useStore();
  const reg = REGISTERS.find((r) => r.id === regId)!;
  const months = reg.category === 'utility' ? BILL_MONTHS : PLANT_MONTHS;
  const [cell, setCell] = useState<{ m: Month; line: LineType } | null>(null);
  const lines: LineType[] = reg.mode === 'full' ? ['opening', 'received', 'issued', 'closing'] : [primaryLine(reg)];
  const issueAt = new Set(d.openIssues.filter((i) => i.registerId === regId).map((i) => `${i.month}|${i.line}`));
  const corrected = (m: Month, l: LineType) => lineEntries(d.idx, regId, m, l).some((e) => e.reversesId);
  const total = months.reduce((s, m) => s + (value(d.idx, regId, m, primaryLine(reg)) ?? 0), 0);
  return (
    <div className="stack">
      <div className="row"><button className="btn sm" onClick={onBack}><span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon name="arrowright" size={16} /></span>Back to registers</button></div>
      <PageHead title={reg.label} sub={`${reg.mode === 'full' ? 'Full stock register' : reg.mode === 'issue_only' ? 'Issue register' : 'Monthly reading'} · unit ${reg.unit || 'ratio'}${reg.conversion ? ` · ${reg.conversion.factor} ${reg.unit} per ${reg.conversion.unitLabel}` : ''} · ${reg.mode === 'reading' ? 'total' : 'total issued'} ${fmt(total)} ${reg.unit}`} />
      <div className="legend"><span><i style={{ background: 'var(--danger)' }} />Fails a check</span><span><i style={{ background: 'var(--text-muted)' }} />Dotted underline = corrected (reversal + new entry)</span><span>🔒 month locked</span></div>
      <div className="table-wrap card ledger" style={{ padding: 0 }}>
        <table className="t">
          <thead><tr><th className="sticky-col">Line</th>{months.map((m) => <th key={m} className="r">{monthLabel(m)}{isLocked(m) ? ' 🔒' : ''}</th>)}</tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l}>
                <td className="sticky-col" style={{ fontWeight: 600 }}>{l}</td>
                {months.map((m) => {
                  const v = value(d.idx, regId, m, l);
                  const bad = issueAt.has(`${m}|${l}`);
                  return <td key={m} className={`r cell num ${bad ? 'bad' : ''} ${corrected(m, l) ? 'corrected' : ''}`} onClick={() => setCell({ m, line: l })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setCell({ m, line: l })} title="Click to correct">{fmt(v, reg.id === 'PF' ? 2 : 0)}</td>;
                })}
              </tr>
            ))}
            {reg.mode === 'full' && (
              <>
                <tr><td className="sticky-col muted">computed closing</td>{months.map((m) => <td key={m} className="r num muted">{fmt(balance(d.idx, regId, m).calc)}</td>)}</tr>
                <tr><td className="sticky-col muted">check</td>{months.map((m) => { const b = balance(d.idx, regId, m); return <td key={m} className="r">{b.calc === undefined ? '—' : b.ok ? <SevChip sev="ok" label="ok" /> : <SevChip sev="block" label={fmt(b.diff)} />}</td>; })}</tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      {cell && <CorrectionDrawer regId={regId} month={cell.m} line={cell.line} onClose={() => setCell(null)}
        suggest={reg.mode === 'full' && cell.line === 'closing' ? [{ label: 'Use computed closing', value: balance(d.idx, regId, cell.m).calc ?? 0 }] : (() => { const v = value(d.idx, regId, cell.m, cell.line); return v ? [{ label: 'Extra digit (÷10)', value: v / 10 }, { label: 'Missing digit (×10)', value: v * 10 }] : []; })()} />}
    </div>
  );
}
