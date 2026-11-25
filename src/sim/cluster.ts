// Cluster symbiosis model (Kalundborg-style), all dummy data.
// Three layers run on the same simulated clock as the plant:
//  1. Energy pool: members buy through one licensed trader, one schedule, one deviation account.
//  2. Resource exchange: one plant's output is another's input, metered on both sides.
//  3. Shared scoreboard + benefit split, with each tonne of CO2 owned exactly once.
import { BLOCKS, OA_ADDER, discomTod, marketDay, type MarketBlock } from './grid';

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
const DAY = 86_400_000;

function hash(...n: number[]) { let h = 2166136261; for (const v of n) { h ^= Math.floor(v * 1000) >>> 0; h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }
function gauss(...n: number[]) { const u = hash(...n) || 1e-5, v = hash(...n, 7); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export function shapeAt(shape: Member['shape'], h: number) {
  if (shape === 'flat') return 0.88 + 0.06 * Math.sin(h);
  if (shape === 'day') return h >= 8 && h < 20 ? (h >= 13 && h < 14 ? 0.55 : 0.92) : 0.16;
  if (shape === 'two') return h >= 6 && h < 22 ? 0.9 : 0.22;
  if (shape === 'paint') return h >= 9 && h < 18 ? 0.95 : 0.12;
  return h >= 22 || h < 6 ? 0.95 : h >= 18 ? 0.25 : 0.6; // night: grinding pushed off-peak
}
export function solarKw(h: number, cloud: boolean) { const s = h > 6 && h < 18 ? Math.sin(((h - 6) / 12) * Math.PI) : 0; return SOLAR_KWP * 0.82 * s * (cloud ? 0.35 : 1); }

export type ClusterEvent = 'overdraw' | 'join' | 'scrapShort' | 'heatTrip' | 'mismatch';
export interface LedgerRow { id: string; t: number; exchange: string; what: string; from: string; to: string; sent: number; received: number; unit: string; status: 'reconciled' | 'mismatch' | 'resolved' }
export interface BlockRow { block: number; sched: number; actual: number; indivDev: number; pooledDev: number; indivPen: number; pooledPen: number; pooledCost: number; soloCost: number; solar: number }

interface Persist { accepted: string[]; joined: boolean; splits: Record<string, number>; claims: Record<string, Exchange['claim']>; ledger: LedgerRow[]; acc: Acc; last: number | null; scrapAsk: boolean }
interface Acc { inr: number; t: number; m3: number; mwh: number; tMat: number; poolInr: number; penAvoided: number }
const KEY = 'ck2_cluster_v1';
const zeroAcc = (): Acc => ({ inr: 0, t: 0, m3: 0, mwh: 0, tMat: 0, poolInr: 0, penAvoided: 0 });

class ClusterSim {
  accepted: string[] = [];
  joined = false;
  splits: Record<string, number> = {};
  claims: Record<string, Exchange['claim']> = {};
  ledger: LedgerRow[] = [];
  acc: Acc = zeroAcc();
  last: number | null = null;
  scrapAsk = false;
  overdrawUntil = 0;
  heatTripUntil = 0;
  feed: { t: number; tone: 'ok' | 'warn' | 'bad' | 'info'; text: string }[] = [];
  private listeners = new Set<() => void>();
  version = 0;

  constructor() { this.restore(); }
  restore() {
    try { const raw = localStorage.getItem(KEY); if (raw) Object.assign(this, JSON.parse(raw) as Persist); } catch { /* fresh */ }
  }
  save() {
    const p: Persist = { accepted: this.accepted, joined: this.joined, splits: this.splits, claims: this.claims, ledger: this.ledger.slice(0, 60), acc: this.acc, last: this.last, scrapAsk: this.scrapAsk };
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
  }
  reset() { Object.assign(this, { accepted: [], joined: false, splits: {}, claims: {}, ledger: [], acc: zeroAcc(), last: null, scrapAsk: false, overdrawUntil: 0, heatTripUntil: 0, feed: [] }); try { localStorage.removeItem(KEY); } catch { /* ignore */ } this.bump(); }
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  getVersion = () => this.version;
  private bump() { this.version++; this.listeners.forEach((f) => f()); }
  note(t: number, tone: 'ok' | 'warn' | 'bad' | 'info', text: string) { this.feed = [{ t, tone, text }, ...this.feed].slice(0, 30); }

  members() { return MEMBERS.filter((m) => !m.late || this.joined); }
  exchanges(): (Exchange & { active: boolean; paused: boolean; proposed?: boolean })[] {
    const live = [...BASE_EXCHANGES, ...PROPOSALS.filter((p) => this.accepted.includes(p.id))].map((x) => ({ ...x, senderShare: this.splits[x.id] ?? x.senderShare, claim: this.claims[x.id] ?? x.claim }));
    return live.map((x) => ({ ...x, active: true, paused: false }));
  }
  proposals() { return PROPOSALS.filter((p) => !this.accepted.includes(p.id) && (p.id !== 'p-offcut' || this.scrapAsk)); }
  isPaused(x: Exchange, clock: number) { return x.kind === 'heat' && clock < this.heatTripUntil; }

  /** Load of one member at a time, with forecast error and events. */
  load(m: Member, t: number, actual: boolean) {
    const h = ((t % DAY) / 3_600_000);
    const base = m.kw * shapeAt(m.shape, h);
    if (!actual) return base;
    const blk = Math.floor((t % DAY) / (15 * MIN));
    const day = Math.floor(t / DAY);
    let v = base * (1 + m.err * gauss(day, blk, m.kw, m.x));
    if (m.id === 'fab3' && t < this.overdrawUntil) v *= 1.45;
    return Math.max(0, v);
  }

  /** Today's pool, block by block up to the current block. */
  day(clock: number, cloud = false, spike = false): { rows: BlockRow[]; market: MarketBlock[] } {
    const day0 = Math.floor(clock / DAY) * DAY;
    const market = marketDay(Math.floor(clock / DAY), cloud ? 0.6 : 0);
    const nowBlk = Math.floor((clock - day0) / (15 * MIN));
    const ms = this.members().filter((m) => m.kw > 0);
    const rows: BlockRow[] = [];
    for (let b = 0; b <= Math.min(nowBlk, BLOCKS - 1); b++) {
      const t = day0 + b * 15 * MIN + 7 * MIN;
      const h = b / 4;
      let sched = 0, actual = 0, indivDev = 0, indivPen = 0, soloCost = 0;
      for (const m of ms) {
        const s = this.load(m, t, false), a = this.load(m, t, true);
        sched += s; actual += a;
        const d = Math.abs(a - s); indivDev += d;
        indivPen += Math.max(0, d - DSM_TOL * s) * 0.25 * DSM_RATE;
        soloCost += a * 0.25 * discomTod(h);
      }
      const sol = solarKw(h, cloud);
      const pooledDev = Math.abs(actual - sched);
      const pooledPen = Math.max(0, pooledDev - DSM_TOL * sched) * 0.25 * DSM_RATE;
      const mb = market[b];
      const rtm = spike && b === nowBlk ? 10 : mb.rtm;
      const net = Math.max(0, actual - sol);
      const hedged = Math.min(net, sched * HEDGE_SHARE);
      const spot = net - hedged;
      const pooledCost = (Math.min(sol, actual) * SOLAR_TARIFF + hedged * (HEDGE_RATE + OA_ADDER.grey + TRADER_MARGIN) + spot * (Math.min(mb.dam, rtm) + OA_ADDER.grey + TRADER_MARGIN)) * 0.25 + pooledPen;
      rows.push({ block: b, sched, actual, indivDev, pooledDev, indivPen, pooledPen, pooledCost, soloCost, solar: sol });
    }
    return { rows, market };
  }

  /** Accrue the year-to-date scoreboard up to `clock`. */
  advance(clock: number) {
    if (this.last === null) {
      // open the year with the exchanges that existed before the demo started
      const months = (clock - FY_START) / (30.4 * DAY);
      for (const x of BASE_EXCHANGES) this.addX(x, months);
      this.acc.poolInr = 4_850_00 * months; this.acc.penAvoided = 61_000 * months;
      this.last = clock; this.save(); this.bump(); return;
    }
    if (clock <= this.last) return;
    const months = (clock - this.last) / (30.4 * DAY);
    for (const x of this.exchanges()) if (!this.isPaused(x, clock)) this.addX(x, months);
    this.acc.poolInr += 4_850_00 * months * (this.joined ? 1.04 : 1);
    this.acc.penAvoided += 61_000 * months;
    // weighbridge lines for material exchanges, roughly one a plant-hour per active stream
    if (Math.floor(clock / 3_600_000) !== Math.floor(this.last / 3_600_000)) {
      const mats = this.exchanges().filter((x) => x.unit === 't');
      const x = mats[Math.floor(clock / 3_600_000) % mats.length];
      const sent = +(x.qty / 30 / 3 * (0.8 + hash(clock) * 0.4)).toFixed(2);
      this.post(clock, x, sent, +(sent * (1 + (hash(clock, 3) - 0.5) * 0.008)).toFixed(2));
    }
    this.last = clock;
    if (Math.floor(clock / MIN) % 30 === 0) this.save();
    this.bump();
  }
  private addX(x: Exchange, months: number) {
    this.acc.inr += x.inrPerMonth * months; this.acc.t += x.tco2PerMonth * months;
    this.acc.m3 += (x.m3PerMonth ?? 0) * months; this.acc.mwh += (x.mwhPerMonth ?? 0) * months; this.acc.tMat += (x.tMatPerMonth ?? 0) * months;
  }
  post(clock: number, x: Exchange, sent: number, received: number) {
    const diff = Math.abs(received - sent) / Math.max(sent, 0.001);
    const row: LedgerRow = { id: `cx-${clock}-${x.id}`, t: clock, exchange: x.id, what: x.what, from: x.from, to: x.to[0], sent, received, unit: x.unit, status: diff > 0.02 ? 'mismatch' : 'reconciled' };
    this.ledger = [row, ...this.ledger].slice(0, 60);
    if (row.status === 'mismatch') this.note(clock, 'bad', `Weighbridge mismatch on ${x.what.toLowerCase()}: sent ${sent} t, received ${received} t. Held until both sides confirm.`);
  }
  resolve(id: string) { this.ledger = this.ledger.map((r) => (r.id === id ? { ...r, status: 'resolved', received: r.sent } : r)); this.save(); this.bump(); }

  accept(id: string, clock: number) {
    if (this.accepted.includes(id)) return;
    this.accepted = [...this.accepted, id];
    const p = PROPOSALS.find((x) => x.id === id)!;
    this.note(clock, 'ok', `Exchange agreed: ${p.what}. Both plants' registers now carry a paired dispatch and receipt line.`);
    this.post(clock, p, +(p.qty / 30).toFixed(2), +(p.qty / 30).toFixed(2));
    this.save(); this.bump();
  }
  setSplit(id: string, v: number) { this.splits = { ...this.splits, [id]: v }; this.save(); this.bump(); }
  setClaim(id: string, c: Exchange['claim']) { this.claims = { ...this.claims, [id]: c }; this.save(); this.bump(); }

  inject(ev: ClusterEvent, clock: number) {
    if (ev === 'overdraw') { this.overdrawUntil = clock + 120 * MIN; this.note(clock, 'warn', 'Shakti Engineering is drawing 45% above its schedule (unplanned second shift). The pool absorbs it against members running under.'); }
    if (ev === 'join') { this.joined = !this.joined; this.note(clock, this.joined ? 'ok' : 'info', this.joined ? 'Precision Tool Room joined (160 kW). Too small for open access alone; it buys through the pool from the next block.' : 'Precision Tool Room left the pool.'); }
    if (ev === 'scrapShort') { this.scrapAsk = true; this.note(clock, 'warn', 'Subarnarekha Castings posted a need: 14 t/month more steel scrap. One match found inside the cluster.'); }
    if (ev === 'heatTrip') { this.heatTripUntil = clock < this.heatTripUntil ? 0 : clock + 180 * MIN; this.note(clock, this.heatTripUntil ? 'bad' : 'ok', this.heatTripUntil ? 'Heat exchanger at Dalma Forgings tripped. Heat flows paused; the paint shop falls back to its PNG burner.' : 'Heat exchanger back in service.'); }
    if (ev === 'mismatch') { const x = BASE_EXCHANGES[0]; this.post(clock, x, 1.24, 1.09); }
    this.save(); this.bump();
  }
}

export const cluster = new ClusterSim();
