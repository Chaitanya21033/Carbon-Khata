// Cluster symbiosis model (Kalundborg-style), all dummy data.
// Three layers run on the same simulated clock as the plant:
//  1. Energy pool: members buy through one licensed trader, one schedule, one deviation account.
//  2. Resource exchange: one plant's output is another's input, metered on both sides.
//  3. Shared scoreboard + benefit split, with each tonne of CO2 owned exactly once.


export type FlowKind = 'power' | 'heat' | 'material' | 'water' | 'waste';
export const FLOW_COLOR: Record<FlowKind, string> = { power: '#F2A900', heat: '#E8743B', material: '#4C9BE8', water: '#2EC4B6', waste: '#8A6FD1' };
export const FLOW_LABEL: Record<FlowKind, string> = { power: 'Power', heat: 'Heat', material: 'Materials', water: 'Water', waste: 'Waste to resource' };

export interface Member {
  id: string; name: string; type: string; kw: number; shape: 'day' | 'flat' | 'two' | 'night' | 'paint';
  err: number; x: number; y: number; you?: boolean; late?: boolean;
}
export const MEMBERS: Member[] = [
  { id: 'vbw', name: 'Vardhan Body Works', type: 'Tipper bodies (fabrication)', kw: 380, shape: 'day', err: 0.07, x: 110, y: 90, you: true },
  { id: 'fab2', name: 'Kiran Fabricators', type: 'Chassis brackets', kw: 260, shape: 'day', err: 0.09, x: 110, y: 280 },
  { id: 'fab3', name: 'Shakti Engineering', type: 'Trailer frames', kw: 310, shape: 'day', err: 0.09, x: 110, y: 470 },
  { id: 'fdy', name: 'Subarnarekha Castings', type: 'Grey-iron foundry', kw: 1450, shape: 'flat', err: 0.05, x: 470, y: 280 },
  { id: 'frg', name: 'Dalma Forgings', type: 'Closed-die forge', kw: 920, shape: 'two', err: 0.06, x: 470, y: 90 },
  { id: 'pnt', name: 'Coatwell Finishers', type: 'Job-work paint shop', kw: 240, shape: 'paint', err: 0.1, x: 650, y: 90 },
  { id: 'cem', name: 'Kolhan Cement Grinding', type: 'Slag-cement grinding unit', kw: 1800, shape: 'night', err: 0.05, x: 650, y: 280 },
  { id: 'fm1', name: 'Annapurna Foods', type: 'FMCG co-packer (snacks)', kw: 520, shape: 'two', err: 0.07, x: 650, y: 470 },
  { id: 'fm2', name: 'Swarnrekha Beverages', type: 'FMCG co-packer (drinks)', kw: 430, shape: 'two', err: 0.08, x: 290, y: 470 },
  { id: 'etp', name: 'Cluster CETP', type: 'Common effluent plant', kw: 140, shape: 'flat', err: 0.04, x: 470, y: 470 },
  { id: 'scr', name: 'Green Metal Recyclers', type: 'Scrap sorting & baling', kw: 190, shape: 'day', err: 0.1, x: 290, y: 280 },
  { id: 'sol', name: 'Cluster solar park', type: 'Group-captive 3 MWp + 2 MWh battery', kw: 0, shape: 'flat', err: 0, x: 830, y: 90 },
  { id: 'tool', name: 'Precision Tool Room', type: 'Tool & die (joining)', kw: 160, shape: 'day', err: 0.1, x: 290, y: 90, late: true },
];
export const POOL_NODE = { x: 830, y: 280 };
export const OA_THRESHOLD_KW = 1000; // open access usually needs ≥1 MW contract demand (state rules vary)
export const TRADER_MARGIN = 0.04;   // ₹/kWh, licensed trader fee
export const DSM_TOL = 0.02;         // ±2% of schedule free
export const DSM_RATE = 2.5;           // ₹/kWh beyond the band (illustrative)
export const HEDGE_SHARE = 0.6;      // share of base load on a term contract
export const HEDGE_RATE = 4.9;       // ₹/kWh term price before OA charges
export const SOLAR_KWP = 3000;
export const SOLAR_TARIFF = 3.3;     // ₹/kWh, group-captive capex + O&M recovery
export const FY_START = Date.UTC(2026, 3, 1);

