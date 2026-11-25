import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useSim } from '../live/LiveProvider';
import { memberToday, useCluster } from './Cluster';
const SITE = { name: 'Jamshedpur', zone: 'IN-EA' };
interface SolarForecast { source: 'live' | 'simulated'; hours: { time: string; ghi: number; cloud: number }[]; note: string }
interface GridCarbon { source: 'live' | 'simulated' | 'needs_key'; gPerKwh: number; zone: string; note: string }
/** Expected PV output (kWh) from hourly GHI for a plant of `kwp` with a 0.8 performance ratio. */
const pvKwh = (hours: SolarForecast['hours'], kwp: number) => hours.reduce((s, h) => s + (h.ghi / 1000) * kwp * 0.8, 0);
import { BLOCKS, CEA_EF, landed, SOURCE_COLOR, SOURCE_LABEL, SOURCES, type Source } from '../live/grid';
import { clockLabel } from './Live';
import { fmt } from '../domain/util';
import { Icon } from '../ui/Icon';
import { Chip, Kpi, PageHead } from '../ui/kit';

const hh = (b: number) => `${String(Math.floor(b / 4)).padStart(2, '0')}:${String((b % 4) * 15).padStart(2, '0')}`;

function MarketChart({ now }: { now: number }) {
  const { engine: e } = useSim();
  if (!e) return null;
  const day = e.ems.market;
  const W = 760, H = 250, pl = 40, pr = 44, pt = 12, pb = 24;
  const x = (b: number) => pl + ((W - pl - pr) * b) / (BLOCKS - 1);
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / 12);
  const yEf = (v: number) => pt + (H - pt - pb) * (1 - (v - 0.4) / 0.7);
  const line = (vals: number[], from = 0) => vals.map((v, i) => `${x(i + from)},${y(v)}`).join(' ');
  const past = day.slice(0, now + 1).map((b, i) => (i === now ? e.ems.current(now).rtm : b.rtm));
  const future = day.slice(now).map((b) => b.dam);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Exchange prices today, actual and forecast" style={{ display: 'block' }}>
      {day.map((b) => b.stress >= 70 && <rect key={b.block} x={x(b.block) - 3.6} y={pt} width={7.4} height={H - pt - pb} fill="var(--danger)" opacity={0.07} />)}
      {[0, 2, 4, 6, 8, 10, 12].map((v) => <g key={v}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v ? '3 4' : ''} /><text x={pl - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">₹{v}</text></g>)}
      {[0.5, 0.7, 0.9].map((v) => <text key={v} x={W - pr + 6} y={yEf(v) + 4} fontSize="10" fill="var(--text-muted)">{v}</text>)}
      <text x={W - 4} y={pt + 4} fontSize="9" textAnchor="end" fill="var(--text-muted)">kg/kWh</text>
      <polyline points={day.map((b) => `${x(b.block)},${yEf(b.marginalEf)}`).join(' ')} fill="none" stroke="#7C8C84" strokeWidth="1.2" strokeDasharray="2 3" />
      <polyline points={line(day.map((b) => landed(b).discom))} fill="none" stroke={SOURCE_COLOR.discom} strokeWidth="2" />
      <polyline points={line(day.map((b) => landed(b).green))} fill="none" stroke={SOURCE_COLOR.green} strokeWidth="1.6" opacity="0.9" />
      <polyline points={line(past)} fill="none" stroke={SOURCE_COLOR.rtm} strokeWidth="2.6" />
      <polyline points={line(future, now)} fill="none" stroke={SOURCE_COLOR.rtm} strokeWidth="2" strokeDasharray="5 4" opacity="0.7" />
      <line x1={x(now)} x2={x(now)} y1={pt} y2={H - pb} stroke="var(--text)" strokeWidth="1" />
      <circle cx={x(now)} cy={y(past[past.length - 1])} r="5" fill={SOURCE_COLOR.rtm} className="live-dot" />
      <text x={x(now) + 6} y={pt + 10} fontSize="10" fill="var(--text)">now</text>
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h * 4)} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--text-muted)">{String(h).padStart(2, '0')}:00</text>)}
    </svg>
  );
}

