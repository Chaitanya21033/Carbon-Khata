import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SIM_KEY, useStore } from '../state/store';
import { OPEN_MONTH, CONTRACT_KVA } from '../domain/synth';
import { balance } from '../domain/ledger';
import { bus } from './bus';
import { cluster, type ClusterEvent } from './cluster';
import { SimEngine, type DeviceId, type PostRequest, type Speed } from './engine';

const START = Date.UTC(2026, 10, 10, 5, 50);
const CHANNEL = 'carbonkhata-sim';

/** What the control panel needs, whether it runs in this window or a pop-out window. */
export interface ControlState {
  clock: number; running: boolean; speed: Speed; online: Record<DeviceId, boolean>; queued: Record<DeviceId, number>;
  held: number; kw: number; kva: number; contract: number; surge: boolean; powerCut: boolean; connected: boolean;
  ems: { enabled: boolean; carbonPrice: number; soc: number; rtm: number; stress: number; solar: number; cloud: boolean; leak: boolean; stressEvent: boolean };
  cluster: { joined: boolean; heatTrip: boolean; overdraw: boolean };
}
export type Command =
  | { name: 'run'; v: boolean } | { name: 'speed'; v: Speed } | { name: 'online'; d: DeviceId; v: boolean }
  | { name: 'inject'; v: Parameters<SimEngine['inject']>[0] } | { name: 'scenario'; v: Parameters<SimEngine['scenario']>[0] }
  | { name: 'nextShift' } | { name: 'reset' } | { name: 'ems'; v: { enabled?: boolean; carbonPrice?: number } } | { name: 'recall' } | { name: 'cluster'; v: ClusterEvent };

interface Ctx { engine: SimEngine | null; control: ControlState; send: (c: Command) => void }
const SimCtx = createContext<Ctx | null>(null);

function stateOf(e: SimEngine): ControlState {
  return {
    clock: e.clock, running: e.running, speed: e.speed, online: { ...e.online },
    queued: Object.fromEntries(Object.entries(e.queues).map(([k, v]) => [k, v.length])) as Record<DeviceId, number>,
    held: e.quarantine.length, kw: e.kw, kva: e.last.kva, contract: e.contractKva, surge: e.clock < e.surgeUntil, powerCut: e.clock < e.powerCutUntil, connected: true,
    ems: { enabled: e.ems.settings.enabled, carbonPrice: e.ems.settings.carbonPrice, soc: e.ems.bess.soc, rtm: e.last.price, stress: e.market.stress, solar: e.last.solar, cloud: e.ems.cloud > 0, leak: e.clock < e.leakUntil, stressEvent: e.ems.stressEventUntil > e.clock },
    cluster: { joined: cluster.joined, heatTrip: e.clock < cluster.heatTripUntil, overdraw: e.clock < cluster.overdrawUntil },
  };
}

export const isControlWindow = () => typeof location !== 'undefined' && location.hash.startsWith('#/control');

