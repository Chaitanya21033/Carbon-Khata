import { useEffect, useState } from 'react';

export interface Dev {
  id: string; label: string; unit: string; kind: 'energy' | 'carbon'; overridable: boolean; description: string; value: number | null; online: boolean;
  override: { mode: 'fixed' | 'offset'; value: number; until: number | null } | null; clock: number; topic: string; history?: [number, number][];
}
const hhmm = (t: number) => { const d = new Date(t); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const num = (v: number | null | undefined, unit: string) => (v == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: unit === 'ppm' || unit === 'kW' ? 0 : 1 }));

function Spark({ pts, unit }: { pts: [number, number][]; unit: string }) {
  if (pts.length < 2) return <div className="dev-spark muted">collecting readings…</div>;
  const W = 560, H = 140, vs = pts.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * W, y = (v: number) => H - 8 - ((v - lo) / span) * (H - 24);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="dev-spark" role="img" aria-label="Last readings">
      <polyline points={pts.map((p, i) => `${x(i)},${y(p[1])}`).join(' ')} fill="none" stroke="#2EC4B6" strokeWidth="2.2" />
      <text x="4" y="12" fontSize="11" fill="#8A979F">{num(hi, unit)} {unit}</text>
      <text x="4" y={H - 2} fontSize="11" fill="#8A979F">{num(lo, unit)} · {hhmm(pts[0][0])} → {hhmm(pts[pts.length - 1][0])}</text>
    </svg>
  );
}

/** One field device on its own page: live reading, history, override and online/offline. Open it on any phone or tab. */
export function DevicePage({ id }: { id: string }) {
  const [d, setD] = useState<Dev | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'fixed' | 'offset'>('fixed');
  const [val, setVal] = useState('');
  const [mins, setMins] = useState('');
  const load = () => fetch(`/sim/devices/${id}?points=120`).then((r) => (r.ok ? r.json() : Promise.reject(r.statusText))).then((x) => { setD(x); setErr(null); }).catch(() => setErr('Device not reachable. Is the simulator running?'));
  useEffect(() => { load(); const t = window.setInterval(load, 1000); return () => window.clearInterval(t); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const post = (path: string, body: unknown) => fetch(`/sim/devices/${id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).then(setD);
  if (!d) return <div className="dev-page"><div className="card">{err ?? 'Connecting…'}</div></div>;
  const o = d.override;
  return (
    <div className="dev-page">
      <a className="dev-back" href="#/devices">← All devices</a>
      <div className={`card dev-head ${d.kind}`}>
        <div className="dev-kind">{d.kind === 'carbon' ? 'CO₂ analyser' : 'Energy device'} · {d.id}</div>
        <h1>{d.label}</h1>
        <p className="small muted">{d.description}</p>
        <div className="dev-value"><span className="num">{num(d.value, d.unit)}</span><span className="dev-unit">{d.unit}</span></div>
        <div className="row small">
          <span className={`pill ${d.online ? 'ok' : 'bad'}`}>{d.online ? 'reporting' : 'offline'}</span>
          {o && <span className="pill warn">override: {o.mode} {o.value}{o.until ? ` until ${hhmm(o.until)}` : ''}</span>}
          <span className="muted">plant time {hhmm(d.clock)}</span>
        </div>
      </div>
      <div className="card"><h3>Last two hours</h3><Spark pts={d.history ?? []} unit={d.unit} /></div>
      {d.overridable ? (
        <div className="card stack">
          <h3>Change the reading</h3>
          <div className="cseg" role="group">{(['fixed', 'offset'] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'fixed' ? 'Set a fixed value' : 'Add an offset'}</button>)}</div>
          <label className="field">{mode === 'fixed' ? `New reading (${d.unit})` : `Offset (${d.unit}, can be negative)`}<input className="input num" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder={mode === 'fixed' ? num(d.value, d.unit) : '+20'} /></label>
          <label className="field">For how long (plant minutes, empty = until reset)<input className="input num" inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="row">
            <button className="cbtn on" disabled={val.trim() === '' || Number.isNaN(Number(val))} onClick={() => post('override', { mode, value: Number(val), minutes: mins ? Number(mins) : null })}>Apply</button>
            <button className="cbtn" disabled={!o} onClick={() => post('override', { mode: 'auto' })}>Back to automatic</button>
          </div>
          <p className="xs muted">The device reports the changed value to CarbonKhata on {d.topic}. The product sees only the reading, as it would from real hardware.</p>
        </div>
      ) : <div className="card small muted">This reading is computed by the site controller from the dispatch and cannot be set directly.</div>}
      <div className="card row-between">
        <span><b>Reporting</b><br /><span className="small muted">Simulate a cable fault or a dead gateway.</span></span>
        <button className={`cbtn ${d.online ? 'bad' : 'on'}`} onClick={() => post('online', { online: !d.online })}>{d.online ? 'Stop reporting' : 'Resume reporting'}</button>
      </div>
      <p className="xs muted">API: GET / POST {location.origin}/sim/devices/{d.id} · fictional demo plant.</p>
    </div>
  );
}

export function DeviceIndex() {
  const [ds, setDs] = useState<Dev[]>([]);
  useEffect(() => { const l = () => fetch('/sim/devices').then((r) => r.json()).then(setDs).catch(() => undefined); l(); const t = window.setInterval(l, 1500); return () => window.clearInterval(t); }, []);
  return (
    <div className="dev-page">
      <a className="dev-back" href="#/">← Demo controls</a>
      <h1>Field devices</h1>
      <p className="small muted">Each device has its own page. Open them in separate tabs or on different phones.</p>
      <div className="dev-grid">
        {ds.map((d) => (
          <a key={d.id} className={`card dev-tile ${d.kind}`} href={`#/device/${d.id}`} target="_blank" rel="noreferrer">
            <span className="dev-kind">{d.kind === 'carbon' ? 'CO₂' : 'Energy'}{d.override ? ' · overridden' : ''}{d.online ? '' : ' · offline'}</span>
            <b>{d.label}</b>
            <span><span className="num" style={{ fontSize: 26, fontWeight: 700 }}>{num(d.value, d.unit)}</span> {d.unit}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