function DuckChart({ now }: { now: number }) {
  const { engine: e } = useSim();
  if (!e) return null;
  const day = e.ems.market;
  const log = e.ems.blockLog;
  const W = 760, H = 230, pl = 40, pr = 44, pt = 12, pb = 24;
  const x = (b: number) => pl + ((W - pl - pr) * b) / (BLOCKS - 1);
  const maxGW = 50, minGW = 0;
  const yG = (v: number) => pt + (H - pt - pb) * (1 - (v - minGW) / (maxGW - minGW));
  const yP = (v: number) => pt + (H - pt - pb) * (1 - (v + 200) / 700);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Regional duck curve and the plant's net draw from the grid" style={{ display: 'block' }}>
      <line x1={pl} x2={W - pr} y1={yP(0)} y2={yP(0)} stroke="var(--border)" />
      {[0, 25, 50].map((v) => <text key={v} x={pl - 6} y={yG(v) + 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">{v} GW</text>)}
      {[-200, 0, 200, 400].map((v) => <text key={v} x={W - pr + 6} y={yP(v) + 4} fontSize="10" fill="var(--text-muted)">{v}</text>)}
      <text x={W - 4} y={pt + 4} fontSize="9" textAnchor="end" fill="var(--text-muted)">plant kW</text>
      <path d={`M${x(0)},${yG(0)} ${day.map((b) => `L${x(b.block)},${yG(b.solarGW)}`).join(' ')} L${x(95)},${yG(0)} Z`} fill={SOURCE_COLOR.solar} opacity="0.18" />
      <polyline points={day.map((b) => `${x(b.block)},${yG(b.gridDemandGW)}`).join(' ')} fill="none" stroke="var(--text-muted)" strokeWidth="1.2" strokeDasharray="4 3" />
      <polyline points={day.map((b) => `${x(b.block)},${yG(b.netDemandGW)}`).join(' ')} fill="none" stroke="var(--text)" strokeWidth="2.4" />
      {log.map((l) => { const kw = l.naiveImport * 4; return <rect key={`n${l.t}`} x={x(l.block) - 3} y={yP(Math.max(0, kw))} width={6} height={Math.abs(yP(0) - yP(kw))} fill="var(--danger)" opacity="0.18" />; })}
      {log.map((l) => { const kw = l.plantNet * 4; return <rect key={l.t} x={x(l.block) - 2.5} y={kw >= 0 ? yP(kw) : yP(0)} width={5} height={Math.abs(yP(0) - yP(kw))} fill={kw >= 0 ? SOURCE_COLOR.rtm : SOURCE_COLOR.green} />; })}
      <line x1={x(now)} x2={x(now)} y1={pt} y2={H - pb} stroke="var(--text)" strokeWidth="1" />
      <text x={x(76)} y={yG(day[76].netDemandGW) - 8} fontSize="10" textAnchor="middle" fill="var(--danger)">evening ramp: coal plants ramp up</text>
      <text x={x(52)} y={yG(day[52].netDemandGW) + 16} fontSize="10" textAnchor="middle" fill="var(--text-muted)">solar belly</text>
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h * 4)} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--text-muted)">{String(h).padStart(2, '0')}:00</text>)}
    </svg>
  );
}

