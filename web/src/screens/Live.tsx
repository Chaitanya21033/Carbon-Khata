import { useMemo, useState } from 'react';
import { useSim } from '../live/LiveProvider';
import { METERS, STATIONS, type SimEngine } from '../live/engine';
import Pipeline from '../live/Pipeline';
import { REGISTERS, useStore } from '../state/store';
import { monthEmissions } from '../domain/emissions';
import { fmt } from '../domain/util';
import { PLANT } from '../domain/seed';
import { Icon } from '../ui/Icon';
import { PhotosCard, SensorsCard, type SensorView } from '../ui/Shopfloor';
import { Chip } from '../ui/kit';

const COL: Record<string, string> = { comp: '#4C9BE8', weld: '#F2A900', paint: '#E8743B', light: '#9FD5AE', util: '#7C8C84' };

export function clockLabel(t: number) {
  const d = new Date(t);
  return {
    date: d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }),
  };
}

function Gauge({ value, max, limit }: { value: number; max: number; limit: number }) {
  const ang = (v: number) => Math.PI * (1 - Math.min(1, v / max));
  const pt = (v: number, r: number) => ({ x: 100 + r * Math.cos(ang(v)), y: 100 - r * Math.sin(ang(v)) });
  const arc = (a: number, b: number, r: number) => { const s = pt(a, r), e = pt(b, r); return `M${s.x},${s.y} A${r},${r} 0 0 1 ${e.x},${e.y}`; };
  const over = value > limit;
  const n = pt(Math.min(value, max), 80);
  return (
    <svg viewBox="0 0 200 118" width="100%" style={{ maxWidth: 220, display: 'block', margin: '0 auto' }} role="img" aria-label={`Demand ${value.toFixed(0)} kVA of ${limit} contract`}>
      <path d={arc(0, limit, 80)} stroke="var(--primary-soft)" strokeWidth="14" fill="none" />
      <path d={arc(limit, max, 80)} stroke="var(--danger-soft)" strokeWidth="14" fill="none" />
      <path d={arc(0, Math.min(value, max), 80)} stroke={over ? 'var(--danger)' : 'var(--primary)'} strokeWidth="14" fill="none" strokeLinecap="round" style={{ transition: 'all .3s' }} />
      <circle cx={n.x} cy={n.y} r="5" fill="var(--text)" style={{ transition: 'all .3s' }} />
      <text x={pt(limit, 96).x} y={pt(limit, 96).y} fontSize="9" textAnchor="middle" fill="var(--danger)">{limit}</text>
      <text x="100" y="96" textAnchor="middle" fontSize="26" fontWeight="700" fontFamily="var(--font-head)" fill={over ? 'var(--danger)' : 'var(--text)'}>{value.toFixed(0)}</text>
      <text x="100" y="116" textAnchor="middle" fontSize="10" fill="var(--text-muted)">kVA now · contract {limit}</text>
    </svg>
  );
}

