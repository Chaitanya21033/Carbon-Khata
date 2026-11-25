// Real-time plant simulator. Generates meter telemetry, shop-floor entries and production
// for the fictional demo plant, runs packet-level checks, and posts clean data to the ledger.
import { rng } from '../domain/synth';
import { CEA_EF, Ems, GENSET_EF, landed } from './grid';

export type DeviceId = 'meters' | 'stores' | 'line' | 'paint' | 'docs' | 'grid';
export type PacketKind = 'meter' | 'entry' | 'production' | 'rollup' | 'export' | 'resolve' | 'market' | 'passport' | 'credit';
export interface Packet { id: string; t: number; device: DeviceId; kind: PacketKind; registerId?: string; qty?: number; label: string; flagged?: { rule: string; reason: string }; delay?: number; target?: 'out_dash' | 'out_oem' | 'out_bank' | 'out_reg' }
export interface SimEvent { id: number; t: number; level: 'info' | 'ok' | 'warn' | 'block' | 'flow'; text: string }
export interface Quarantined { id: string; t: number; device: DeviceId; registerId: string; line: 'issued' | 'received' | 'reading'; qty: number; suggested?: number; rule: string; reason: string; docRef: string; month: string }
export interface LivePoint { t: number; comp: number; weld: number; paint: number; light: number; util: number; kva: number; dg: number; solar: number; bess: number; genset: number; imp: number; exp: number; price: number }
export type OemId = 'A' | 'B' | 'C';
export const OEMS: Record<OemId, { name: string; sub: string; steelEf: number; steelNote: string }> = {
  A: { name: 'OEM A', sub: 'Commercial vehicles (domestic)', steelEf: 2.3, steelNote: 'BF-BOF steel, India average' },
  B: { name: 'OEM B', sub: 'Construction equipment', steelEf: 2.3, steelNote: 'BF-BOF steel, India average' },
  C: { name: 'OEM C', sub: 'Export to EU (CBAM)', steelEf: 1.55, steelNote: 'Mill-certified lower-carbon steel' },
};
export interface Token { id: number; station: number; left: number; oem?: OemId; order?: string; kwh?: number; s1?: number; s2?: number; steel?: number; steelKg?: number; started?: number }
export interface Passport { id: number; oem: OemId; order: string; t: number; started: number; kwh: number; s1: number; s2: number; steel: number; steelKg: number; total: number; renewableShare: number }
export interface PostRequest { registerId: string; month: string; line: 'issued' | 'received' | 'reading'; qty: number; docRef: string; by: string; source: 'app' | 'meter'; idempotencyKey: string; reason?: string }

export const STATIONS = [
  { id: 'cut', label: 'Cutting', mins: 45, cap: 2 },
  { id: 'weld', label: 'Welding & fab', mins: 150, cap: 4 },
  { id: 'blast', label: 'Shot blast', mins: 40, cap: 2 },
  { id: 'paint', label: 'Paint & oven', mins: 110, cap: 3 },
  { id: 'qc', label: 'Inspection', mins: 30, cap: 2 },
];
export const METERS = [
  { id: 'comp', label: 'Compressor' },
  { id: 'weld', label: 'Welding bay' },
  { id: 'paint', label: 'Paint shop & oven' },
  { id: 'light', label: 'Lighting' },
  { id: 'util', label: 'Utilities & office' },
] as const;
export const DEVICES: { id: DeviceId; label: string; sub: string }[] = [
  { id: 'meters', label: 'Energy meters', sub: '5 sub-meters, 15-min packets' },
  { id: 'stores', label: 'Stores phone', sub: 'Gas, diesel, steel, oil' },
  { id: 'line', label: 'Line supervisor', sub: 'Bodies finished' },
  { id: 'paint', label: 'Paint-shop phone', sub: 'Paint, thinner, sludge' },
  { id: 'docs', label: 'Bills & invoices', sub: 'Photos, PDFs' },
  { id: 'grid', label: 'IEX feed & EMS', sub: 'Prices + dispatch, 15-min' },
];

/** Usual size of ONE shop-floor entry; a packet 5× bigger is held (live V01). */
const TYPICAL: Record<string, number> = { SOLAR_KWH: 400, GREEN_OA_KWH: 400, GRID_EXPORT_KWH: 400, GENSET_GAS_SCM: 100, GRID_KWH: 900, HR_SHEET: 3200, CO2_GAS: 30, LPG: 19, DIESEL: 40, PAINT: 22, THINNER: 9, HYD_OIL: 30, SCRAP_HR: 1600, SLUDGE: 7, PROD: 1 };
const FULL = new Set(['CO2_GAS', 'LPG', 'HYD_OIL', 'OXYGEN', 'ARGON']);
const EF = { grid: 0.71, diesel: 2.68, lpg: 2.98, co2: 1 };

export type Speed = 1 | 5 | 15 | 60;
export interface EngineOptions { start: number; contractKva: number; post: (r: PostRequest) => boolean; stock: Record<string, number> }

