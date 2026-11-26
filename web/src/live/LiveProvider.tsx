// Live data from the API: twin snapshot (GET /live/state, then SSE "twin" events), data-flow packets (SSE "packet"),
// and cache invalidation on ledger / passport / batch / cluster events. No simulator code runs in the product.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken } from '../api/client';
import { useStore } from '../state/store';
import { toEngine, type LiveEngine, type Packet, type Passport, type Snapshot } from './engine';

interface Ctx {
  engine: LiveEngine | null; connected: boolean; error: string | null; passports: Passport[]; hiddenOtherOems: number;
  control: { clock: number; ems: { cloud: boolean } };
  onEvent: (kind: string, fn: (data: unknown) => void) => () => void;
}
const LiveCtx = createContext<Ctx | null>(null);
const PLANT_ROLES = new Set(['operator', 'custodian', 'owner', 'admin']);

export function SimProvider({ children }: { children: ReactNode }) { return <LiveProvider>{children}</LiveProvider>; }

export function LiveProvider({ children }: { children: ReactNode }) {
  const { s, actions, notify } = useStore();
  const qc = useQueryClient();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const packetFns = useRef(new Set<(p: Packet) => void>());
  const eventFns = useRef(new Map<string, Set<(d: unknown) => void>>());
  const role = s.role;
  const live = !!role && PLANT_ROLES.has(role) && s.me?.tenant.id !== 'afl';
  const canPassports = !!role && (PLANT_ROLES.has(role) || (role === 'oem' && s.me?.tenant.kind === 'oem')) && s.me?.tenant.id !== 'afl';

  const pq = useQuery({ queryKey: ['passports', s.me?.id], queryFn: () => api<{ passports: Passport[]; hiddenOtherOems: number }>('/passports?limit=300'), enabled: canPassports, staleTime: 10_000 });

  useEffect(() => {
    if (!live) { setSnap(null); return; }
    let stop = false;
    api<Snapshot>('/live/state').then((x) => { if (!stop) { setSnap(x); setError(null); } }).catch((e: Error) => setError(e.message));
    return () => { stop = true; };
  }, [live, s.me?.id]);

  useEffect(() => {
    if (!role) return;
    const token = getToken();
    let es: EventSource | null = null;
    let timer: number | undefined;
    const pending = new Set<string>();
    const flush = () => { timer = undefined; pending.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); pending.clear(); };
    const inval = (k: string) => { pending.add(k); if (!timer) timer = window.setTimeout(flush, 1200); };
    const open = () => {
      es = new EventSource(`/api/v1/stream?token=${encodeURIComponent(token)}`);
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.addEventListener('twin', (m) => { const x = JSON.parse((m as MessageEvent).data) as Snapshot; setSnap((p) => (p ? { ...x, events: x.events } : x)); });
      es.addEventListener('packet', (m) => { const p = JSON.parse((m as MessageEvent).data) as Packet; packetFns.current.forEach((f) => f(p)); });
      for (const k of ['ledger', 'passport', 'batch', 'cluster', 'ems.decision', 'reset', 'event', 'document']) {
        es.addEventListener(k, (m) => {
          const data = JSON.parse((m as MessageEvent).data);
          eventFns.current.get(k)?.forEach((f) => f(data));
          if (k === 'ledger') inval('workspace');
          if (k === 'passport') inval('passports');
          if (k === 'batch') inval('fmcg');
          if (k === 'cluster') inval('cluster');
          if (k === 'document') { qc.invalidateQueries({ queryKey: ['documents'] }); const d = data as { by?: string; kindLabel?: string }; if (d.by && d.by !== s.me?.name) notify(`New photo from ${d.by}: ${d.kindLabel?.toLowerCase()}`); }
          if (k === 'reset') { qc.invalidateQueries(); notify('Demo data was reset'); }
        });
      }
    };
    open();
    return () => { es?.close(); if (timer) window.clearTimeout(timer); };
  }, [role, qc, notify]);

  const subscribe = useCallback((fn: (p: Packet) => void) => { packetFns.current.add(fn); return () => { packetFns.current.delete(fn); }; }, []);
  const onEvent = useCallback((kind: string, fn: (d: unknown) => void) => {
    const m = eventFns.current;
    if (!m.has(kind)) m.set(kind, new Set());
    m.get(kind)!.add(fn);
    return () => { m.get(kind)!.delete(fn); };
  }, []);

  const passports = pq.data?.passports ?? [];
  const engine = useMemo(() => (snap ? toEngine(snap, passports, subscribe, {
    resolve: (id, action, value) => actions.decideHeld(id, action, value),
    setEms: (patch) => { api('/energy/settings', { method: 'PUT', body: patch }).then(() => notify('EMS settings saved')).catch((e: Error) => notify(e.message)); },
  }) : null), [snap, passports, subscribe, actions, notify]);

  const value: Ctx = { engine, connected, error, passports, hiddenOtherOems: pq.data?.hiddenOtherOems ?? 0, control: { clock: snap?.clock ?? Date.now(), ems: { cloud: (snap?.ems.cloud ?? 0) > 0 } }, onEvent };
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

export function useSim(): Ctx {
  const v = useContext(LiveCtx);
  if (!v) throw new Error('LiveProvider missing');
  return v;
}
export const useLive = useSim;
