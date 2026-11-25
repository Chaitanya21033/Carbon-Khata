import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { RULES } from '../domain/validation';
import { balance } from '../domain/ledger';
import { fmt, monthLabel } from '../domain/util';
import type { Issue, Severity } from '../domain/types';
import { Icon } from '../ui/Icon';
import { Chip, Empty, Kpi, PageHead, Seg, SevChip } from '../ui/kit';
import { Sparkline } from '../ui/Charts';
import { CorrectionDrawer } from './Registers';

export default function DataQuality() {
  const { s, d, actions, notify } = useStore();
  const [sev, setSev] = useState<'all' | Severity>('all');
  const [status, setStatus] = useState<'open' | 'accepted' | 'dismissed'>('open');
  const [rule, setRule] = useState('all');
  const [fix, setFix] = useState<Issue | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const st = (i: Issue) => s.issueStates[i.id]?.status ?? 'open';
  const list = useMemo(() => d.issues
    .filter((i) => st(i) === status && (sev === 'all' || i.severity === sev) && (rule === 'all' || i.rule === rule))
    .sort((a, b) => ({ block: 0, warn: 1, info: 2 }[a.severity] - { block: 0, warn: 1, info: 2 }[b.severity]) || a.month.localeCompare(b.month)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [d.issues, s.issueStates, sev, status, rule]);
  const open = d.openIssues;
  const count = (x: Severity) => open.filter((i) => i.severity === x).length;
  const flat = open.filter((i) => i.rule === 'V03');
  const rulesPresent = Array.from(new Set(d.issues.map((i) => i.rule))).sort();
  const canDismiss = s.role === 'custodian';

  const suggestions = (i: Issue) => {
    const out: { label: string; value: number }[] = [];
    if (i.rule === 'V05' && i.registerId) out.push({ label: 'Use computed closing', value: balance(d.idx, i.registerId, i.month).calc ?? 0 });
    if ((i.rule === 'V01' || i.rule === 'V07') && i.actual) out.push({ label: 'Extra digit (÷10)', value: i.actual / 10 });
    if (i.rule === 'V02' && i.actual) out.push({ label: 'Missing digit (×10)', value: i.actual * 10 });
    if (i.expected && i.rule !== 'V05') out.push({ label: 'Usual value', value: i.expected });
    return out;
  };

  return (
    <div className="stack">
      <PageHead title="Data quality" sub="Every check runs on entry and again on the full history. Fix it, confirm it is real (with a note), or dismiss it. Each action is logged." />
      <div className="grid g4">
        <Kpi label="Must fix" value={count('block')} tone={count('block') ? 'block' : 'ok'} sub="Blocks month close" />
        <Kpi label="Check" value={count('warn')} tone={count('warn') ? 'warn' : 'ok'} sub="Warnings" />
        <Kpi label="Insights" value={count('info')} sub="Contract demand, intensity" />
        <Kpi label="DQ score (avg)" value={fmt(d.dqAvg, 0)} unit="/100" tone={d.dqAvg < 60 ? 'block' : d.dqAvg < 80 ? 'warn' : 'ok'} sub={`Across ${Object.keys(d.dq).length} plant-months`} />
      </div>
      {s.comments.filter((c) => c.status === 'open').map((c) => (
        <div key={c.id} className="banner info"><Icon name="users" /><span><strong>OEM request:</strong> {c.text}{c.month ? ` (${monthLabel(c.month)})` : ''}</span><button className="btn sm" onClick={() => actions.closeComment(c.id)}>Mark handled</button></div>
      ))}
      {flat.length > 0 && status === 'open' && (
        <div className="banner warn"><Icon name="alert" /><span>{flat.length} registers show the same value every month. These look like estimates, not readings.</span>
          <button className="btn sm" onClick={() => { actions.bulkResolve(flat.map((i) => i.id), 'Confirmed as monthly estimate; meter to be installed'); notify(`${flat.length} flat-lined values confirmed as estimates`); }}>Confirm all as estimates</button></div>
      )}
      <div className="row-between">
        <div className="row">
          <Seg label="Status" value={status} onChange={setStatus} options={[{ v: 'open', l: `Open (${open.length})` }, { v: 'accepted', l: 'Confirmed' }, { v: 'dismissed', l: 'Dismissed' }]} />
          <Seg label="Severity" value={sev} onChange={setSev} options={[{ v: 'all', l: 'All' }, { v: 'block', l: 'Must fix' }, { v: 'warn', l: 'Check' }, { v: 'info', l: 'Insight' }]} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Rule">
          <option value="all">All rules</option>
          {rulesPresent.map((r) => <option key={r} value={r}>{r} · {RULES.find((x) => x.code === r)?.name}</option>)}
        </select>
      </div>
      {list.length === 0 ? (
        <div className="card"><Empty title={status === 'open' ? 'Nothing left to check' : 'Nothing here yet'} sub={status === 'open' ? 'All clear for this filter. Months with zero blocks can be closed.' : undefined} /></div>
      ) : (
        <div className="stack-sm">
          {list.slice(0, 120).map((i) => (
            <div key={i.id} className="card" style={{ padding: 14 }}>
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div className="stack-sm" style={{ flex: 1, minWidth: 220 }}>
                  <div className="row"><SevChip sev={i.severity} /><Chip>{i.rule}</Chip><strong>{i.field}</strong><span className="muted small">{monthLabel(i.month, 'en', false)}</span></div>
                  <p className="small">{s.lang === 'hi' ? i.messageHi : i.message}</p>
                  {(i.expected !== undefined || i.actual !== undefined) && <p className="xs muted num">Recorded {fmt(i.actual, 2)}{i.expected !== undefined ? ` · expected around ${fmt(i.expected, 2)}` : ''}</p>}
                  {s.issueStates[i.id]?.note && <p className="xs muted">Note: {s.issueStates[i.id].note} ({s.issueStates[i.id].by})</p>}
                </div>
                {i.series && i.series.length > 1 && <div className="desktop-only"><Sparkline values={i.series.map((p) => p.value)} highlight={i.series.findIndex((p) => p.month === i.month)} width={140} height={40} /></div>}
              </div>
              {status === 'open' && (
                noteFor === i.id ? (
                  <div className="row" style={{ marginTop: 10 }}>
                    <input className="input" style={{ flex: 1, minWidth: 200 }} autoFocus placeholder="Why is this value real? (required)" value={note} onChange={(e) => setNote(e.target.value)} />
                    <button className="btn sm primary" onClick={() => { const r = actions.resolveIssue(i.id, 'accepted', note); if (!r.ok) return notify(r.msg); setNoteFor(null); setNote(''); }}>Confirm</button>
                    <button className="btn sm" onClick={() => setNoteFor(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="row" style={{ marginTop: 10 }}>
                    {i.registerId && i.line && !['V06', 'V09'].includes(i.rule) && <button className="btn sm primary" onClick={() => setFix(i)}><Icon name="book" size={16} />Correct</button>}
                    <button className="btn sm" onClick={() => setNoteFor(i.id)}>{i.severity === 'info' ? 'Acknowledge' : 'Confirm as real'}</button>
                    {canDismiss && <button className="btn sm ghost" onClick={() => actions.resolveIssue(i.id, 'dismissed', 'Dismissed by custodian')}>Dismiss</button>}
                  </div>
                )
              )}
              {status !== 'open' && <div style={{ marginTop: 8 }}><button className="btn sm ghost" onClick={() => actions.resolveIssue(i.id, 'open')}>Reopen issue</button></div>}
            </div>
          ))}
          {list.length > 120 && <p className="small muted">Showing first 120 of {list.length}. Narrow with the filters.</p>}
        </div>
      )}
      {fix && <CorrectionDrawer regId={fix.registerId!} month={fix.month} line={fix.line!} suggest={suggestions(fix)} onClose={() => setFix(null)} />}
    </div>
  );
}