export class SimEngine {
  clock: number;
  running = true;
  speed: Speed = 5;
  contractKva: number;
  version = 0;
  online: Record<DeviceId, boolean> = { meters: true, stores: true, line: true, paint: true, docs: true, grid: true };
  queues: Record<DeviceId, Packet[]> = { meters: [], stores: [], line: [], paint: [], docs: [], grid: [] };
  ems = new Ems();
  passports: Passport[] = [];
  oemToday: Record<OemId, number> = { A: 0, B: 0, C: 0 };
  flexQueue = 0;
  leakUntil = 0;
  machineAlerts: { t: number; machine: string; text: string }[] = [];
  private orderSeq = 0;
  private lastLeakAlert = 0;
  series: LivePoint[] = [];
  events: SimEvent[] = [];
  quarantine: Quarantined[] = [];
  tokens: Token[] = [];
  today = { bodies: 0, kwh: 0, diesel: 0, lpg: 0, co2: 0, peakKva: 0, packets: 0, flagged: 0, posted: 0 };
  totals = { packets: 0, posted: 0, flagged: 0 };
  meterKwh: Record<string, number> = { comp: 0, weld: 0, paint: 0, light: 0, util: 0 };
  meterCum = 4_812_300;
  last: LivePoint = { t: 0, comp: 0, weld: 0, paint: 0, light: 0, util: 0, kva: 0, dg: 0, solar: 0, bess: 0, genset: 0, imp: 0, exp: 0, price: 0 };
  pf = 0.945;
  surgeUntil = 0;
  powerCutUntil = 0;
  dgLitres = 0;
  stock: Record<string, number>;
  private post: EngineOptions['post'];
  private r = rng(4242);
  private acc = 0;
  private seq = 0;
  private evSeq = 0;
  private tokenSeq = 0;
  private hourKwh = 0;
  private blk15 = { kva: 0, n: 0 };
  private co2Pending = 0;
  private lpgPending = 0;
  private hrShift = 0;
  private schedule: { at: number; fn: () => void }[] = [];
  private seen = new Set<string>();
  private lastPosted: PostRequest | null = null;
  private listeners = new Set<() => void>();
  private packetListeners = new Set<(p: Packet) => void>();

  constructor(o: EngineOptions) {
    this.clock = o.start;
    this.contractKva = o.contractKva;
    this.post = o.post;
    this.stock = { ...o.stock };
    // Work in progress carried over from yesterday
    for (const [st, left] of [[1, 40], [1, 110], [2, 20], [3, 60], [3, 95], [4, 10]] as const) this.tokens.push({ id: ++this.tokenSeq, station: st, left });
    this.log('info', 'Simulator started. Shift A begins at 06:00.');
  }

  // ---------- subscription ----------
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  onPacket(fn: (p: Packet) => void) { this.packetListeners.add(fn); return () => { this.packetListeners.delete(fn); }; }
  getVersion = () => this.version;
  private changed() { this.version++; this.listeners.forEach((l) => l()); }

  // ---------- helpers ----------
  get month() { return new Date(this.clock).toISOString().slice(0, 7); }
  get hour() { return new Date(this.clock).getUTCHours(); }
  get minute() { return new Date(this.clock).getUTCMinutes(); }
  get sunday() { return new Date(this.clock).getUTCDay() === 0; }
  get shift() { const h = this.hour; return h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'C'; }
  get kw() { const l = this.last; return l.comp + l.weld + l.paint + l.light + l.util; }
  get kgToday() { return this.ems.today.kgMarket + this.today.diesel * EF.diesel + this.today.lpg * EF.lpg + this.today.co2 * EF.co2; }
  get block() { return this.hour * 4 + Math.floor(this.minute / 15); }
  get dayIndex() { return Math.floor(this.clock / 864e5); }
  get market() { this.ems.ensureDay(this.dayIndex); return this.ems.current(this.block); }
  private stamp() { const d = new Date(this.clock); return `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`; }
  private log(level: SimEvent['level'], text: string) {
    this.events.unshift({ id: ++this.evSeq, t: this.clock, level, text });
    if (this.events.length > 120) this.events.length = 120;
  }
  private send(p: Packet) { if (this.online[p.device]) this.emit(p); }
  private emit(p: Packet) { this.totals.packets++; this.today.packets++; this.packetListeners.forEach((l) => l(p)); }

  // ---------- time ----------
  tick(realMs: number) {
    if (!this.running) return;
    this.acc += (realMs / 1000) * this.speed;
    let n = Math.floor(this.acc);
    this.acc -= n;
    n = Math.min(n, 120);
    for (let i = 0; i < n; i++) this.step();
    if (n) this.changed();
  }

