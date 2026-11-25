import { useMemo, useState, useSyncExternalStore } from 'react';
import { useSim } from '../sim/SimProvider';
import { useStore } from '../state/store';
import { cluster, DSM_RATE, DSM_TOL, FLOW_COLOR, FLOW_LABEL, HEDGE_RATE, HEDGE_SHARE, MEMBERS, OA_THRESHOLD_KW, POOL_NODE, solarKw, TRADER_MARGIN, type Exchange, type FlowKind, type Member } from '../sim/cluster';
import { OA_ADDER } from '../sim/grid';
import { clockLabel } from './Live';
import { fmt, lakh } from '../domain/util';
import { Icon } from '../ui/Icon';
import { Chip, Kpi, PageHead, Seg } from '../ui/kit';

type Tab = 'map' | 'pool' | 'exchange' | 'score';
const byId = (id: string) => MEMBERS.find((m) => m.id === id);
const nm = (id: string) => (id === 'pool' ? 'Energy pool' : byId(id)?.name ?? id);
const hh = (b: number) => `${String(Math.floor(b / 4)).padStart(2, '0')}:${String((b % 4) * 15).padStart(2, '0')}`;
const NW = 160, NH = 64;

export function useCluster() {
  useSyncExternalStore(cluster.subscribe, cluster.getVersion);
  const { engine, control } = useSim();
  const clock = control.clock;
  const cloud = control.ems.cloud;
  const spike = !!engine && engine.ems.spikeUntil > clock;
  return { clock, cloud, spike, engine };
}

/** One member's view of today's pool: what it would pay alone vs through the pool. */
export function memberToday(id: string, clock: number) {
  const m = byId(id)!;
  const day0 = Math.floor(clock / 86_400_000) * 86_400_000;
  const now = Math.floor((clock - day0) / 900_000);
  const { rows } = cluster.day(clock);
  let kwh = 0, solo = 0;
  for (let b = 0; b <= now; b++) { const a = cluster.load(m, day0 + b * 900_000 + 420_000, true) * 0.25; kwh += a; solo += a * (b / 4 >= 9 && b / 4 < 17 ? 5.6 : b / 4 >= 18 && b / 4 < 22 ? 8.4 : 7); }
  const poolKwh = rows.reduce((a, r) => a + r.actual * 0.25, 0), poolCost = rows.reduce((a, r) => a + r.pooledCost, 0);
  const rate = poolKwh ? poolCost / poolKwh : 0;
  return { kwh, solo, pooled: kwh * rate, rate, soloRate: kwh ? solo / kwh : 0, share: poolKwh ? kwh / poolKwh : 0 };
}