export interface Exchange {
  id: string; from: string; to: string[]; kind: FlowKind; what: string; qty: number; unit: string; // per month
  inrPerMonth: number; tco2PerMonth: number; m3PerMonth?: number; mwhPerMonth?: number; tMatPerMonth?: number;
  claim: 'receiver' | 'sender' | 'split' | 'consumption'; claimNote: string; senderShare: number; // ₹ gain-sharing
  chain?: boolean;
}
export const BASE_EXCHANGES: Exchange[] = [
  { id: 'x-scrap', from: 'vbw', to: ['fdy'], kind: 'material', what: 'Steel off-cuts and skeleton scrap', qty: 34, unit: 't', inrPerMonth: 238000, tco2PerMonth: 51, tMatPerMonth: 34, claim: 'receiver', claimNote: 'Foundry counts lower-carbon charge mix (Scope 3, purchased goods)', senderShare: 0.5 },
  { id: 'x-scrap2', from: 'fab2', to: ['scr', 'fdy'], kind: 'material', what: 'Mixed steel scrap via baler', qty: 22, unit: 't', inrPerMonth: 132000, tco2PerMonth: 33, tMatPerMonth: 22, claim: 'receiver', claimNote: 'Foundry counts lower-carbon charge mix', senderShare: 0.5, chain: true },
  { id: 'x-heat', from: 'frg', to: ['pnt'], kind: 'heat', what: 'Furnace exhaust heat to oven pre-heat', qty: 42, unit: 'MWh-th', inrPerMonth: 221000, tco2PerMonth: 8.1, mwhPerMonth: 42, claim: 'receiver', claimNote: 'Paint shop burns less PNG: its own Scope 1 falls, nothing to transfer', senderShare: 0.4 },
  { id: 'x-sludge', from: 'pnt', to: ['cem'], kind: 'waste', what: 'Paint sludge co-processed as kiln fuel', qty: 4.5, unit: 't', inrPerMonth: 27000, tco2PerMonth: 4.9, tMatPerMonth: 4.5, claim: 'receiver', claimNote: 'Cement unit counts the fossil fuel it displaced', senderShare: 0.6 },
  { id: 'x-water', from: 'etp', to: ['fdy', 'cem'], kind: 'water', what: 'Treated water for cooling and dust suppression', qty: 2600, unit: 'm³', inrPerMonth: 70000, tco2PerMonth: 0.6, m3PerMonth: 2600, claim: 'split', claimNote: 'Small pumping saving, split by volume taken', senderShare: 0.5 },
  { id: 'x-slag', from: 'fdy', to: ['cem'], kind: 'material', what: 'Foundry slag as blending material (trial)', qty: 55, unit: 't', inrPerMonth: 44000, tco2PerMonth: 13.8, tMatPerMonth: 55, claim: 'receiver', claimNote: 'Cement unit counts clinker it did not need', senderShare: 0.5 },
  { id: 'x-pallet', from: 'fm1', to: ['fab3'], kind: 'material', what: 'Wooden pallets and crates reused', qty: 900, unit: 'pcs', inrPerMonth: 54000, tco2PerMonth: 2.2, tMatPerMonth: 9, claim: 'sender', claimNote: 'Co-packer reports waste diverted; receivers claim nothing', senderShare: 0.5 },
  { id: 'x-solar', from: 'sol', to: ['vbw', 'fab2', 'fab3', 'fdy', 'frg', 'pnt', 'fm1', 'fm2', 'etp', 'scr'], kind: 'power', what: 'Group-captive solar, shared by consumption', qty: 360, unit: 'MWh', inrPerMonth: 720000, tco2PerMonth: 256, mwhPerMonth: 360, claim: 'consumption', claimNote: 'Each member claims only the kWh it was allocated (market-based Scope 2)', senderShare: 0 },
];
export const PROPOSALS: Exchange[] = [
  { id: 'p-offcut', from: 'fab3', to: ['fdy'], kind: 'material', what: 'Trailer-frame off-cuts (now sold to a kabadi)', qty: 14, unit: 't', inrPerMonth: 98000, tco2PerMonth: 21, tMatPerMonth: 14, claim: 'receiver', claimNote: 'Foundry counts lower-carbon charge mix', senderShare: 0.5 },
  { id: 'p-heat2', from: 'frg', to: ['fm1'], kind: 'heat', what: 'Second exhaust loop to snack dryer', qty: 26, unit: 'MWh-th', inrPerMonth: 137000, tco2PerMonth: 5, mwhPerMonth: 26, claim: 'receiver', claimNote: 'Co-packer burns less PNG in its own Scope 1', senderShare: 0.4 },
  { id: 'p-food', from: 'fm1', to: ['etp'], kind: 'waste', what: 'Food waste to CETP biogas digester', qty: 6, unit: 't', inrPerMonth: 21000, tco2PerMonth: 3.4, tMatPerMonth: 6, claim: 'sender', claimNote: 'Co-packer reports avoided landfill methane', senderShare: 0.5 },
  { id: 'p-water2', from: 'etp', to: ['fm2'], kind: 'water', what: 'Polished water for crate washing', qty: 900, unit: 'm³', inrPerMonth: 24000, tco2PerMonth: 0.2, m3PerMonth: 900, claim: 'split', claimNote: 'Split by volume', senderShare: 0.5 },
];