  /** Advance one simulated minute. */
  step() {
    this.clock += 60_000;
    const h = this.hour, m = this.minute;
    // scheduled actions (scenarios)
    const due = this.schedule.filter((s) => s.at <= this.clock);
    if (due.length) { this.schedule = this.schedule.filter((s) => s.at > this.clock); due.forEach((s) => s.fn()); }

    // ----- activity level -----
    let act = this.shift === 'A' ? 1 : this.shift === 'B' ? 0.9 : 0.08;
    if ((h === 12 && m < 30) || (h === 19 && m < 30)) act *= 0.45;
    if (this.sunday) act = 0.04;
    if (this.shift !== 'C' && !this.sunday && this.clock > this.surgeUntil && this.r.next() < 1 / 260) {
      this.surgeUntil = this.clock + 15 * 60_000;
      this.log('info', 'Paint oven heat-up and full welding bay: load rising.');
    }
    const surge = this.clock < this.surgeUntil ? 1 : 0;
    if (this.ems.spikeUntil && this.clock > this.ems.spikeUntil) this.ems.spikeUntil = 0;
    if (this.ems.stressEventUntil && this.clock > this.ems.stressEventUntil) { this.ems.stressEventUntil = 0; this.log('ok', 'Demand-response event over. Normal dispatch resumed.'); }
    const painting = this.tokens.some((t) => t.station === 3);

    // ----- loads (kW) -----
    const n = (sd: number) => this.r.normal(sd);
    const cut = this.clock < this.powerCutUntil;
    let comp = (act > 0.3 ? 60 : 38) + 8 * Math.sin((2 * Math.PI * m) / 12) + n(2) + (this.clock < this.leakUntil ? 24 : 0);
    let weld = 14 + 115 * act * (0.85 + 0.3 * this.r.next()) + surge * 80;
    let paint = (painting && act > 0.3 ? 60 + n(4) : 7) + surge * 85;
    let light = h < 6 || h >= 18 ? 34 : 20;
    let util = 28 + n(2);
    let dg = 0;
    if (cut) { const crit = 0.45; comp *= crit; weld = 0; paint = 0; light *= crit; util *= crit; }
    this.pf = Math.min(0.99, Math.max(0.9, this.pf + n(0.002) + (0.945 - this.pf) * 0.05));
    const baseKw = Math.max(0, comp) + Math.max(0, weld) + Math.max(0, paint) + light + util;

    // ----- energy management: market, solar, battery, genset, flexible loads -----
    this.ems.ensureDay(this.dayIndex);
    const blk = this.block;
    const working = act > 0.3;
    const flexGen = working ? 32 : 0; // shot-blast batches, forklift charging, oven pre-heat (kW-equivalent)
    this.flexQueue += flexGen / 60;
    this.ems.naiveFlexNow = flexGen;
    if (this.ems.plan.block !== blk) {
      if (this.ems.plan.block >= 0) this.ems.closeBlock(this.clock, this.ems.plan.block);
      const reason = this.ems.decide(this.clock, blk, baseKw + (this.flexQueue > 1 ? this.ems.flex.runKw : 0), this.flexQueue, working, cut);
      this.ems.plan.block = blk;
      const mb = this.ems.current(blk);
      this.send({ id: this.pid(), t: this.clock, device: 'grid', kind: 'market', label: `IEX block ${blk + 1}: RTM ₹${mb.rtm.toFixed(2)}` });
      if (this.ems.settings.enabled && (this.ems.plan.export || this.ems.plan.genset || this.ems.plan.bess !== 0 || this.ems.plan.shed > 0)) this.log('flow', `EMS ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}: ${reason}`);
    }
    const f = this.ems.minute(this.clock, blk, baseKw, this.flexQueue, cut);
    this.flexQueue = Math.max(0, this.flexQueue - f.flexRun / 60);
    if (cut) { dg = f.shed; this.dgLitres += dg / 60 / 3.2; }
    const kw = f.load;
    const imp = f.green + f.rtm + f.dam + f.discom;
    const kva = imp / this.pf;
    const mbNow = this.ems.current(blk);
    this.last = { t: this.clock, comp: Math.max(0, comp), weld: Math.max(0, weld), paint: Math.max(0, paint), light, util, kva, dg, solar: f.solar, bess: f.bessOut - f.bessIn, genset: f.genset, imp, exp: f.export, price: mbNow.rtm };
    this.series.push(this.last);
    if (this.series.length > 240) this.series.shift();

    // ----- per-body carbon attribution (each body carries its own energy and emissions) -----
    this.attribute(f, imp, working);

    // ----- machine health: compressor idle draw vs benchmark -----
    if (!working && comp > 50 && this.clock - this.lastLeakAlert > 3 * 3600_000) {
      this.lastLeakAlert = this.clock;
      const lossKw = comp - 38;
      const msg = `Compressor idle draw ${comp.toFixed(0)} kW vs 38 kW benchmark: likely air leak, ≈${lossKw.toFixed(0)} kW wasted (₹${Math.round(lossKw * 24 * 6.5).toLocaleString('en-IN')}/day).`;
      this.machineAlerts.unshift({ t: this.clock, machine: 'Compressor', text: msg });
      this.log('warn', msg);
    }

    // ----- energy accounting -----
    const kwhMin = kw / 60;
    this.today.kwh += kwhMin;
    this.hourKwh += kwhMin;
    this.meterCum += imp / 60;
    for (const k of ['comp', 'weld', 'paint', 'light', 'util']) this.meterKwh[k] += (this.last as unknown as Record<string, number>)[k] / 60;
    this.blk15.kva += kva; this.blk15.n++;

    if (m % 15 === 0) {
      const avg = this.blk15.kva / Math.max(1, this.blk15.n);
      this.blk15 = { kva: 0, n: 0 };
      this.today.peakKva = Math.max(this.today.peakKva, avg);
      if (avg > this.contractKva) this.log('warn', `V06 demand alert: ${avg.toFixed(0)} kVA in the last 15 min, above the ${this.contractKva} kVA contract. Stagger the oven or compressor.`);
      if (!cut || true) METERS.forEach((mt, i) => this.send({ id: this.pid(), t: this.clock, device: 'meters', kind: 'meter', label: `${mt.label} ${((this.last as unknown as Record<string, number>)[mt.id]).toFixed(0)} kW`, delay: i * 90 }));
    }
    if (m === 0) {
      this.hourKwh = 0;
      const hr = this.ems.takeHour();
      const roll = (reg: string, qty: number, label: string, dev: DeviceId = 'meters') => { const q = Math.round(qty); if (q > 0) this.postReq({ registerId: reg, month: this.month, line: 'reading', qty: q, docRef: `${reg}-${this.stamp()}`, by: dev === 'grid' ? 'EMS gateway' : 'Meter gateway', source: 'meter', idempotencyKey: `mtr-${reg}-${this.clock}` }, dev, 'rollup', label, true); };
      roll('GRID_KWH', hr.grid, `Hourly grid import ${Math.round(hr.grid)} kWh`);
      roll('SOLAR_KWH', hr.solar, `Hourly solar ${Math.round(hr.solar)} kWh`, 'grid');
      roll('GREEN_OA_KWH', hr.green, `Hourly green open access ${Math.round(hr.green)} kWh`, 'grid');
      roll('GRID_EXPORT_KWH', hr.export, `Hourly export ${Math.round(hr.export)} kWh`, 'grid');
      roll('GENSET_GAS_SCM', hr.gasScm, `Hourly genset gas ${Math.round(hr.gasScm)} scm`, 'grid');
    }
    if (!cut && this.powerCutWasOn) { this.powerCutWasOn = false; this.afterPowerCut(); }
    if (cut) this.powerCutWasOn = true;

    // ----- production line -----
    this.stepLine(act);

    // ----- consumables tied to activity -----
    if (act > 0.3 && painting) this.lpgPending += 0.06;
    if (this.lpgPending >= 19) { this.lpgPending -= 19; this.entry('stores', 'LPG', 'issued', 19, 'LPG cylinder to paint oven'); }
    if (this.co2Pending >= 30) { this.co2Pending -= 30; this.entry('stores', 'CO2_GAS', 'issued', 30, 'CO₂ cylinder to welding bay'); }
    if (!this.sunday) {
      if ((h === 8 || h === 16) && m === 5) this.entry('stores', 'DIESEL', 'issued', 40, 'Diesel to forklift');
      if (h === 10 && m === 20) this.entry('stores', 'HYD_OIL', 'issued', 30, 'Hydraulic oil top-up, press brake');
      if ((h === 14 || h === 22) && m === 0 && this.hrShift > 0) { this.entry('stores', 'SCRAP_HR', 'issued', Math.round(this.hrShift * 0.032), 'Shift scrap weighed'); this.hrShift = 0; }
      if (h === 11 && m === 0) {
        if ((this.stock.CO2_GAS ?? 0) < 600) this.entry('stores', 'CO2_GAS', 'received', 1500, 'CO₂ delivery: 50 cylinders');
        if ((this.stock.LPG ?? 0) < 80) this.entry('stores', 'LPG', 'received', 380, 'LPG delivery: 20 cylinders');
      }
      if (h === 17 && m === 40) this.entry('paint', 'SLUDGE', 'issued', 7 + this.r.int(0, 3), 'Paint sludge drum to authorised vendor');
    }
    if (h === 23 && m === 0) { this.send({ id: this.pid(), t: this.clock, device: 'meters', kind: 'export', label: 'Nightly OEM sync', target: 'out_oem' }); this.log('flow', 'Nightly sync: today\'s summary sent to the OEM portal (consented fields only).'); }
    if (h === 2 && m === 0) this.log('info', 'Nightly validation run: V01–V12 re-checked on full history.');
    if (h === 0 && m === 0) this.rollDay();
    if (m === 0 && [6, 14, 22].includes(h)) this.log('info', `Shift ${this.shift} started.`);
  }
  private powerCutWasOn = false;