function DispatchChart() {
  const { engine: e } = useSim();
  if (!e) return null;
  const log = e.ems.blockLog;
  const W = 760, H = 220, pl = 40, pr = 10, pt = 10, pb = 24;
  const x = (i: number) => pl + ((W - pl - pr) * (i + BLOCKS - log.length)) / BLOCKS;
  const bw = (W - pl - pr) / BLOCKS - 1;
  const max = 600, min = -250;
  const y = (v: number) => pt + (H - pt - pb) * (1 - (v - min) / (max - min));
  const order: Source[] = ['solar', 'bess', 'genset', 'green', 'dam', 'rtm', 'discom'];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="How each 15-minute block was supplied today" style={{ display: 'block' }}>
      {[-200, 0, 200, 400, 600].map((v) => <g key={v}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v ? '3 4' : ''} /><text x={pl - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">{v}</text></g>)}
      {log.map((l, i) => {
        let acc = 0;
        return (
          <g key={l.t}>
            {order.map((s) => { const kw = l.supply[s] * 4; const y0 = y(acc); acc += kw; return kw > 0.5 ? <rect key={s} x={x(i)} y={y(acc)} width={bw} height={Math.max(0, y0 - y(acc))} fill={SOURCE_COLOR[s]}><title>{`${hh(l.block)} ${SOURCE_LABEL[s]}: ${fmt(kw, 0)} kW`}</title></rect> : null; })}
            {l.export > 0.1 && <rect x={x(i)} y={y(0)} width={bw} height={y(-l.export * 4) - y(0)} fill={SOURCE_COLOR.green} opacity="0.55"><title>{`${hh(l.block)} export ${fmt(l.export * 4, 0)} kW`}</title></rect>}
          </g>
        );
      })}
      <text x={pl + 4} y={y(-120)} fontSize="10" fill="var(--text-muted)">↓ exported to grid</text>
      {log.map((l, i) => l.block % 16 === 0 && <text key={l.t} x={x(i) + bw / 2} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--text-muted)">{hh(l.block)}</text>)}
    </svg>
  );
}

function ExternalPanels({ kwp, cea }: { kwp: number; cea: number }) {
  const sf = useQuery({ queryKey: ['energy', 'forecast'], queryFn: () => api<SolarForecast>('/energy/forecast'), staleTime: 600_000 }).data ?? null;
  const gc = useQuery({ queryKey: ['energy', 'carbon'], queryFn: () => api<GridCarbon>('/energy/grid-intensity'), staleTime: 600_000 }).data ?? null;
  const hours = sf?.hours.slice(0, 48) ?? [];
  const max = Math.max(900, ...hours.map((h) => h.ghi));
  const tomorrow = hours.slice(24, 48);
  return (
    <div className="grid g3">
      <div className="card span2">
        <div className="card-head"><div><h3>Solar forecast, next 48 hours</h3><p className="xs muted">{sf?.note ?? 'Loading…'}</p></div><Chip tone={sf?.source === 'live' ? 'ok' : 'warn'}>{sf ? (sf.source === 'live' ? 'Open-Meteo · live' : 'simulated') : '…'}</Chip></div>
        <div className="row" style={{ alignItems: 'flex-end', gap: 2, height: 110, flexWrap: 'nowrap' }}>
          {hours.map((h) => <div key={h.time} title={`${h.time.replace('T', ' ')} · ${Math.round(h.ghi)} W/m² · cloud ${h.cloud}%`} style={{ flex: 1, height: `${(h.ghi / max) * 100}%`, minHeight: 1, background: 'var(--c4)', opacity: 0.35 + 0.65 * (1 - h.cloud / 100), borderRadius: 2 }} />)}
        </div>
        <div className="row-between xs muted" style={{ marginTop: 4 }}><span>now</span><span>+24 h</span><span>+48 h</span></div>
        <p className="small" style={{ marginTop: 6 }}>Expected from the {kwp} kWp roof: <strong>{Math.round(pvKwh(hours.slice(0, 24), kwp)).toLocaleString('en-IN')} kWh</strong> next 24 h, <strong>{Math.round(pvKwh(tomorrow, kwp)).toLocaleString('en-IN')} kWh</strong> the day after. The optimiser uses this to decide how much battery to keep for the evening peak.</p>
      </div>
      <div className="card stack-sm">
        <div className="row-between"><h3>Grid carbon now</h3><Chip tone={gc?.source === 'live' ? 'ok' : gc?.source === 'needs_key' ? 'info' : 'warn'}>{gc ? (gc.source === 'live' ? 'Electricity Maps · live' : gc.source === 'needs_key' ? 'needs key' : 'simulated') : '…'}</Chip></div>
        <div className="k-value num" style={{ fontFamily: 'var(--font-head)', fontSize: 34, fontWeight: 700 }}>{gc ? gc.gPerKwh : '—'} <span className="xs muted">g CO₂/kWh</span></div>
        <span className="xs muted">Zone {gc?.zone ?? SITE.zone} · CEA annual average {Math.round(cea * 1000)} g/kWh for BRSR.</span>
        <span className="xs muted">{gc?.note}</span>
      </div>
    </div>
  );
}

function ClusterPoolCard() {
  const { clock } = useCluster();
  const m = memberToday('vbw', clock);
  return (
    <div className="card row-between">
      <div className="row" style={{ flexWrap: 'nowrap' }}><span className="dot" style={{ background: 'var(--primary)' }} />
        <div><strong className="small">Grid purchase goes through the Adityapur cluster pool</strong><br /><span className="xs muted">At 450 kVA this plant is too small for open access alone. Through the pool today: ₹{fmt(m.rate, 2)}/kWh vs ₹{fmt(m.soloRate, 2)} on the DISCOM tariff · {fmt(m.share * 100, 1)}% of pool load · shared solar allocated by kWh consumed.</span></div></div>
      <a className="btn sm" href="#/cluster">Open cluster<Icon name="arrowright" size={16} /></a>
    </div>
  );
}

export default function Energy() {
  const { engine: e, error } = useSim();
  if (error) return <div className="banner block"><Icon name="alert" />The energy feed is not available: {error}</div>;
  if (!e) return <div className="card"><h3>Waiting for the plant's energy feed…</h3><p className="small muted">The EMS plans each 15-minute block once the smart meters and site controller report.</p></div>;
  const ems = e.ems;
  const blk = e.block;
  const mb = e.market;
  const L = landed(mb);
  const D = ems.last24();
  const T = { kwh: D.kwh, gasScm: D.gas, shiftedKwh: D.shifted, peakKw: D.peak };
  const savedToday = D.naiveCost - D.cost;
  const eveCut = D.naiveEve ? 1 - Math.max(0, D.eve) / D.naiveEve : 0;
  const kgCut = D.naiveKg - D.kg;
  const supplyToday = SOURCES.reduce((s, k) => s + T.kwh[k], 0);
  const N = { costInr: D.naiveCost, peakKw: D.naivePeak };
  const plan = ems.plan;
  const next = Array.from({ length: 8 }, (_, i) => {
    const b = (blk + 4 * (i + 1)) % 96;
    const m = (blk + 4 * (i + 1)) >= 96 ? ems.tomorrow[b] : ems.market[b];
    const l = landed(m);
    const opts: [string, number][] = [['DISCOM', l.discom + (ems.settings.carbonPrice / 1000) * CEA_EF], ['RTM', l.rtm + (ems.settings.carbonPrice / 1000) * CEA_EF], ['DAM', l.dam + (ems.settings.carbonPrice / 1000) * CEA_EF], ['G-DAM (green)', l.green]];
    opts.sort((a, b) => a[1] - b[1]);
    const action = m.stress >= 70 ? 'Battery + genset, export surplus' : m.solarGW > 12 ? 'Run flexible loads on solar, charge battery' : opts[0][1] < 6 ? 'Charge battery from cheap block' : 'Hold';
    return { b, m, l, best: opts[0][0], action };
  });
  const cl = clockLabel(e.clock);
  return (
    <div className="stack">
      <PageHead title="Energy & grid" sub={<>Grid-aware dispatch every 15 minutes, using exchange prices, the DISCOM tariff, solar, a battery and a gas genset. {cl.date} {cl.time}. <Chip tone={ems.settings.enabled ? 'ok' : 'warn'}>{ems.settings.enabled ? 'Optimiser ON' : 'Optimiser OFF (comparison)'}</Chip></>} />
      <ClusterPoolCard />
      <ExternalPanels kwp={e.ems.solarKwp} cea={CEA_EF} />
      <div className="banner info"><Icon name="info" />Market feed is simulated in the shape of IEX day-ahead, green day-ahead and real-time markets (96 blocks a day). In production this reads a licensed market-data feed; buying on the exchange needs open-access approval, available for green power from 100 kW.</div>
      <div className="grid g6">
        <Kpi label="Real-time price" value={`₹${mb.rtm.toFixed(2)}`} unit="/kWh" tone={mb.rtm >= 8 ? 'block' : mb.rtm <= 4 ? 'ok' : undefined} sub={`Block ${blk + 1}/96 · DISCOM ₹${L.discom.toFixed(2)}`} />
        <Kpi label="Grid stress" value={mb.stress} unit="/100" tone={mb.stress >= 70 ? 'block' : mb.stress >= 45 ? 'warn' : 'ok'} sub={`Marginal ${mb.marginalEf.toFixed(2)} kg CO₂/kWh`} />
        <Kpi label="Saved, last 24 h" value={`₹${fmt(savedToday, 0)}`} sub={`vs same plant, no optimiser (${N.costInr ? fmt((savedToday / N.costInr) * 100, 0) : 0}%)`} tone={savedToday > 0 ? 'ok' : undefined} />
        <Kpi label="Evening peak draw, 24 h" value={`−${fmt(eveCut * 100, 0)}%`} sub={`${fmt(Math.max(0, D.eve), 0)} vs ${fmt(D.naiveEve, 0)} kWh, 18–22 h`} tone={eveCut > 0.3 ? 'ok' : undefined} />
        <Kpi label="CO₂ cut, last 24 h" value={fmt(kgCut, 0)} unit="kg" sub="market-based, vs no optimiser" />
        <Kpi label="Peak demand" value={fmt(T.peakKw, 0)} unit="kW" sub={`no optimiser: ${fmt(N.peakKw, 0)} kW`} />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div><h3>Market today</h3><p className="xs muted">₹/kWh landed · shaded = grid-stress blocks · dotted grey = marginal grid emissions (right axis)</p></div></div>
          <MarketChart now={blk} />
          <div className="legend"><span><i style={{ background: SOURCE_COLOR.rtm }} />Real-time (actual → day-ahead forecast)</span><span><i style={{ background: SOURCE_COLOR.green }} />Green day-ahead + open-access charges</span><span><i style={{ background: SOURCE_COLOR.discom }} />DISCOM time-of-day tariff</span></div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>The duck curve, and what the plant does about it</h3><p className="xs muted">Line = regional demand minus solar (GW). Bars = plant's net draw (blue) or export (green) over the last 24 h; pale red = draw without the optimiser.</p></div></div>
          <DuckChart now={blk} />
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h3>How every 15-minute block was supplied, last 24 hours</h3><p className="xs muted">kW by source; below the line is power sold back to the grid</p></div>
          <div className="legend">{SOURCES.map((s) => <span key={s}><i style={{ background: SOURCE_COLOR[s] }} />{SOURCE_LABEL[s]}</span>)}</div></div>
        <DispatchChart />
        <div className="grid g6" style={{ marginTop: 10 }}>
          {SOURCES.map((s) => <div key={s} className="small"><span className="dot" style={{ background: SOURCE_COLOR[s] }} />{SOURCE_LABEL[s]}<br /><strong className="num">{fmt(T.kwh[s], 0)} kWh</strong> <span className="muted xs">{supplyToday ? fmt((T.kwh[s] / supplyToday) * 100, 0) : 0}%</span></div>)}
        </div>
      </div>

      <div className="grid g4">
        <div className="card stack-sm">
          <div className="row-between"><h3>Rooftop solar</h3><Chip tone={ems.cloud ? 'warn' : 'ok'}>{ems.cloud ? 'cloudy' : `${ems.solarKwp} kWp`}</Chip></div>
          <div className="k-value num" style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 700 }}>{fmt(e.last.solar, 0)} <span className="xs muted">kW</span></div>
          <span className="xs muted">{fmt(T.kwh.solar, 0)} kWh in 24 h · {fmt(ems.totals.solarKwh, 0)} kWh since EMS start</span>
        </div>
        <div className="card stack-sm">
          <div className="row-between"><h3>Battery</h3><Chip tone={e.last.bess > 1 ? 'warn' : e.last.bess < -1 ? 'info' : 'neutral'}>{e.last.bess > 1 ? 'discharging' : e.last.bess < -1 ? 'charging' : 'idle'}</Chip></div>
          <div className="bar-track" style={{ height: 22, borderRadius: 6 }}><div className="bar-fill" style={{ width: `${ems.bess.soc * 100}%`, background: SOURCE_COLOR.bess, borderRadius: 6, transition: 'width .3s' }} /></div>
          <span className="xs muted">{fmt(ems.bess.soc * 100, 0)}% of {ems.bess.capKwh} kWh · {fmt(Math.abs(e.last.bess), 0)} kW · reserve {Math.round(ems.settings.reserveSoc * 100)}% kept for outages</span>
        </div>
        <div className="card stack-sm">
          <div className="row-between"><h3>Gas genset (CHP)</h3><Chip tone={ems.gen.on ? 'warn' : 'neutral'}>{ems.gen.on ? 'running' : 'off'}</Chip></div>
          <div className="k-value num" style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 700 }}>{fmt(e.last.genset, 0)} <span className="xs muted">kW</span></div>
          <span className="xs muted">{fmt(T.kwh.genset, 0)} kWh · {fmt(T.gasScm, 0)} scm gas in 24 h. Runs when grid power is dearer or dirtier than ₹{(5.6 + ems.settings.carbonPrice / 1000 * 0.61).toFixed(2)}/kWh; waste heat feeds the paint oven.</span>
        </div>
        <div className="card stack-sm">
          <div className="row-between"><h3>Flexible loads</h3><Chip tone={e.ems.flows.flexRun > 0 ? 'ok' : 'neutral'}>{e.ems.flows.flexRun > 0 ? 'running' : 'deferred'}</Chip></div>
          <div className="k-value num" style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 700 }}>{fmt(e.flexQueue, 0)} <span className="xs muted">kWh queued</span></div>
          <span className="xs muted">Shot-blast batches, forklift charging, oven pre-heat. Moved into solar or cheap blocks; always done before the 21:00 deadline. {fmt(T.shiftedKwh, 0)} kWh shifted in 24 h.</span>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h3>Decision log</h3><span className="xs muted">One decision per 15-minute block, with the reason</span></div>
          <div className="stack-sm" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <div className="held" style={{ borderColor: 'var(--primary)', background: 'var(--primary-soft)' }}><div className="row"><Chip tone="ok">now · {hh(blk)}</Chip><strong className="small">{plan.reason || 'planning…'}</strong></div></div>
            {ems.decisions.slice(0, 30).map((d) => (
              <div key={d.t} className="row-between small" style={{ borderBottom: '1px solid var(--border)', padding: '6px 0', alignItems: 'flex-start' }}>
                <span style={{ flex: 1 }}><span className="mono">{hh(d.block)}</span> {d.text}</span>
                <span className="num xs" style={{ whiteSpace: 'nowrap', color: d.savedInr >= 0 ? 'var(--success)' : 'var(--danger)' }}>{d.savedInr >= 0 ? '+' : ''}₹{fmt(d.savedInr, 0)} · {fmt(d.avoidedKg, 0)} kg</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Procurement plan, next 8 hours</h3><span className="xs muted">Cheapest source per hour incl. ₹{fmt(ems.settings.carbonPrice)}/t internal carbon price</span></div>
          <div className="table-wrap"><table className="t"><thead><tr><th>Time</th><th className="r">RTM</th><th className="r">DISCOM</th><th className="r">Green</th><th className="r">Stress</th><th>Buy</th><th>Plan</th></tr></thead>
            <tbody>{next.map((r) => <tr key={r.b}><td className="mono">{hh(r.b)}</td><td className="r">₹{r.m.rtm.toFixed(2)}</td><td className="r">₹{r.l.discom.toFixed(2)}</td><td className="r">₹{r.l.green.toFixed(2)}</td><td className="r">{r.m.stress >= 70 ? <Chip tone="block">{r.m.stress}</Chip> : r.m.stress}</td><td><strong>{r.best}</strong></td><td className="small" style={{ whiteSpace: 'normal', minWidth: 180 }}>{r.action}</td></tr>)}</tbody></table></div>
        </div>
      </div>

      <div className="grid g4">
        <Kpi label="Grid support: demand-response calls" value={ems.drEvents} sub={`${fmt(ems.drKwh, 0)} kWh of load paused on request`} />
        <Kpi label="Sold to grid" value={fmt(ems.totals.exportKwh, 0)} unit="kWh" sub={`₹${fmt(ems.totals.exportInr, 0)} earned since EMS start`} />
        <Kpi label="Outage ride-through" value={fmt(ems.islandMin, 0)} unit="min" sub="Critical load carried by solar, battery, genset" />
        <Kpi label="Since EMS start" value={`₹${fmt(ems.totals.savedInr, 0)}`} sub={`${fmt(ems.totals.avoidedKg / 1000, 2)} t CO₂ avoided at marginal grid factor`} />
      </div>

      <div className="card stack-sm">
        <h3>Optimiser settings</h3>
        <div className="grid g3">
          <label className="field"><span className="label-text">Internal carbon price: ₹{fmt(ems.settings.carbonPrice)}/t CO₂</span><input type="range" min={0} max={5000} step={100} value={ems.settings.carbonPrice} onChange={(ev) => e.setEms({ carbonPrice: Number(ev.target.value) })} /></label>
          <label className="field"><span className="label-text">Green open-access cap: {ems.settings.greenCapKw} kW</span><input type="range" min={0} max={300} step={10} value={ems.settings.greenCapKw} onChange={(ev) => e.setEms({ greenCapKw: Number(ev.target.value) })} /></label>
          <label className="field"><span className="label-text">Battery reserve for outages: {Math.round(ems.settings.reserveSoc * 100)}%</span><input type="range" min={0} max={60} step={5} value={ems.settings.reserveSoc * 100} onChange={(ev) => e.setEms({ reserveSoc: Number(ev.target.value) / 100 })} /></label>
        </div>
        <SolverCompare solver={ems.settings.solver} onSolver={(v) => e.setEms({ solver: v })} />
        <p className="xs muted">A higher carbon price makes the optimiser prefer green and genset power even when grid power is a little cheaper. Prices, open-access charges, asset sizes and grid curves are illustrative.</p>
      </div>
    </div>
  );
}

interface LpResult { available: boolean; note: string; blocks?: number; lpCostInr?: number; rulesCostInr?: number; naiveCostInr?: number; lpVsRulesPct?: number }
/** Optional optimiser: a 96-block linear programme (PuLP) on the last 24 h of metered load, compared with the rules that ran. */
function SolverCompare({ solver, onSolver }: { solver: string; onSolver: (v: string) => void }) {
  const [res, setRes] = useState<LpResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => { setBusy(true); api<LpResult>('/energy/compare-lp').then(setRes).catch((e: Error) => setRes({ available: false, note: e.message })).finally(() => setBusy(false)); };
  return (
    <div className="card stack-sm" style={{ boxShadow: 'none' }}>
      <div className="row-between"><strong className="small">Dispatch method</strong>
        <div className="row"><select className="input" style={{ minHeight: 32 }} value={solver} onChange={(ev) => onSolver(ev.target.value)} aria-label="Dispatch method"><option value="rules">Rule-based (default)</option><option value="lp">LP optimiser (compare)</option></select>
          <button className="btn sm" onClick={run} disabled={busy}>{busy ? 'Solving…' : 'Compare last 24 h'}</button></div></div>
      {res && (res.available
        ? <div className="grid g3"><Kpi label="Rules (actual)" value={`₹${fmt(res.rulesCostInr!, 0)}`} sub={`${res.blocks} blocks, incl. carbon price`} /><Kpi label="LP optimum" value={`₹${fmt(res.lpCostInr!, 0)}`} sub={`${fmt(res.lpVsRulesPct!, 1)}% vs rules`} tone="ok" /><Kpi label="Naive twin" value={`₹${fmt(res.naiveCostInr!, 0)}`} sub="no optimiser" /></div>
        : <p className="xs muted">{res.note}</p>)}
      {res?.available && <p className="xs muted">{res.note}</p>}
    </div>
  );
}
