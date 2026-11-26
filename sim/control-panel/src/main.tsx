import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './Icon';
import './styles.css';
import { DeviceIndex, DevicePage } from './Devices';

type DeviceId = 'meters' | 'stores' | 'line' | 'paint' | 'docs' | 'grid';
interface State {
  connected: boolean; clock: number; running: boolean; speed: number; kw: number; kva: number; contract: number; held: number; apiQueue: number;
  online: Record<DeviceId, boolean>; queued: Record<DeviceId, number>; devices: { id: DeviceId; label: string; sub: string }[];
  ems: { rtm: number; stress: number; soc: number; enabled: boolean; carbonPrice: number; cloud: boolean; leak: boolean; stressEvent: boolean };
  surge: boolean; powerCut: boolean; cluster: { overdraw: boolean; joined: boolean; heatTrip: boolean }; log: { t: number; level: string; text: string }[];
}

const clock = (t: number) => {
  const d = new Date(t);
  return { time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`, date: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) };
};

/** Demo controls: a presenter's console for the simulator. Separate app, separate port; not part of the product. */
function ControlPanel() {
  const [c, setC] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => fetch('/sim/state').then((r) => r.json()).then((s) => { setC(s); setErr(null); }).catch(() => setErr('Simulator not reachable on :5175. Start it with scripts\\dev.ps1.'));
  useEffect(() => { load(); const t = window.setInterval(load, 1000); return () => window.clearInterval(t); }, []);
  const cmd = (name: string, v?: unknown, d?: string) => fetch('/sim/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, v, d }) }).then((r) => r.json()).then(setC).catch(() => setErr('Command failed'));
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.code === 'Space' && c) { ev.preventDefault(); cmd('run', !c.running); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  if (!c) return <aside className="console standalone"><div className="cnote">{err ?? 'Connecting to the simulator…'}</div></aside>;
  const t = clock(c.clock);
  return (
    <aside className="console standalone" aria-label="Demo controls">
      <div className="console-head"><div><div className="console-kicker">Demo controls</div><div className="console-sub">Simulator only · not part of the product</div></div></div>
      {err && <div className="cnote">{err}</div>}
      {c.apiQueue > 0 && <div className="cnote">{c.apiQueue} posts waiting for the API (it will retry).</div>}
      <section>
        <h4>Clock</h4>
        <div className="cclock"><span className="num">{t.time}</span><span>{t.date}</span></div>
        <div className="crow">
          <button className={`cbtn ${c.running ? '' : 'on'}`} onClick={() => cmd('run', !c.running)}><Icon name={c.running ? 'minus' : 'arrowright'} size={16} />{c.running ? 'Pause' : 'Play'}</button>
          <button className="cbtn" onClick={() => cmd('nextShift')}>Skip to next shift</button>
        </div>
        <div className="cseg" role="group" aria-label="Speed">{[1, 5, 15, 60].map((s) => <button key={s} aria-pressed={c.speed === s} onClick={() => cmd('speed', s)}>{s}×</button>)}</div>
        <div className="chint">1× = one plant-minute per second. 60× = an hour per second.</div>
      </section>
      <section>
        <h4>Live readings</h4>
        <div className="cstats">
          <div><b className="num">{c.kw.toFixed(0)}</b><span>kW</span></div>
          <div className={c.kva > c.contract ? 'bad' : ''}><b className="num">{c.kva.toFixed(0)}</b><span>kVA / {c.contract}</span></div>
          <div className={c.held ? 'bad' : ''}><b className="num">{c.held}</b><span>held</span></div>
        </div>
      </section>
      <section>
        <h4>Devices</h4>
        {c.devices.filter((d) => d.id !== 'docs' && d.id !== 'grid').map((d) => (
          <label key={d.id} className="ctoggle">
            <span><b>{d.label}</b><em>{c.online[d.id] ? 'online' : `offline · ${c.queued[d.id]} saved`}</em></span>
            <input type="checkbox" checked={c.online[d.id]} onChange={(e) => cmd('online', e.target.checked, d.id)} /><i />
          </label>
        ))}
      </section>
      <section>
        <h4>Grid & energy</h4>
        <div className="cstats">
          <div><b className="num">₹{c.ems.rtm.toFixed(1)}</b><span>RTM /kWh</span></div>
          <div className={c.ems.stress >= 70 ? 'bad' : ''}><b className="num">{c.ems.stress}</b><span>grid stress</span></div>
          <div><b className="num">{Math.round(c.ems.soc * 100)}%</b><span>battery</span></div>
        </div>
        <label className="ctoggle">
          <span><b>Grid-aware optimiser</b><em>{c.ems.enabled ? 'on: buying, storing, selling by price + carbon' : 'off: naive plant, for comparison'}</em></span>
          <input type="checkbox" checked={c.ems.enabled} onChange={(e) => cmd('ems', { enabled: e.target.checked })} /><i />
        </label>
        <div className="cgrid">
          <button className={`cbtn warn ${c.ems.stressEvent ? 'on' : ''}`} onClick={() => cmd('inject', 'gridStress')}>DISCOM DR call</button>
          <button className="cbtn warn" onClick={() => cmd('inject', 'priceSpike')}>IEX price spike</button>
          <button className={`cbtn ${c.ems.cloud ? 'on' : ''}`} onClick={() => cmd('inject', 'cloud')}>{c.ems.cloud ? 'Clear the clouds' : 'Cloud over solar'}</button>
          <button className={`cbtn bad ${c.ems.leak ? 'on' : ''}`} onClick={() => cmd('inject', 'leak')}>{c.ems.leak ? 'Fix air leak' : 'Compressor air leak'}</button>
        </div>
        <label className="chint">Internal carbon price ₹{c.ems.carbonPrice}/t
          <input type="range" min={0} max={5000} step={100} defaultValue={c.ems.carbonPrice} onMouseUp={(e) => cmd('ems', { carbonPrice: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => cmd('ems', { carbonPrice: Number((e.target as HTMLInputElement).value) })} style={{ width: '100%' }} /></label>
      </section>
      <section>
        <h4>Inject an event</h4>
        <div className="cgrid">
          <button className="cbtn bad" onClick={() => cmd('inject', 'typo')}>Typo: extra zero</button>
          <button className="cbtn bad" onClick={() => cmd('inject', 'negative')}>Issue more than stock</button>
          <button className="cbtn bad" onClick={() => cmd('inject', 'duplicate')}>Duplicate slip</button>
          <button className="cbtn bad" onClick={() => cmd('inject', 'meterGlitch')}>Meter glitch</button>
          <button className={`cbtn warn ${c.surge ? 'on' : ''}`} onClick={() => cmd('inject', 'surge')}>Peak load</button>
          <button className={`cbtn warn ${c.powerCut ? 'on' : ''}`} onClick={() => cmd('inject', 'powerCut')}>Grid outage</button>
          <button className="cbtn" onClick={() => cmd('inject', 'delivery')}>Gas delivery</button>
        </div>
      </section>
      <section>
        <h4>FMCG batch tracing</h4>
        <button className="cbtn bad" onClick={() => cmd('recall')}>Flag a bad ingredient lot</button>
        <div className="chint">A supplier reports a contaminated seasoning lot. Every batch that used it is traced and recalled.</div>
      </section>
      <section>
        <h4>Cluster (Kalundborg-style)</h4>
        <div className="cgrid">
          <button className={`cbtn warn ${c.cluster.overdraw ? 'on' : ''}`} onClick={() => cmd('cluster', 'overdraw')}>Member over-draws</button>
          <button className={`cbtn ${c.cluster.joined ? 'on' : ''}`} onClick={() => cmd('cluster', 'join')}>{c.cluster.joined ? 'Member leaves' : 'New member joins'}</button>
          <button className="cbtn warn" onClick={() => cmd('cluster', 'scrapShort')}>Foundry short of scrap</button>
          <button className={`cbtn bad ${c.cluster.heatTrip ? 'on' : ''}`} onClick={() => cmd('cluster', 'heatTrip')}>{c.cluster.heatTrip ? 'Restore heat exchanger' : 'Heat exchanger trips'}</button>
          <button className="cbtn bad" onClick={() => cmd('cluster', 'mismatch')}>Weighbridge mismatch</button>
        </div>
      </section>
      <section>
        <h4>Scenarios</h4>
        <div className="cgrid">
          {[['normal', 'Normal running'], ['errors', 'Data-entry errors'], ['peak', 'Peak demand'], ['outage', 'Network outage, 2 h']].map(([v, l]) => <button key={v} className="cbtn" onClick={() => cmd('scenario', v)}>{l}</button>)}
        </div>
      </section>
      <section>
        <h4>Field devices (sensors & CO₂ analysers)</h4>
        <a className="cbtn" href="#/devices" target="_blank" rel="noreferrer">Open device pages</a>
        <div className="chint">One page per meter, inverter, BMS, genset and CO₂ analyser: watch, override, or take it offline.</div>
      </section>
      <section>
        <h4>Data</h4>
        <button className="cbtn" onClick={() => { if (confirm('Reset all demo data? The database is re-seeded and the simulator restarts from 10 Nov 05:50.')) cmd('reset'); }}>Reset all demo data</button>
        <div className="chint">Space = play / pause. All companies and figures are simulated.</div>
      </section>
      <section>
        <h4>Simulator log</h4>
        <div className="stack-sm" style={{ maxHeight: 220, overflowY: 'auto' }}>{c.log.slice(0, 12).map((l, i) => <div key={i} className="chint">{clock(l.t).time} · {l.text}</div>)}</div>
      </section>
    </aside>
  );
}

function Router() {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  if (h.startsWith('#/device/')) return <DevicePage id={h.slice('#/device/'.length)} />;
  if (h.startsWith('#/devices')) return <DeviceIndex />;
  return <ControlPanel />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Router /></StrictMode>);