  private stepLine(act: number) {
    const working = act > 0.3;
    if (working) {
      for (const t of this.tokens) t.left -= act;
      // move finished tokens forward, last station first
      for (let s = STATIONS.length - 1; s >= 0; s--) {
        for (const t of this.tokens.filter((x) => x.station === s && x.left <= 0)) {
          if (s === STATIONS.length - 1) {
            this.tokens = this.tokens.filter((x) => x !== t);
            this.today.bodies++;
            this.entry('line', 'PROD', 'reading', 1, `Body #${t.id} passed inspection`, 'production');
            this.issuePassport(t);
          } else if (this.tokens.filter((x) => x.station === s + 1).length < STATIONS[s + 1].cap) {
            t.station = s + 1; t.left = STATIONS[s + 1].mins * (0.85 + 0.3 * this.r.next());
            if (s + 1 === 2) { this.co2Pending += 21; t.s1 = (t.s1 ?? 0) + 21; } // welding done: CO₂ shielding gas
            if (s + 1 === 3) t.s1 = (t.s1 ?? 0) + 2.2 * 2.98; // paint oven LPG
            if (s + 1 === 4) { this.entry('paint', 'PAINT', 'issued', 22, `Paint for body #${t.id}`); if (t.id % 2 === 0) this.entry('paint', 'THINNER', 'issued', 18, 'Thinner, 2 bodies'); }
          }
        }
      }
      // new body enters cutting about once an hour
      if (this.tokens.filter((x) => x.station === 0).length < STATIONS[0].cap && this.r.next() < 1 / 55) {
        const oem: OemId = (['A', 'A', 'B', 'A', 'C', 'B', 'A', 'C', 'A', 'B'] as OemId[])[this.tokenSeq % 10];
        const steelKg = 3200 + this.r.int(-150, 150);
        const t: Token = { id: ++this.tokenSeq, station: 0, left: STATIONS[0].mins, oem, order: `PO-${oem}-${String(4100 + Math.floor(this.tokenSeq / 4)).padStart(4, '0')}`, kwh: 0, s1: 0, s2: 0, steelKg, steel: steelKg / 1000 * OEMS[oem].steelEf * 1000, started: this.clock };
        this.tokens.push(t);
        this.hrShift += 3200;
        this.entry('stores', 'HR_SHEET', 'issued', steelKg, `Steel sheet for body #${t.id} (${OEMS[oem].name}, ${OEMS[oem].steelNote})`);
      }
    }
  }