export function SimProvider({ children }: { children: ReactNode }) {
  const { actions, d } = useStore();
  const remote = isControlWindow();
  const buf = useRef<PostRequest[]>([]);
  const actRef = useRef(actions);
  actRef.current = actions;
  const [gen, setGen] = useState(0);

  const engine = useMemo(() => {
    if (remote) return null;
    const stock: Record<string, number> = {};
    for (const r of ['CO2_GAS', 'LPG', 'HYD_OIL', 'OXYGEN', 'ARGON']) {
      const b = balance(d.idx, r, OPEN_MONTH);
      stock[r] = (b.opening ?? 0) + b.received - b.issued;
    }
    const e = new SimEngine({ start: START, contractKva: CONTRACT_KVA, stock, post: (r) => { buf.current.push(r); return true; } });
    let restored = false;
    try { const raw = localStorage.getItem(SIM_KEY); if (raw) { e.restore(JSON.parse(raw)); restored = true; } } catch { /* fresh start */ }
    if (!restored) e.warmUp(24 * 60); // run the previous day so every chart opens with a full 24 hours
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, gen]);

  // clock + batching + persistence
  useEffect(() => {
    if (!engine) return;
    let last = performance.now();
    const t = window.setInterval(() => {
      const now = performance.now();
      engine.tick(now - last);
      last = now;
      cluster.advance(engine.clock);
      if (buf.current.length) { const b = buf.current; buf.current = []; actRef.current.postSim(b); }
    }, 250);
    const save = window.setInterval(() => { try { localStorage.setItem(SIM_KEY, JSON.stringify(engine.snapshot())); } catch { /* ignore */ } }, 4000);
    const off = bus.on((m) => { if (!m.queued) engine.noteManual(m.registerId, m.line, m.qty); });
    const reset = () => { cluster.reset(); setGen((g) => g + 1); };
    window.addEventListener('ck-reset-sim', reset);
    return () => { window.clearInterval(t); window.clearInterval(save); off(); window.removeEventListener('ck-reset-sim', reset); };
  }, [engine]);

  // keyboard: space = play/pause (when not typing)
  useEffect(() => {
    if (!engine) return;
    const k = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (ev.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) { ev.preventDefault(); engine.setRunning(!engine.running); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [engine]);

  // pop-out control window bridge
  const chan = useMemo(() => { try { return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null; } catch { return null; } }, []);
  const exec = (c: Command) => {
    if (!engine) return;
    if (c.name === 'run') engine.setRunning(c.v);
    if (c.name === 'speed') engine.setSpeed(c.v);
    if (c.name === 'online') engine.setOnline(c.d, c.v);
    if (c.name === 'inject') engine.inject(c.v);
    if (c.name === 'scenario') engine.scenario(c.v);
    if (c.name === 'nextShift') engine.jumpToNextShift();
    if (c.name === 'reset') actRef.current.reset();
    if (c.name === 'ems') engine.setEms(c.v);
    if (c.name === 'cluster') cluster.inject(c.v, engine.clock);
    if (c.name === 'recall') window.dispatchEvent(new Event('ck-recall'));
  };
  const [remoteState, setRemoteState] = useState<ControlState | null>(null);
  useEffect(() => {
    if (!chan) return;
    if (engine) {
      chan.onmessage = (m) => { if (m.data?.type === 'cmd') exec(m.data.cmd); };
      const t = window.setInterval(() => chan.postMessage({ type: 'state', state: stateOf(engine) }), 400);
      return () => window.clearInterval(t);
    }
    chan.onmessage = (m) => { if (m.data?.type === 'state') setRemoteState(m.data.state); };
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chan, engine]);

  const version = useSyncExternalStore(engine ? engine.subscribe : noop, engine ? engine.getVersion : zero);
  void version;
  const control: ControlState = engine ? stateOf(engine) : remoteState ?? { clock: START, running: false, speed: 5, online: { meters: true, stores: true, line: true, paint: true, docs: true, grid: true }, queued: { meters: 0, stores: 0, line: 0, paint: 0, docs: 0, grid: 0 }, held: 0, kw: 0, kva: 0, contract: CONTRACT_KVA, surge: false, powerCut: false, connected: false, ems: { enabled: true, carbonPrice: 1500, soc: 0.5, rtm: 0, stress: 0, solar: 0, cloud: false, leak: false, stressEvent: false }, cluster: { joined: false, heatTrip: false, overdraw: false } };
  const send = (c: Command) => (engine ? exec(c) : chan?.postMessage({ type: 'cmd', cmd: c }));

  return <SimCtx.Provider value={{ engine, control, send }}>{children}</SimCtx.Provider>;
}
const noop = () => () => {};
const zero = () => 0;

export function useSim(): Ctx {
  const v = useContext(SimCtx);
  if (!v) throw new Error('SimProvider missing');
  return v;
}