export default function Cluster() {
  const { s } = useStore();
  const { clock, cloud, spike } = useCluster();
  const coordinator = s.role === 'cluster' || s.role === 'admin';
  const [tab, setTab] = useState<Tab>('map');
  const members = cluster.members();
  const { rows } = useMemo(() => cluster.day(clock, cloud, spike), [Math.floor(clock / 60_000), cloud, spike, cluster.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = rows[rows.length - 1];
  const a = cluster.acc;
  const me = coordinator ? null : memberToday('vbw', clock);
  const t = clockLabel(clock);

  return (
    <div className="stack">
      <PageHead title={coordinator ? 'Adityapur Green Cluster' : 'My cluster'} sub={<>{members.filter((m) => m.kw > 0).length} member plants + shared solar park · one licensed trader · one metered ledger · {t.time}, {t.date}</>} />
      {!coordinator && <div className="banner info"><Icon name="users" />You are one of {members.filter((m) => m.kw > 0).length} members. You see your own numbers and cluster totals. Other members' meter data is shared only as pool aggregates.</div>}
      <div className="grid g4">
        <Kpi label="Pooled demand now" value={fmt((cur?.actual ?? 0) / 1000, 2)} unit="MW" sub={`open access needs ≥ ${OA_THRESHOLD_KW / 1000} MW · ${members.filter((m) => m.kw >= OA_THRESHOLD_KW).length} member(s) qualify alone`} tone="ok" />
        <Kpi label="Saved this year" value={lakh(a.inr + a.poolInr)} sub={`exchanges ${lakh(a.inr)} · power pool ${lakh(a.poolInr)}`} />
        <Kpi label="CO₂ avoided this year" value={fmt(a.t, 0)} unit="t" sub={`${fmt(a.tMat, 0)} t materials · ${fmt(a.m3, 0)} m³ water`} />
        {me ? <Kpi label="Your power cost today" value={`₹${fmt(me.rate, 2)}`} unit="/kWh" sub={`alone on DISCOM tariff ₹${fmt(me.soloRate, 2)} · saved ₹${fmt(me.solo - me.pooled, 0)} today`} tone={me.solo > me.pooled ? 'ok' : undefined} />
          : <Kpi label="Live exchanges" value={cluster.exchanges().length} sub={`${cluster.proposals().length} proposed match(es) waiting`} tone={cluster.proposals().length ? 'warn' : undefined} />}
      </div>
      <Seg label="Section" value={tab} onChange={setTab} options={[{ v: 'map', l: 'Map & flows' }, { v: 'pool', l: 'Energy pool' }, { v: 'exchange', l: 'Exchange' }, { v: 'score', l: 'Scoreboard & split' }]} />
      {tab === 'map' && <MapTab clock={clock} cloudy={cloud} />}
      {tab === 'pool' && <PoolTab rows={rows} clock={clock} spike={spike} />}
      {tab === 'exchange' && <ExchangeTab clock={clock} canAccept={coordinator || s.role === 'owner'} />}
      {tab === 'score' && <ScoreTab coordinator={coordinator} />}
    </div>
  );
}

function curve(ax: number, ay: number, bx: number, by: number, bend = 0.18) {
  const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay;
  return `M${ax},${ay} Q${mx - dy * bend},${my + dx * bend} ${bx},${by}`;
}

function MapTab({ clock, cloudy }: { clock: number; cloudy: boolean }) {
  const [sel, setSel] = useState<string>('vbw');
  const members = cluster.members();
  const xs = cluster.exchanges();
  const links: { key: string; d: string; kind: FlowKind; paused: boolean; len: number }[] = [];
  for (const x of xs) {
    if (x.kind === 'power') continue;
    const hops = x.chain ? [x.from, ...x.to].map((id, i, arr) => (i ? [arr[i - 1], id] : null)).filter(Boolean) as string[][] : x.to.map((to) => [x.from, to]);
    hops.forEach(([f, to], i) => {
      const A = byId(f)!, B = byId(to)!;
      links.push({ key: `${x.id}-${i}`, d: curve(A.x, A.y, B.x, B.y, x.id === 'x-pallet' ? 0.12 : 0.18), kind: x.kind, paused: cluster.isPaused(x, clock), len: Math.hypot(B.x - A.x, B.y - A.y) });
    });
  }
  const sol = byId('sol')!;
  links.push({ key: 'solar', d: `M${sol.x},${sol.y} L${POOL_NODE.x},${POOL_NODE.y}`, kind: 'power', paused: false, len: 190 });
  links.push({ key: 'grid', d: `M${POOL_NODE.x},${POOL_NODE.y} L${POOL_NODE.x},${470}`, kind: 'power', paused: false, len: 190 });
  const selM = byId(sel);
  const selX = xs.filter((x) => x.from === sel || x.to.includes(sel));
  const kwNow = (m: Member) => cluster.load(m, clock, true);
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Who sends what to whom</h3>
          <div className="row xs">{(Object.keys(FLOW_COLOR) as FlowKind[]).map((k) => <span key={k}><span className="dot" style={{ background: FLOW_COLOR[k] }} />{FLOW_LABEL[k]}</span>)}</div></div>
        <div style={{ overflowX: 'auto' }}><svg viewBox="22 50 896 460" width="100%" style={{ display: 'block', minWidth: 720 }} role="img" aria-label="Cluster map with live flows of power, heat, materials, water and waste between member plants">
          {links.map((l) => <path key={l.key} id={`cl-${l.key}`} d={l.d} fill="none" stroke={l.paused ? 'var(--border-strong, #bbb)' : FLOW_COLOR[l.kind]} strokeWidth={l.kind === 'power' ? 4 : 2.4} strokeDasharray={l.paused ? '5 5' : undefined} opacity={l.paused ? 0.7 : 0.55} />)}
          {links.filter((l) => !l.paused).map((l) => [0, 1, 2].map((i) => {
            const dur = Math.max(2.4, l.len / 70);
            return <circle key={`${l.key}-${i}`} r={l.kind === 'power' ? 4.5 : 4} fill={FLOW_COLOR[l.kind]}><animateMotion dur={`${dur}s`} begin={`${(-dur * i) / 3}s`} repeatCount="indefinite"><mpath href={`#cl-${l.key}`} /></animateMotion></circle>;
          }))}
          {members.map((m) => {
            const you = m.you, on = sel === m.id;
            return (
              <g key={m.id} transform={`translate(${m.x - NW / 2},${m.y - NH / 2})`} style={{ cursor: 'pointer' }} onClick={() => setSel(m.id)} role="button" aria-label={m.name}>
                <rect width={NW} height={NH} rx={10} fill="var(--surface)" stroke={on ? 'var(--text)' : you ? 'var(--primary)' : 'var(--border)'} strokeWidth={on || you ? 2 : 1} />
                <text x={10} y={21} fontSize="13" fontWeight="600" fill="var(--text)">{m.name.length > 22 ? `${m.name.slice(0, 21)}…` : m.name}</text>
                <text x={10} y={38} fontSize="10.5" fill="var(--text-muted)">{m.type.length > 26 ? `${m.type.slice(0, 25)}…` : m.type}</text>
                <text x={10} y={55} fontSize="11" fill={m.id === 'sol' ? FLOW_COLOR.power : 'var(--text)'} className="num">{m.id === 'sol' ? `${fmt(solarKw((clock % 86_400_000) / 3_600_000, cloudy), 0)} kW generating` : `${fmt(kwNow(m), 0)} kW now`}</text>
                {you && <text x={NW - 10} y={55} fontSize="11" textAnchor="end" fill="var(--primary)" fontWeight="600">you</text>}
                {m.late && <text x={NW - 10} y={55} fontSize="11" textAnchor="end" fill={FLOW_COLOR.power} fontWeight="600">new</text>}
              </g>
            );
          })}
          <g transform={`translate(${POOL_NODE.x - NW / 2},${POOL_NODE.y - NH / 2})`}>
            <rect width={NW} height={NH} rx={10} fill="var(--primary)" />
            <text x={10} y={21} fontSize="13" fontWeight="600" fill="#fff">Energy pool</text>
            <text x={10} y={38} fontSize="10.5" fill="#fff" opacity=".85">Via licensed trader</text>
            <text x={10} y={55} fontSize="11" fill="#fff" className="num">{fmt(members.reduce((s2, m) => s2 + (m.kw ? kwNow(m) : 0), 0) / 1000, 2)} MW to {members.filter((m) => m.kw > 0).length} plants</text>
          </g>
          <g transform={`translate(${POOL_NODE.x - NW / 2},${470 - NH / 2})`}>
            <rect width={NW} height={NH} rx={10} fill="var(--surface-muted)" stroke="var(--border)" strokeDasharray="4 3" />
            <text x={10} y={24} fontSize="13" fontWeight="600" fill="var(--text)">IEX + DISCOM grid</text>
            <text x={10} y={42} fontSize="10.5" fill="var(--text-muted)">Day-ahead, real-time, green</text>
          </g>
        </svg></div>
        <p className="xs muted">Thin lines are physical exchanges, metered at both ends. The thick yellow lines are power: shared solar and pooled grid purchase reach every member through the pool. Click a plant for its details.</p>
      </div>
      <div className="grid g2">
        {selM && (
          <div className="card stack-sm">
            <div className="row-between"><h3>{selM.name}</h3>{selM.you && <Chip tone="ok">you</Chip>}</div>
            <p className="small muted">{selM.type}{selM.kw ? ` · ${selM.kw} kW contract · ${selM.kw >= OA_THRESHOLD_KW ? 'could buy on the exchange alone' : 'too small for open access alone'}` : ''}</p>
            {selX.length === 0 ? <p className="small muted">No exchanges yet.</p> : selX.map((x) => (
              <div key={x.id} className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <span className="dot" style={{ background: FLOW_COLOR[x.kind], marginTop: 6 }} />
                <div className="small"><strong>{x.from === sel ? 'Sends' : 'Receives'}</strong> {x.what.toLowerCase()} · {fmt(x.qty, 0)} {x.unit}/month<br /><span className="xs muted">{x.from === sel ? `to ${x.to.map(nm).join(', ')}` : `from ${nm(x.from)}`} · {lakh(x.inrPerMonth)}/month · {fmt(x.tco2PerMonth, 1)} t CO₂{cluster.isPaused(x, clock) ? ' · paused' : ''}</span></div>
              </div>
            ))}
          </div>
        )}
        <div className="card stack-sm">
          <h3>Cluster feed</h3>
          {cluster.feed.length === 0 ? <p className="small muted">Events from the cluster appear here. Try the Cluster section in the demo controls.</p> : cluster.feed.slice(0, 8).map((f) => (
            <div key={f.t + f.text} className="small" style={{ borderLeft: `3px solid var(--${f.tone === 'bad' ? 'danger' : f.tone === 'warn' ? 'warning' : f.tone === 'ok' ? 'success' : 'info'})`, paddingLeft: 8 }}>
              <span className="xs muted">{clockLabel(f.t).time}</span> {f.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PoolChart({ rows }: { rows: ReturnType<typeof cluster.day>['rows'] }) {
  const W = 760, H = 290, pl = 44, pr = 12, pt = 10, split = 170, pb = 22;
  const x = (b: number) => pl + ((W - pl - pr) * b) / 95;
  const maxMw = Math.max(8, ...rows.map((r) => r.actual / 1000)) * 1.1;
  const y = (mw: number) => pt + (split - pt) * (1 - mw / maxMw);
  const maxDev = Math.max(400, ...rows.map((r) => r.indivDev));
  const yd = (kw: number) => H - pb - (H - pb - split - 30) * (kw / maxDev);
  const bw = (W - pl - pr) / 96 / 2.4;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Pool schedule versus actual today, and deviation of members alone versus the pool" style={{ display: 'block' }}>
      {[0, Math.round(maxMw / 2), Math.round(maxMw)].map((v) => <g key={v}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v ? '3 4' : ''} /><text x={pl - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">{v} MW</text></g>)}
      <polyline points={rows.map((r) => `${x(r.block)},${y(r.sched / 1000)}`).join(' ')} fill="none" stroke="var(--text-muted)" strokeWidth="1.6" strokeDasharray="5 4" />
      <polyline points={rows.map((r) => `${x(r.block)},${y(r.actual / 1000)}`).join(' ')} fill="none" stroke="var(--primary)" strokeWidth="2.4" />
      <polyline points={rows.map((r) => `${x(r.block)},${y(r.solar / 1000)}`).join(' ')} fill="none" stroke={FLOW_COLOR.power} strokeWidth="1.6" />
      <text x={pl} y={split + 24} fontSize="10" fill="var(--text-muted)">Deviation from schedule, kW</text>
      <line x1={pl} x2={W - pr} y1={H - pb} y2={H - pb} stroke="var(--border)" />
      {rows.map((r) => <g key={r.block}><rect x={x(r.block) - bw} y={yd(r.indivDev)} width={bw} height={H - pb - yd(r.indivDev)} fill="var(--danger)" opacity=".55" /><rect x={x(r.block)} y={yd(r.pooledDev)} width={bw} height={H - pb - yd(r.pooledDev)} fill="var(--primary)" /></g>)}
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h * 4)} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--text-muted)">{String(h).padStart(2, '0')}:00</text>)}
    </svg>
  );
}

function PoolTab({ rows, clock, spike }: { rows: ReturnType<typeof cluster.day>['rows']; clock: number; spike: boolean }) {
  const members = cluster.members().filter((m) => m.kw > 0);
  const sum = (f: (r: typeof rows[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const indivPen = sum((r) => r.indivPen), pooledPen = sum((r) => r.pooledPen);
  const kwh = sum((r) => r.actual * 0.25), solo = sum((r) => r.soloCost), pooled = sum((r) => r.pooledCost);
  const indivDev = sum((r) => r.indivDev * 0.25), pooledDev = sum((r) => r.pooledDev * 0.25);
  const { market } = cluster.day(clock);
  const now = rows.length - 1;
  const next = market.slice(now + 1, now + 9);
  const sched = (b: number) => members.reduce((a, m) => a + cluster.load(m, Math.floor(clock / 86_400_000) * 86_400_000 + b * 900_000 + 420_000, false), 0);
  const cur = rows[now];
  const spotNow = 10 + OA_ADDER.grey + TRADER_MARGIN;
  const hedgedNow = HEDGE_RATE + OA_ADDER.grey + TRADER_MARGIN;
  return (
    <div className="stack">
      {spike && <div className="banner warn"><Icon name="bolt" />Exchange price spike: real-time at ₹10/kWh. {Math.round(HEDGE_SHARE * 100)}% of the pool's scheduled load is on a term contract at ₹{HEDGE_RATE.toFixed(2)}, so the blended pool rate this block is ₹{fmt(cur ? cur.pooledCost / Math.max(1, cur.actual * 0.25) : 0, 2)} against ₹{spotNow.toFixed(2)} for anyone fully on spot.</div>}
      <div className="grid g4">
        <Kpi label="Members who can use open access" value={`${members.length} of ${members.length}`} sub={`alone: ${members.filter((m) => m.kw >= OA_THRESHOLD_KW).length} of ${members.length}`} tone="ok" />
        <Kpi label="Power cost today" value={`₹${fmt(kwh ? pooled / kwh : 0, 2)}`} unit="/kWh" sub={`on DISCOM tariff alone ₹${fmt(kwh ? solo / kwh : 0, 2)} · saved ${lakh(solo - pooled)}`} tone="ok" />
        <Kpi label="Deviation today" value={fmt(pooledDev / 1000, 1)} unit="MWh" sub={`if each member scheduled alone: ${fmt(indivDev / 1000, 1)} MWh`} />
        <Kpi label="Deviation charges today" value={`₹${fmt(pooledPen, 0)}`} sub={`alone: ₹${fmt(indivPen, 0)} · ${indivPen ? Math.round((1 - pooledPen / indivPen) * 100) : 0}% avoided by netting`} tone={pooledPen < indivPen ? 'ok' : undefined} />
      </div>
      <div className="card">
        <div className="card-head"><h3>Today: schedule vs actual, and why pooling cuts deviation</h3>
          <div className="row xs"><span><span className="dot" style={{ background: 'var(--text-muted)' }} />Day-ahead schedule</span><span><span className="dot" style={{ background: 'var(--primary)' }} />Actual pooled draw</span><span><span className="dot" style={{ background: FLOW_COLOR.power }} />Shared solar</span><span><span className="dot" style={{ background: 'var(--danger)' }} />Deviation, each member alone</span><span><span className="dot" style={{ background: 'var(--primary)' }} />Deviation, pooled</span></div></div>
        <PoolChart rows={rows} />
        <p className="xs muted">One plant running over is offset by another running under, so the pool's error is far smaller than the sum of individual errors. Charges apply beyond ±{DSM_TOL * 100}% of schedule at ₹{DSM_RATE}/kWh (illustrative; actual deviation rules are set by the state commission).</p>
      </div>
      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h3>Bid book: next 2 hours</h3><Chip tone="info">submitted by licensed trader</Chip></div>
          <div className="table-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Block</th><th className="r">Pool schedule</th><th className="r">Hedged / spot</th><th className="r">DAM price</th><th className="r">Limit</th></tr></thead>
            <tbody>{next.map((b) => { const sc = sched(b.block) * 0.25; const hedged = sc * HEDGE_SHARE; return <tr key={b.block}><td className="mono">{hh(b.block)}</td><td className="r">{fmt(sc / 1000, 2)} MWh</td><td className="r">{fmt(hedged / 1000, 2)} / {fmt((sc - hedged) / 1000, 2)}</td><td className="r">₹{b.dam.toFixed(2)}</td><td className="r">₹{Math.min(b.dam + 0.4, b.discom - OA_ADDER.grey - TRADER_MARGIN).toFixed(2)}</td></tr>; })}</tbody></table></div>
          <p className="xs muted">Limit price = whichever is lower: day-ahead + ₹0.40, or the DISCOM tariff minus open-access charges and trader fee. Above the limit the pool simply draws from the DISCOM.</p>
        </div>
        <div className="card">
          <div className="card-head"><h3>Members in the pool now</h3></div>
          <div className="table-wrap" style={{ border: 0, maxHeight: 360 }}><table className="t"><thead><tr><th>Plant</th><th className="r">Schedule</th><th className="r">Actual</th><th className="r">Deviation</th><th>Alone?</th></tr></thead>
            <tbody>{members.map((m) => { const s = cluster.load(m, clock, false), a = cluster.load(m, clock, true), d = a - s; return <tr key={m.id}><td>{m.name}{m.you ? <span className="xs" style={{ color: 'var(--primary)', fontWeight: 600 }}> · you</span> : ''}</td><td className="r">{fmt(s, 0)}</td><td className="r">{fmt(a, 0)}</td><td className="r" style={{ color: Math.abs(d) > DSM_TOL * s ? 'var(--danger)' : undefined }}>{d > 0 ? '+' : ''}{fmt(d, 0)}</td><td>{m.kw >= OA_THRESHOLD_KW ? <Chip tone="ok">eligible</Chip> : <Chip tone="neutral">via pool</Chip>}</td></tr>; })}</tbody></table></div>
        </div>
      </div>
      <div className="banner info"><Icon name="info" />Pooling gives members access to the exchange, better contract terms and a hedge against spikes. Each member's bid is set by the pool's own load. The pool never bids to move market prices; that would breach competition and power-market rules. Hedged rate today: ₹{hedgedNow.toFixed(2)}/kWh landed.</div>
    </div>
  );
}

function ExchangeTab({ clock, canAccept }: { clock: number; canAccept: boolean }) {
  const props = cluster.proposals();
  const xs = cluster.exchanges();
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Suggested matches</h3><span className="small muted">From each plant's waste-issued and material-received registers</span></div>
        {props.length === 0 ? <p className="small muted">No open matches. New needs and offers appear as plants post them.</p> : props.map((p) => (
          <div key={p.id} className="row-between" style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
            <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><span className="dot" style={{ background: FLOW_COLOR[p.kind], marginTop: 6 }} />
              <div><strong className="small">{p.what}</strong><br /><span className="xs muted">{nm(p.from)} → {p.to.map(nm).join(', ')} · {fmt(p.qty, 0)} {p.unit}/month · saves {lakh(p.inrPerMonth)}/month · {fmt(p.tco2PerMonth, 1)} t CO₂/month</span></div></div>
            <button className="btn sm primary" disabled={!canAccept} onClick={() => cluster.accept(p.id, clock)}>Agree exchange</button>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head"><h3>Running exchanges</h3><span className="small muted">{xs.length} streams</span></div>
        <div className="table-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Flow</th><th>From → to</th><th className="r">Per month</th><th className="r">₹ saved</th><th className="r">t CO₂</th><th>Status</th></tr></thead>
          <tbody>{xs.map((x) => <tr key={x.id}><td style={{ whiteSpace: 'normal', minWidth: 200 }}><span className="dot" style={{ background: FLOW_COLOR[x.kind] }} />{x.what}</td><td className="small" style={{ whiteSpace: 'normal', minWidth: 200 }}>{nm(x.from)} → {x.to.length > 3 ? `${x.to.length} members` : x.to.map(nm).join(x.chain ? ' → ' : ', ')}</td><td className="r">{fmt(x.qty, 0)} {x.unit}</td><td className="r">{lakh(x.inrPerMonth)}</td><td className="r">{fmt(x.tco2PerMonth, 1)}</td><td>{cluster.isPaused(x, clock) ? <Chip tone="block">paused</Chip> : <Chip tone="ok">running</Chip>}</td></tr>)}</tbody></table></div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Paired ledger lines</h3><span className="small muted">Weighed out at the sender, weighed in at the receiver. Over 2% apart → held.</span></div>
        <div className="table-wrap" style={{ border: 0, maxHeight: 340 }}><table className="t"><thead><tr><th>Time</th><th>Stream</th><th>Sender</th><th className="r">Sent</th><th>Receiver</th><th className="r">Received</th><th>Status</th></tr></thead>
          <tbody>{cluster.ledger.length === 0 ? <tr><td colSpan={7} className="muted">Lines appear as material moves. Speed up the clock in the demo controls.</td></tr> : cluster.ledger.slice(0, 20).map((r) => <tr key={r.id}><td className="small">{clockLabel(r.t).time}</td><td className="small" style={{ whiteSpace: 'normal', minWidth: 200 }}>{r.what}</td><td className="small">{nm(r.from)}</td><td className="r">{r.sent} {r.unit}</td><td className="small">{nm(r.to)}</td><td className="r">{r.received} {r.unit}</td><td>{r.status === 'mismatch' ? <span className="row" style={{ gap: 6 }}><Chip tone="block">held</Chip><button className="btn sm" onClick={() => cluster.resolve(r.id)}>Both confirm</button></span> : r.status === 'resolved' ? <Chip tone="info">corrected</Chip> : <Chip tone="ok">matched</Chip>}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

const CLAIM_LABEL: Record<Exchange['claim'], string> = { receiver: 'Receiver', sender: 'Sender', split: 'Split by volume', consumption: 'By kWh consumed' };

function ScoreTab({ coordinator }: { coordinator: boolean }) {
  const a = cluster.acc;
  const xs = cluster.exchanges();
  const [open, setOpen] = useState<string | null>(null);
  const big = (v: string, unit: string, label: string, c: string) => (
    <div className="card" style={{ borderTop: `4px solid ${c}` }}><div className="xs muted">{label}</div><div style={{ fontFamily: 'var(--font-head)', fontSize: 30, fontWeight: 700 }} className="num">{v}</div><div className="small muted">{unit}</div></div>
  );
  const runRate = xs.reduce((s, x) => s + x.tco2PerMonth, 0) * 12;
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        {big(lakh(a.inr + a.poolInr), 'saved, this financial year', 'Money', 'var(--primary)')}
        {big(fmt(a.t, 0), 't CO₂ avoided', 'Carbon', FLOW_COLOR.waste)}
        {big(fmt(a.m3, 0), 'm³ water reused', 'Water', FLOW_COLOR.water)}
        {big(fmt(a.mwh, 0), 'MWh shared (solar + heat)', 'Energy', FLOW_COLOR.power)}
        {big(fmt(a.tMat, 0), 't materials kept in use', 'Materials', FLOW_COLOR.material)}
      </div>
      <p className="small muted">Run-rate: about {fmt(runRate, 0)} t CO₂ and {lakh(xs.reduce((s, x) => s + x.inrPerMonth, 0) * 12 + 4_850_00 * 12)} a year at today's exchanges. Every figure adds up from paired ledger lines, so a verifier can trace it back to weighbridge slips and meters.</p>
      <div className="card">
        <div className="card-head"><h3>Who gets the saving, who claims the carbon</h3><Chip tone="ok"><Icon name="check" size={14} />each tonne claimed once</Chip></div>
        <div className="table-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Exchange</th><th className="r">₹/month</th><th className="r">Sender share</th><th className="r">Receiver share</th><th className="r">t CO₂/yr</th><th>Carbon claimed by</th><th /></tr></thead>
          <tbody>{xs.map((x) => <tr key={x.id}>
            <td style={{ whiteSpace: 'normal', minWidth: 200 }}><span className="dot" style={{ background: FLOW_COLOR[x.kind] }} />{x.what}<br /><span className="xs muted">{nm(x.from)} → {x.to.length > 3 ? `${x.to.length} members` : x.to.map(nm).join(x.chain ? ' → ' : ', ')}</span></td>
            <td className="r">{lakh(x.inrPerMonth)}</td>
            <td className="r">{x.kind === 'power' ? '—' : lakh(x.inrPerMonth * x.senderShare)}</td>
            <td className="r">{x.kind === 'power' ? 'by kWh' : lakh(x.inrPerMonth * (1 - x.senderShare))}</td>
            <td className="r">{fmt(x.tco2PerMonth * 12, 0)}</td>
            <td>{coordinator && x.kind !== 'power' ? <select className="input" style={{ minHeight: 32, width: 140 }} value={x.claim} onChange={(e) => cluster.setClaim(x.id, e.target.value as Exchange['claim'])} aria-label={`Who claims the carbon for ${x.what}`}>{(['receiver', 'sender', 'split'] as const).map((c) => <option key={c} value={c}>{CLAIM_LABEL[c]}</option>)}</select> : CLAIM_LABEL[x.claim]}</td>
            <td>{coordinator && x.kind !== 'power' && <button className="btn sm ghost" onClick={() => setOpen(open === x.id ? null : x.id)}>Split</button>}</td>
          </tr>)}</tbody></table></div>
        {open && (() => { const x = xs.find((y) => y.id === open)!; return (
          <div className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <label className="field"><span className="label-text">{x.what}: {Math.round(x.senderShare * 100)}% of the saving to {nm(x.from)}, {Math.round((1 - x.senderShare) * 100)}% to {x.to.map(nm).join(', ')}</span>
              <input type="range" min={0} max={100} step={5} value={x.senderShare * 100} onChange={(e) => cluster.setSplit(x.id, Number(e.target.value) / 100)} /></label>
            <p className="xs muted">{x.claimNote}. The rule is written into the exchange agreement and every change is logged.</p>
          </div>
        ); })()}
        <p className="xs muted">Double-counting guard: a tonne from an exchange appears in exactly one member's report. If it goes into a carbon-credit project, it is taken out of both members' OEM reports, the same rule the plant uses for its own solar.</p>
      </div>
    </div>
  );
}