  private rnShare = { re: 0, tot: 0 };
  private attribute(f: { solar: number; bessOut: number; genset: number; green: number; rtm: number; dam: number; discom: number; load: number; flexRun: number }, imp: number, working: boolean) {
    if (!working || !this.tokens.length) return;
    const l = this.last;
    const supply = Math.max(1, f.load);
    const gridShare = Math.min(1, (imp - f.green) / supply);
    const genShare = Math.min(1, f.genset / supply);
    const reShare = Math.max(0, 1 - gridShare - genShare);
    this.rnShare.re += reShare; this.rnShare.tot += 1;
    const give = (ts: Token[], kw: number) => {
      if (!ts.length || kw <= 0) return;
      const each = kw / ts.length / 60;
      for (const t of ts) { t.kwh = (t.kwh ?? 0) + each; t.s2 = (t.s2 ?? 0) + each * gridShare * CEA_EF; t.s1 = (t.s1 ?? 0) + each * genShare * GENSET_EF; (t as Token & { re?: number; e?: number }).re = ((t as Token & { re?: number }).re ?? 0) + each * reShare; }
    };
    const at = (s: number) => this.tokens.filter((t) => t.station === s);
    give(at(0), 18);
    give(at(1), l.weld);
    give(at(2), f.flexRun * 0.6 + 20);
    give(at(3), l.paint);
    give(this.tokens, l.comp + l.light + l.util);
  }

  private issuePassport(t: Token) {
    const kwh = t.kwh ?? 0;
    const re = (t as Token & { re?: number }).re ?? 0;
    const p: Passport = { id: t.id, oem: t.oem ?? 'A', order: t.order ?? 'PO-A-0000', t: this.clock, started: t.started ?? this.clock, kwh, s1: t.s1 ?? 0, s2: t.s2 ?? 0, steel: t.steel ?? 7360, steelKg: t.steelKg ?? 3200, total: (t.s1 ?? 0) + (t.s2 ?? 0) + (t.steel ?? 7360), renewableShare: kwh ? re / kwh : 0 };
    this.passports.unshift(p);
    if (this.passports.length > 300) this.passports.length = 300;
    this.oemToday[p.oem]++;
    this.send({ id: this.pid(), t: this.clock, device: 'line', kind: 'passport', label: `Carbon passport #${t.id} → ${OEMS[p.oem].name}`, target: 'out_oem' });
    this.log('ok', `Body #${t.id} carbon passport → ${OEMS[p.oem].name} (${p.order}): ${(p.s1 + p.s2).toFixed(0)} kg plant + ${(p.steel / 1000).toFixed(2)} t steel, ${(p.renewableShare * 100).toFixed(0)}% renewable power.`);
  }