export const MIN = 60_000;
export type ClusterEvent = 'overdraw' | 'join' | 'scrapShort' | 'heatTrip' | 'mismatch';
export interface LedgerRow { id: string; t: number; exchange: string; what: string; from: string; to: string; sent: number; received: number; unit: string; status: 'reconciled' | 'mismatch' | 'resolved' }
export interface BlockRow { block: number; sched: number; actual: number; indivDev: number; pooledDev: number; indivPen: number; pooledPen: number; pooledCost: number; soloCost: number; solar: number }
export function shapeAt(shape: Member['shape'], h: number) {
  if (shape === 'flat') return 0.88 + 0.06 * Math.sin(h);
  if (shape === 'day') return h >= 8 && h < 20 ? (h >= 13 && h < 14 ? 0.55 : 0.92) : 0.16;
  if (shape === 'two') return h >= 6 && h < 22 ? 0.9 : 0.22;
  if (shape === 'paint') return h >= 9 && h < 18 ? 0.95 : 0.12;
  return h >= 22 || h < 6 ? 0.95 : h >= 18 ? 0.25 : 0.6;
}
export function solarKw(h: number, cloud: boolean) { const s = h > 6 && h < 18 ? Math.sin(((h - 6) / 12) * Math.PI) : 0; return SOLAR_KWP * 0.82 * s * (cloud ? 0.35 : 1); }

// ---------------- API-backed cluster view (replaces the in-browser ClusterSim) ----------------
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { MarketBlock } from './grid';

type Row = BlockRow & { readings: Record<string, [number, number]> };
type XView = Exchange & { active: boolean; paused: boolean; status: string };
interface Data {
  members: (Member & { active: boolean })[]; rows: Row[]; market: MarketBlock[]; exchanges: XView[]; proposals: XView[];
  ledger: LedgerRow[]; feed: { t: number; tone: 'ok' | 'warn' | 'bad' | 'info'; text: string }[];
  score: { inr: number; t: number; m3: number; mwh: number; tMat: number; poolInr: number; penAvoided: number };
  split: { rows: { id: string; inr: number; senderInr: number; receiverInr: number; tco2: number; claim: string; claimOwners: string[]; claimPerOwner: number }[]; totalClaimed: number; totalAvoided: number } | null;
}
const EMPTY: Data = { members: MEMBERS.map((m) => ({ ...m, active: !m.late })), rows: [], market: [], exchanges: [], proposals: [], ledger: [], feed: [], score: { inr: 0, t: 0, m3: 0, mwh: 0, tMat: 0, poolInr: 0, penAvoided: 0 }, split: null };

