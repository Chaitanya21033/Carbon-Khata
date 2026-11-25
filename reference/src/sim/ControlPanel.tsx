import { useSim, type Command } from './SimProvider';
import { DEVICES, type DeviceId, type Speed } from './engine';
import { clockLabel } from '../screens/Live';
import { Icon } from '../ui/Icon';

/** Demo controls. Deliberately separate from the product UI: a presenter's console, not a supplier feature. */
export default function ControlPanel({ onClose, standalone = false }: { onClose?: () => void; standalone?: boolean }) {
  const { control: c, send } = useSim();
  const cmd = (x: Command) => send(x);
  const t = clockLabel(c.clock);
  const popOut = () => {
    const url = `${location.href.split('#')[0]}#/control`;
    const w = window.open(url, 'ck-control', 'width=420,height=860');
    if (!w) alertless();
  };
  const alertless = () => { /* pop-ups blocked: the docked panel keeps working */ };
  return (
    <aside className={`console ${standalone ? 'standalone' : ''}`} aria-label="Demo controls">
      <div className="console-head">
        <div><div className="console-kicker">Demo controls</div><div className="console-sub">Simulator only · not part of the product</div></div>
        <div className="row" style={{ gap: 6 }}>
          {!standalone && <button className="cbtn icon" onClick={popOut} title="Open in a separate window"><Icon name="share" size={16} /></button>}
          {onClose && <button className="cbtn icon" onClick={onClose} aria-label="Hide controls"><Icon name="x" size={16} /></button>}
        </div>
      </div>
      {!c.connected && <div className="cnote">Waiting for the app window… keep the app open in another tab of this browser.</div>}

      <section>
        <h4>Clock</h4>
        <div className="cclock"><span className="num">{t.time}</span><span>{t.date}</span></div>
        <div className="crow">
          <button className={`cbtn ${c.running ? '' : 'on'}`} onClick={() => cmd({ name: 'run', v: !c.running })}><Icon name={c.running ? 'minus' : 'arrowright'} size={16} />{c.running ? 'Pause' : 'Play'}</button>
          <button className="cbtn" onClick={() => cmd({ name: 'nextShift' })}>Skip to next shift</button>
        </div>
        <div className="cseg" role="group" aria-label="Speed">
          {([1, 5, 15, 60] as Speed[]).map((s) => <button key={s} aria-pressed={c.speed === s} onClick={() => cmd({ name: 'speed', v: s })}>{s}×</button>)}
        </div>
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
        {DEVICES.filter((d) => d.id !== 'docs' && d.id !== 'grid').map((d) => (
          <label key={d.id} className="ctoggle">
            <span><b>{d.label}</b><em>{c.online[d.id] ? 'online' : `offline · ${c.queued[d.id]} saved`}</em></span>
            <input type="checkbox" checked={c.online[d.id]} onChange={(e) => cmd({ name: 'online', d: d.id as DeviceId, v: e.target.checked })} />
            <i />
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
          <input type="checkbox" checked={c.ems.enabled} onChange={(e) => cmd({ name: 'ems', v: { enabled: e.target.checked } })} />
          <i />
        </label>
        <div className="cgrid">
          <button className={`cbtn warn ${c.ems.stressEvent ? 'on' : ''}`} onClick={() => cmd({ name: 'inject', v: 'gridStress' })}>DISCOM DR call</button>
          <button className="cbtn warn" onClick={() => cmd({ name: 'inject', v: 'priceSpike' })}>IEX price spike</button>
          <button className={`cbtn ${c.ems.cloud ? 'on' : ''}`} onClick={() => cmd({ name: 'inject', v: 'cloud' })}>{c.ems.cloud ? 'Clear the clouds' : 'Cloud over solar'}</button>
          <button className={`cbtn bad ${c.ems.leak ? 'on' : ''}`} onClick={() => cmd({ name: 'inject', v: 'leak' })}>{c.ems.leak ? 'Fix air leak' : 'Compressor air leak'}</button>
        </div>
        <label className="chint">Internal carbon price ₹{c.ems.carbonPrice}/t
          <input type="range" min={0} max={5000} step={100} value={c.ems.carbonPrice} onChange={(e) => cmd({ name: 'ems', v: { carbonPrice: Number(e.target.value) } })} style={{ width: '100%' }} /></label>
      </section>

      <section>
        <h4>Inject an event</h4>
        <div className="cgrid">
          <button className="cbtn bad" onClick={() => cmd({ name: 'inject', v: 'typo' })}>Typo: extra zero</button>
          <button className="cbtn bad" onClick={() => cmd({ name: 'inject', v: 'negative' })}>Issue more than stock</button>
          <button className="cbtn bad" onClick={() => cmd({ name: 'inject', v: 'duplicate' })}>Duplicate slip</button>
          <button className="cbtn bad" onClick={() => cmd({ name: 'inject', v: 'meterGlitch' })}>Meter glitch</button>
          <button className={`cbtn warn ${c.surge ? 'on' : ''}`} onClick={() => cmd({ name: 'inject', v: 'surge' })}>Peak load</button>
          <button className={`cbtn warn ${c.powerCut ? 'on' : ''}`} onClick={() => cmd({ name: 'inject', v: 'powerCut' })}>Grid outage</button>
          <button className="cbtn" onClick={() => cmd({ name: 'inject', v: 'delivery' })}>Gas delivery</button>
        </div>
      </section>

      <section>
        <h4>FMCG batch tracing</h4>
        <button className="cbtn bad" onClick={() => cmd({ name: 'recall' })}>Flag a bad ingredient lot</button>
        <div className="chint">A supplier reports a contaminated seasoning lot. Every batch that used it is traced and recalled.</div>
      </section>

      <section>
        <h4>Cluster (Kalundborg-style)</h4>
        <div className="cgrid">
          <button className={`cbtn warn ${c.cluster.overdraw ? 'on' : ''}`} onClick={() => cmd({ name: 'cluster', v: 'overdraw' })}>Member over-draws</button>
          <button className={`cbtn ${c.cluster.joined ? 'on' : ''}`} onClick={() => cmd({ name: 'cluster', v: 'join' })}>{c.cluster.joined ? 'Member leaves' : 'New member joins'}</button>
          <button className="cbtn warn" onClick={() => cmd({ name: 'cluster', v: 'scrapShort' })}>Foundry short of scrap</button>
          <button className={`cbtn bad ${c.cluster.heatTrip ? 'on' : ''}`} onClick={() => cmd({ name: 'cluster', v: 'heatTrip' })}>{c.cluster.heatTrip ? 'Restore heat exchanger' : 'Heat exchanger trips'}</button>
          <button className="cbtn bad" onClick={() => cmd({ name: 'cluster', v: 'mismatch' })}>Weighbridge mismatch</button>
        </div>
        <div className="chint">IEX price spike (above) also shows the pool's hedge on the Cluster page.</div>
      </section>

      <section>
        <h4>Scenarios</h4>
        <div className="cgrid">
          <button className="cbtn" onClick={() => cmd({ name: 'scenario', v: 'normal' })}>Normal running</button>
          <button className="cbtn" onClick={() => cmd({ name: 'scenario', v: 'errors' })}>Data-entry errors</button>
          <button className="cbtn" onClick={() => cmd({ name: 'scenario', v: 'peak' })}>Peak demand</button>
          <button className="cbtn" onClick={() => cmd({ name: 'scenario', v: 'outage' })}>Network outage, 2 h</button>
        </div>
      </section>

      <section>
        <h4>Data</h4>
        <button className="cbtn" onClick={() => cmd({ name: 'reset' })}>Reset all demo data</button>
        <div className="chint">Space = play / pause. All companies and figures are simulated.</div>
      </section>
    </aside>
  );
}