  private afterPowerCut() {
    const l = Math.max(5, Math.round(this.dgLitres));
    this.dgLitres = 0;
    this.log('ok', `Grid power restored. Solar, battery and gas genset carried critical load; diesel DG covered only the gap (${Math.round(this.dgLitres)} L).`);
    this.entry('stores', 'DIESEL', 'issued', l, `Diesel burned by DG set during power cut`);
  }

  private rollDay() {
    const kg = this.kgToday;
    this.log('ok', `Day closed: ${this.today.bodies} bodies, ${Math.round(this.today.kwh).toLocaleString('en-IN')} kWh, ${(kg / 1000).toFixed(2)} t CO₂e, ${this.today.bodies ? (kg / this.today.bodies).toFixed(0) : '—'} kg per body.`);
    const e = this.ems.rollDay();
    this.log('ok', `EMS day summary: ₹${Math.round(e.naiveInr - e.costInr).toLocaleString('en-IN')} saved vs no optimisation, ${Math.round(e.solar).toLocaleString('en-IN')} kWh solar, ${Math.round(e.exportKwh)} kWh exported, ${Math.round(e.eveningCut)} kWh taken off the evening peak.`);
    this.today = { bodies: 0, kwh: 0, diesel: 0, lpg: 0, co2: 0, peakKva: 0, packets: 0, flagged: 0, posted: 0 };
    this.oemToday = { A: 0, B: 0, C: 0 };
  }

  // ---------- packets & checks ----------
  private pid() { return `p${++this.seq}`; }

  private entry(device: DeviceId, registerId: string, line: 'issued' | 'received' | 'reading', qty: number, label: string, kind: PacketKind = 'entry', forceDoc?: string) {
    const docRef = forceDoc ?? `${registerId}-${this.stamp()}-${this.seq + 1}`;
    const req: PostRequest = { registerId, month: this.month, line, qty, docRef, by: DEVICES.find((d) => d.id === device)!.label, source: 'app', idempotencyKey: `sim-${docRef}`, reason: label };
    this.postReq(req, device, kind, label);
  }

  private check(req: PostRequest): Packet['flagged'] | undefined {
    if (FULL.has(req.registerId) && req.line === 'issued' && (this.stock[req.registerId] ?? 0) - req.qty < 0) return { rule: 'V12', reason: `Only ${Math.round(this.stock[req.registerId] ?? 0)} in stock; issuing ${req.qty} would go negative.` };
    const typ = TYPICAL[req.registerId];
    if (typ && req.line !== 'received' && req.qty > 5 * typ) return { rule: 'V01', reason: `${req.qty.toLocaleString('en-IN')} is ${(req.qty / typ).toFixed(0)}× a normal entry (${typ.toLocaleString('en-IN')}). Extra zero?` };
    if (this.seen.has(req.docRef)) return { rule: 'V10', reason: `Slip ${req.docRef} was already entered.` };
    return undefined;
  }

  private postReq(req: PostRequest, device: DeviceId, kind: PacketKind, label: string, silentVisual = false) {
    const p: Packet = { id: this.pid(), t: this.clock, device, kind, registerId: req.registerId, qty: req.qty, label };
    if (!this.online[device]) {
      (p as Packet & { req?: PostRequest }).req = req;
      this.queues[device].push(p);
      if (this.queues[device].length === 1) this.log('warn', `${DEVICES.find((d) => d.id === device)!.label} is offline: entries are saved on the phone.`);
      return;
    }
    this.process(p, req, silentVisual);
  }

  private process(p: Packet, req: PostRequest, silentVisual: boolean) {
    const flag = this.check(req);
    if (flag) {
      p.flagged = flag;
      this.quarantine.unshift({ id: p.id, t: this.clock, device: p.device, registerId: req.registerId, line: req.line, qty: req.qty, suggested: flag.rule === 'V01' ? Math.round(req.qty / 10) : undefined, rule: flag.rule, reason: flag.reason, docRef: req.docRef, month: req.month });
      this.today.flagged++; this.totals.flagged++;
      this.log('block', `${flag.rule} held: ${p.label}. ${flag.reason}`);
      this.emit(p);
      return;
    }
    this.commit(req);
    if (!silentVisual || p.kind === 'rollup') this.emit(p);
    if (p.kind !== 'rollup') this.log('flow', `${DEVICES.find((d) => d.id === p.device)!.label}: ${p.label} (${req.qty.toLocaleString('en-IN')} ${req.registerId})`);
  }

  private commit(req: PostRequest) {
    this.seen.add(req.docRef);
    this.post(req);
    this.lastPosted = req;
    this.today.posted++; this.totals.posted++;
    if (FULL.has(req.registerId)) this.stock[req.registerId] = (this.stock[req.registerId] ?? 0) + (req.line === 'received' ? req.qty : req.line === 'issued' ? -req.qty : 0);
    if (req.line === 'issued') {
      if (req.registerId === 'DIESEL') this.today.diesel += req.qty;
      if (req.registerId === 'LPG') this.today.lpg += req.qty;
      if (req.registerId === 'CO2_GAS') this.today.co2 += req.qty;
    }
  }