function LoadChart({ e }: { e: SimEngine }) {
  const pts = e.series;
  const W = 640, H = 220, pl = 40, pr = 10, pt = 10, pb = 22;
  const keys = ['comp', 'weld', 'paint', 'light', 'util'] as const;
  const max = Math.max(e.contractKva * 1.1, ...pts.map((p) => p.kva * 1.05));
  const n = Math.max(pts.length, 2);
  const x = (i: number) => pl + ((W - pl - pr) * i) / 239;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const offset = 240 - n;
  const layers = keys.map((k, ki) => {
    const top = pts.map((p, i) => ({ x: x(i + offset), y: y(keys.slice(0, ki + 1).reduce((s, kk) => s + p[kk], 0)) }));
    const bot = pts.map((p, i) => ({ x: x(i + offset), y: y(keys.slice(0, ki).reduce((s, kk) => s + p[kk], 0)) })).reverse();
    return { k, d: top.length ? `M${top.map((q) => `${q.x},${q.y}`).join(' L')} L${bot.map((q) => `${q.x},${q.y}`).join(' L')} Z` : '' };
  });
  const kvaLine = pts.map((p, i) => `${x(i + offset)},${y(p.kva)}`).join(' ');
  const ticks = pts.filter((p) => new Date(p.t).getUTCMinutes() === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Live electrical load, last four hours" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={pl} x2={W - pr} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" strokeDasharray={f ? '3 4' : ''} /><text x={pl - 6} y={y(max * f) + 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">{Math.round(max * f)}</text></g>)}
      {layers.map((l) => <path key={l.k} d={l.d} fill={COL[l.k]} opacity="0.85" />)}
      <polyline points={kvaLine} fill="none" stroke="var(--text)" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1={pl} x2={W - pr} y1={y(e.contractKva)} y2={y(e.contractKva)} stroke="var(--danger)" strokeWidth="1.5" strokeDasharray="7 4" />
      <text x={W - pr} y={y(e.contractKva) - 4} fontSize="10" textAnchor="end" fill="var(--danger)">contract {e.contractKva} kVA</text>
      {ticks.map((p) => { const i = pts.indexOf(p) + offset; return <text key={p.t} x={x(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--text-muted)">{clockLabel(p.t).time}</text>; })}
      {pts.length > 0 && <circle cx={x(pts.length - 1 + offset)} cy={y(pts[pts.length - 1].kva)} r="4" fill="var(--text)" className="live-dot" />}
    </svg>
  );
}

function Line({ e }: { e: SimEngine }) {
  const bySt = STATIONS.map((_, i) => e.tokens.filter((t) => t.station === i).sort((a, b) => a.id - b.id));
  return (
    <div className="line-wrap">
      <div className="line-stations">
        {STATIONS.map((s, i) => (
          <div key={s.id} className={`line-st ${bySt[i].length ? 'busy' : ''}`}>
            <div className="small" style={{ fontWeight: 600 }}>{s.label}</div>
            <div className="xs muted">{bySt[i].length}/{s.cap} · {s.mins} min</div>
          </div>
        ))}
      </div>
      <div className="line-track">
        {e.tokens.map((t) => {
          const slot = bySt[t.station].indexOf(t);
          const pct = t.since ? Math.max(0, Math.min(1, (e.clock - t.since) / (STATIONS[t.station].mins * 60_000))) : 0.5;
          return (
            <div key={t.id} className="body-token" style={{ left: `calc(${t.station * 20}% + 6px)`, top: 6 + slot * 34 }}>
              <span>#{t.id}</span><i style={{ width: `${pct * 100}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Live() {
  const { engine: e, connected, error } = useSim();
  const { s, d } = useStore();
  const [rFix, setRFix] = useState<Record<string, string>>({});
  const mtd = useMemo(() => (e ? monthEmissions(REGISTERS, d.idx, s.factors, e.month) : null), [d.idx, s.factors, e?.month]);
  if (error) return <div className="banner block"><Icon name="alert" />The live feed is not available: {error}</div>;
  if (!e) return <div className="card"><h3>Waiting for the plant's live feed…</h3><p className="small muted">Readings arrive from the smart meters and shop-floor phones. If this stays empty, start the plant feed (the simulator, in the demo).</p></div>;
  const c = clockLabel(e.clock);
  const kw = e.kw;
  const meterSpark = (k: string) => e.series.slice(-60).map((p) => (p as unknown as Record<string, number>)[k]);
  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <div className="row"><span className={`live-pill ${connected ? '' : 'paused'}`}><span />{connected ? 'LIVE' : 'RECONNECTING'}</span><h1 style={{ fontSize: 22 }}>{PLANT.tenant}</h1></div>
          <p className="small muted" style={{ marginTop: 4 }}>{PLANT.plant} · demo plant, all data is dummy</p>
        </div>
        <div className="sim-clock"><div className="num">{c.time}</div><div className="xs">{c.date} · Shift {e.shift} · plant clock (IST)</div></div>
      </div>

      <div className="grid g6">
        <div className="card kpi"><span className="k-label">Live load</span><span className="k-value">{fmt(kw, 0)}<span className="k-unit">kW</span></span><span className="k-sub">PF {e.pf.toFixed(3)} {e.last.dg > 0 ? '· on DG set' : ''}</span></div>
        <div className="card kpi"><span className="k-label">Bodies today</span><span className="k-value">{e.today.bodies}</span><span className="k-sub">{e.tokens.length} on the line</span></div>
        <div className="card kpi"><span className="k-label">Energy today</span><span className="k-value">{fmt(e.today.kwh, 0)}<span className="k-unit">kWh</span></span><span className="k-sub">meter {fmt(e.meterCum, 0)}</span></div>
        <div className="card kpi"><span className="k-label">CO₂e today</span><span className="k-value">{fmt(e.kgToday, 0)}<span className="k-unit">kg</span></span><span className="k-sub">{e.today.bodies ? `${fmt(e.kgToday / e.today.bodies, 0)} kg per body` : 'no bodies yet'}</span></div>
        <div className="card kpi"><span className="k-label">Month to date</span><span className="k-value">{mtd ? fmt(mtd.total / 1000, 1) : '—'}<span className="k-unit">t CO₂e</span></span><span className="k-sub">{mtd ? `${fmt(mtd.output)} bodies · ${fmt(mtd.intensity, 0)} kg/body` : ''}</span></div>
        <div className="card kpi"><span className="k-label">Held for review</span><span className="k-value" style={{ color: e.quarantine.length ? 'var(--danger)' : undefined }}>{e.quarantine.length}</span><span className="k-sub">{e.totals.flagged} caught since start</span></div>
      </div>

      <SensorsCard sensors={(e as unknown as { sensors: SensorView[] }).sensors} />
      <PhotosCard />
      <div className="card row-between" style={{ padding: '10px 14px' }}>
        <span className="small"><strong>Grid now:</strong> RTM ₹{e.last.price.toFixed(2)}/kWh · stress {e.market.stress}/100 · solar {fmt(e.last.solar, 0)} kW · battery {fmt(e.ems.bess.soc * 100, 0)}% {e.last.bess > 1 ? '(discharging)' : e.last.bess < -1 ? '(charging)' : ''} · genset {e.last.genset > 0 ? 'on' : 'off'} · {e.last.exp > 1 ? `exporting ${fmt(e.last.exp, 0)} kW` : `importing ${fmt(e.last.imp, 0)} kW`}</span>
        <span className="small" style={{ color: 'var(--success)' }}>₹{fmt(e.ems.last24().naiveCost - e.ems.last24().cost, 0)} saved in last 24 h · <a href="#/energy">Energy & grid →</a></span>
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div className="card-head" style={{ marginBottom: 6 }}><h3>Data flow: shop floor → checks → ledger → reports</h3><span className="xs muted">Every dot is a real packet in the simulation</span></div>
        <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 760 }}>
          <Pipeline engine={e} ledgerCount={s.entries.length} />
        </div></div>
      </div>

      <div className="grid g3">
        <div className="card span2">
          <div className="card-head"><div><h3>Live electrical load</h3><p className="xs muted">kW by sub-meter, last 4 simulated hours; dashed line = kVA</p></div>
            <div className="legend">{METERS.map((m) => <span key={m.id}><i style={{ background: COL[m.id] }} />{m.label}</span>)}</div></div>
          <LoadChart e={e} />
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 6 }}>Demand vs contract</h3>
          <Gauge value={e.last.kva} max={e.contractKva * 1.3} limit={e.contractKva} />
          <div className="row-between small" style={{ marginTop: 6 }}><span className="muted">Peak 15-min today</span><strong className="num" style={{ color: e.today.peakKva > e.contractKva ? 'var(--danger)' : undefined }}>{fmt(e.today.peakKva, 0)} kVA</strong></div>
          <div className="row-between small"><span className="muted">Power factor</span><strong className="num">{e.pf.toFixed(3)}</strong></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Production line</h3><span className="xs muted">Each card is a tipper body moving through the shop. Finishing inspection posts one unit to the ledger.</span></div>
        <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 620 }}><Line e={e} /></div></div>
      </div>

      <div className="grid g5-sub">
        {METERS.map((m) => {
          const v = (e.last as unknown as Record<string, number>)[m.id];
          const sp = meterSpark(m.id);
          const mx = Math.max(1, ...sp);
          return (
            <div key={m.id} className="card" style={{ padding: 12 }}>
              <div className="row-between"><span className="small" style={{ fontWeight: 600 }}><i className="dot" style={{ background: COL[m.id] }} />{m.label}</span></div>
              <div className="num" style={{ fontFamily: 'var(--font-head)', fontSize: 24, fontWeight: 700 }}>{fmt(v, 0)} <span className="xs muted">kW</span></div>
              <svg viewBox="0 0 120 30" width="100%" height="30" preserveAspectRatio="none" aria-hidden="true"><polyline points={sp.map((y, i) => `${(i / 59) * 120},${28 - (y / mx) * 26}`).join(' ')} fill="none" stroke={COL[m.id]} strokeWidth="1.6" /></svg>
              <div className="xs muted">{fmt(e.meterKwh[m.id], 0)} kWh since start</div>
            </div>
          );
        })}
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h3>Event stream</h3><Chip tone="neutral">{e.events.length} recent</Chip></div>
          <div className="feed" role="log" aria-live="polite">
            {e.events.slice(0, 40).map((ev) => (
              <div key={ev.id} className={`feed-row ${ev.level}`}><span className="mono">{clockLabel(ev.t).time}</span><i />{ev.text}</div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Held for review</h3><span className="xs muted">Nothing reaches the ledger until a person decides</span></div>
          {e.quarantine.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}><Icon name="check" size={28} /><p className="small">All packets passed the checks. Use the demo controls to inject a mistake.</p></div>
          ) : (
            <div className="stack-sm" style={{ maxHeight: 360, overflowY: 'auto' }}>
              {e.quarantine.map((q) => (
                <div key={q.id} className="held">
                  <div className="row"><Chip tone="block">{q.rule}</Chip><strong className="small">{REGISTERS.find((r) => r.id === q.registerId)?.label ?? q.registerId}</strong><span className="xs muted">{clockLabel(typeof q.t === 'string' ? Date.parse(q.t) + 19_800_000 : q.t).time} · {q.docRef}</span></div>
                  <p className="small" style={{ margin: '4px 0 8px' }}>{q.reason}</p>
                  <div className="row">
                    {q.rule !== 'V11' && <input className="input num" style={{ width: 120, minHeight: 34 }} aria-label="Corrected value" placeholder={String(q.suggested ?? q.qty)} value={rFix[q.id] ?? ''} onChange={(ev) => setRFix({ ...rFix, [q.id]: ev.target.value.replace(/[^\d.]/g, '') })} />}
                    <button className="btn sm primary" onClick={() => e.resolve(q.id, 'fix', rFix[q.id] ? Number(rFix[q.id]) : undefined)}>{q.rule === 'V11' ? 'Re-take reading' : `Post ${fmt(rFix[q.id] ? Number(rFix[q.id]) : q.suggested ?? q.qty)}`}</button>
                    {q.rule !== 'V11' && q.rule !== 'V10' && <button className="btn sm" onClick={() => e.resolve(q.id, 'confirm')}>Confirm as real</button>}
                    <button className="btn sm ghost" onClick={() => e.resolve(q.id, 'reject')}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="xs muted">Need data on the screen fast? Open the demo controls and pick a scenario, or press Space to pause.</p>
    </div>
  );
}