class ClusterView {
  data: Data = EMPTY;
  version = 0;
  refresh: () => void = () => undefined;
  members() { return this.data.members.filter((m) => m.active); }
  exchanges() { return this.data.exchanges; }
  proposals() { return this.data.proposals; }
  isPaused(x: Exchange, _clock?: number) { return !!(x as XView).paused; }
  get feed() { return this.data.feed; }
  get ledger() { return this.data.ledger; }
  get acc() { return this.data.score; }
  get joined() { return this.data.members.some((m) => m.id === 'tool' && m.active); }
  day(_clock?: number, _cloud?: boolean, _spike?: boolean) { return { rows: this.data.rows, market: this.data.market }; }
  /** Metered kW of a member in the block containing t (schedule or actual), from the pool feed. */
  load(m: Member, t: number, actual: boolean) {
    const b = Math.floor((t % 86_400_000) / 900_000);
    const r = this.data.rows[Math.min(b, this.data.rows.length - 1)];
    const v = r?.readings?.[m.id];
    return v ? v[actual ? 1 : 0] : 0;
  }
  accept(id: string, _clock?: number) { api(`/cluster/exchanges/${id}/agree`, { method: 'POST' }).then(this.refresh); }
  resolve(id: string) { api(`/cluster/exchange-lines/${id}/confirm`, { method: 'POST' }).then(this.refresh); }
  setSplit(id: string, v: number) { api(`/cluster/exchanges/${id}/split`, { method: 'PUT', body: { senderShare: v } }).then(this.refresh); }
  setClaim(id: string, c: Exchange['claim']) { api(`/cluster/exchanges/${id}/split`, { method: 'PUT', body: { claim: c } }).then(this.refresh); }
}
export const cluster = new ClusterView();

/** Loads the cluster from the API into the shared view. Returns loading / error for the screen's states. */
export function useClusterData(enabled = true) {
  const qc = useQueryClient();
  const opt = { enabled, staleTime: 4_000, refetchInterval: 20_000 };
  const members = useQuery({ queryKey: ['cluster', 'members'], queryFn: () => api<{ members: Data['members'] }>('/cluster/members'), ...opt });
  const pool = useQuery({ queryKey: ['cluster', 'pool'], queryFn: () => api<{ rows: Row[]; market: MarketBlock[] }>('/cluster/pool/today'), ...opt });
  const ex = useQuery({ queryKey: ['cluster', 'ex'], queryFn: () => api<{ exchanges: XView[]; proposals: XView[]; ledger: LedgerRow[]; feed: Data['feed'] }>('/cluster/exchanges'), ...opt });
  const score = useQuery({ queryKey: ['cluster', 'score'], queryFn: () => api<Data['score']>('/cluster/scoreboard'), ...opt });
  const split = useQuery({ queryKey: ['cluster', 'split'], queryFn: () => api<NonNullable<Data['split']>>('/cluster/split'), ...opt });
  cluster.refresh = () => { qc.invalidateQueries({ queryKey: ['cluster'] }); };
  if (members.data && pool.data && ex.data && score.data) {
    cluster.data = { members: members.data.members, rows: pool.data.rows, market: pool.data.market, exchanges: ex.data.exchanges, proposals: ex.data.proposals, ledger: ex.data.ledger, feed: ex.data.feed, score: score.data, split: split.data ?? null };
    cluster.version++;
  }
  const qs = [members, pool, ex, score];
  return { loading: qs.some((q) => q.isLoading), error: (qs.find((q) => q.error)?.error as Error | undefined)?.message ?? null };
}