  /** A manual entry typed in the app (not by the simulator). Keep the stock mirror in step. */
  noteManual(registerId: string, line: string, qty: number) {
    if (FULL.has(registerId)) this.stock[registerId] = (this.stock[registerId] ?? 0) + (line === 'received' ? qty : line === 'issued' ? -qty : 0);
    this.log('flow', `Manual entry from the app: ${registerId} ${line} ${qty.toLocaleString('en-IN')}`);
    this.changed();
  }

  /** Run silently before the demo opens so charts are not empty. */
  warmUp(minutes: number) {
    for (let i = 0; i < minutes; i++) this.step();
    this.events = this.events.slice(0, 25);
    this.log('info', 'Live view opened. The previous 24 hours ran in the simulator so every chart starts full. Shift A begins at 06:00.');
  }

  /** Public: let other modules write to the event stream. */
  note(level: SimEvent['level'], text: string) { this.log(level, text); this.changed(); }

  // ---------- controls ----------
  setRunning(v: boolean) { this.running = v; this.log('info', v ? 'Simulation resumed.' : 'Simulation paused.'); this.changed(); }
  setSpeed(s: Speed) { this.speed = s; this.changed(); }
  setEms(patch: Partial<Ems['settings']>) { Object.assign(this.ems.settings, patch); this.ems.plan.block = -1; if (patch.enabled !== undefined) this.log('info', patch.enabled ? 'Grid-aware optimiser ON.' : 'Optimiser OFF: plant buys everything from the DISCOM (comparison mode).'); this.changed(); }
  setOnline(d: DeviceId, v: boolean) {
    this.online[d] = v;
    if (v && this.queues[d].length) {
      const q = this.queues[d];
      this.queues[d] = [];
      this.log('ok', `${DEVICES.find((x) => x.id === d)!.label} back online: syncing ${q.length} saved entries (each posts once).`);
      q.forEach((p, i) => { p.delay = i * 120; this.process(p, (p as Packet & { req: PostRequest }).req, false); });
    } else if (!v) this.log('warn', `${DEVICES.find((x) => x.id === d)!.label} went offline.`);
    this.changed();
  }
  inject(kind: 'typo' | 'negative' | 'duplicate' | 'meterGlitch' | 'surge' | 'powerCut' | 'delivery' | 'gridStress' | 'priceSpike' | 'cloud' | 'leak') {
    if (kind === 'typo') this.entry('stores', 'HR_SHEET', 'issued', 32000, 'Steel sheet issue (typed 32000 for 3200)');
    if (kind === 'negative') this.entry('stores', 'HYD_OIL', 'issued', Math.round((this.stock.HYD_OIL ?? 0) + 150), 'Hydraulic oil issue larger than stock');
    if (kind === 'duplicate') {
      const lp = this.lastPosted && this.lastPosted.source === 'app' ? this.lastPosted : null;
      if (lp) this.entry(DEVICES.find((d) => d.label === lp.by)?.id ?? 'stores', lp.registerId, lp.line, lp.qty, 'Same slip entered again', 'entry', lp.docRef);
      else { const doc = `DIESEL-${this.stamp()}-X`; this.entry('stores', 'DIESEL', 'issued', 40, 'Diesel to forklift', 'entry', doc); this.entry('stores', 'DIESEL', 'issued', 40, 'Same slip entered again', 'entry', doc); }
    }
    if (kind === 'meterGlitch') {
      const p: Packet = { id: this.pid(), t: this.clock, device: 'meters', kind: 'meter', label: 'Compressor meter read lower than last reading', flagged: { rule: 'V11', reason: 'Cumulative kWh went backwards (meter reset or misread). Reading held for review.' } };
      this.quarantine.unshift({ id: p.id, t: this.clock, device: 'meters', registerId: 'GRID_KWH', line: 'reading', qty: 0, rule: 'V11', reason: p.flagged!.reason, docRef: `MTR-GLITCH-${this.stamp()}`, month: this.month });
      this.today.flagged++; this.totals.flagged++;
      this.log('block', `V11 held: ${p.label}.`);
      this.emit(p);
    }
    if (kind === 'surge') { this.surgeUntil = this.clock + 20 * 60_000; this.log('warn', 'Peak load: oven heat-up while all welders run.'); }
    if (kind === 'powerCut') { this.powerCutUntil = this.clock + 25 * 60_000; this.log('warn', 'Grid power cut. DG set started; diesel use will be logged when power returns.'); }
    if (kind === 'delivery') this.entry('stores', 'CO2_GAS', 'received', 1500, 'CO₂ delivery: 50 cylinders');
    if (kind === 'gridStress') { this.ems.stressEventUntil = this.clock + 45 * 60_000; this.ems.drEvents++; this.ems.plan.block = -1; this.log('warn', 'DISCOM demand-response call: grid under stress, load-shedding risk. EMS: battery + genset on, non-critical loads paused, exporting surplus.'); }
    if (kind === 'priceSpike') { this.ems.spikeUntil = this.clock + 30 * 60_000; this.ems.plan.block = -1; this.log('warn', `IEX real-time price hit the ₹10/kWh ceiling. EMS re-planning the block.`); }
    if (kind === 'cloud') { this.ems.cloud = this.ems.cloud > 0 ? 0 : 0.8; this.ems.plan.block = -1; this.log('info', this.ems.cloud ? 'Heavy cloud: solar output falling, EMS shifts to battery and green power.' : 'Cloud cleared: solar recovering.'); }
    if (kind === 'leak') { this.leakUntil = this.leakUntil > this.clock ? 0 : this.clock + 7 * 864e5; this.log('info', this.leakUntil ? 'Compressed-air leak started (simulated). Watch the idle compressor draw.' : 'Air leak fixed.'); }
    this.changed();
  }
  scenario(name: 'normal' | 'errors' | 'peak' | 'outage') {
    const at = (min: number, fn: () => void) => this.schedule.push({ at: this.clock + min * 60_000, fn });
    if (name === 'normal') { (Object.keys(this.online) as DeviceId[]).forEach((d) => !this.online[d] && this.setOnline(d, true)); this.surgeUntil = 0; this.powerCutUntil = 0; this.log('info', 'Scenario: normal running.'); }
    if (name === 'errors') { this.log('info', 'Scenario: data-entry errors over the next 30 minutes.'); at(1, () => this.inject('typo')); at(10, () => this.inject('duplicate')); at(20, () => this.inject('negative')); at(30, () => this.inject('meterGlitch')); }
    if (name === 'peak') { this.log('info', 'Scenario: peak demand.'); this.inject('surge'); at(50, () => this.inject('surge')); }
    if (name === 'outage') { this.log('info', 'Scenario: shop-floor network outage for 2 hours.'); (['stores', 'line', 'paint'] as DeviceId[]).forEach((d) => this.setOnline(d, false)); at(120, () => (['stores', 'line', 'paint'] as DeviceId[]).forEach((d) => this.setOnline(d, true))); }
    this.changed();
  }
  jumpToNextShift() {
    const h = this.hour;
    const next = h < 6 ? 6 : h < 14 ? 14 : h < 22 ? 22 : 30;
    const mins = (next - h) * 60 - this.minute;
    for (let i = 0; i < mins; i++) this.step();
    this.changed();
  }
  resolve(id: string, action: 'fix' | 'confirm' | 'reject', value?: number) {
    const q = this.quarantine.find((x) => x.id === id);
    if (!q) return;
    this.quarantine = this.quarantine.filter((x) => x.id !== id);
    if (action === 'reject' || q.rule === 'V11' && action !== 'fix') { this.log('info', `${q.rule} item rejected and discarded (${q.docRef}).`); this.changed(); return; }
    if (q.rule === 'V11') { this.log('ok', 'V11 meter reading re-taken; next packet accepted.'); this.changed(); return; }
    const qty = action === 'fix' ? value ?? q.suggested ?? q.qty : q.qty;
    const req: PostRequest = { registerId: q.registerId, month: q.month, line: q.line, qty, docRef: q.rule === 'V10' ? `${q.docRef}-R` : q.docRef, by: 'ESG custodian', source: 'app', idempotencyKey: `sim-res-${q.id}`, reason: action === 'fix' ? `Corrected from ${q.qty} to ${qty} (${q.rule})` : `Confirmed as real (${q.rule})` };
    this.commit(req);
    this.emit({ id: this.pid(), t: this.clock, device: q.device, kind: 'resolve', registerId: q.registerId, qty, label: 'Resolved' });
    this.log('ok', `${q.rule} resolved by custodian: ${action === 'fix' ? `posted ${qty.toLocaleString('en-IN')} instead of ${q.qty.toLocaleString('en-IN')}` : 'confirmed as real and posted'}.`);
    this.changed();
  }

  // ---------- persistence ----------
  snapshot() { return { clock: this.clock, speed: this.speed, today: this.today, totals: this.totals, tokens: this.tokens, tokenSeq: this.tokenSeq, seq: this.seq, stock: this.stock, meterCum: this.meterCum, seen: Array.from(this.seen).slice(-400) }; }
  restore(s: ReturnType<SimEngine['snapshot']>) {
    Object.assign(this, { clock: s.clock, speed: s.speed, today: s.today, totals: s.totals, tokens: s.tokens, tokenSeq: s.tokenSeq, seq: s.seq, stock: s.stock, meterCum: s.meterCum });
    this.seen = new Set(s.seen);
    this.log('info', 'Simulator resumed from the saved clock.');
  }
}
