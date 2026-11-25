// Grid-aware energy management for the demo plant.
// 1) A simulated feed shaped like the Indian Energy Exchange (IEX) market: 96 fifteen-minute blocks a day,
//    day-ahead (DAM), green day-ahead (G-DAM) and real-time (RTM) prices, plus a regional grid "duck curve"
//    and a time-of-day marginal emission factor. In production this class is swapped for a licensed
//    market-data adapter; everything downstream only reads `MarketBlock`.
// 2) A dispatch engine (EMS) that decides every 15 minutes: buy from which category, charge / discharge the
//    battery, run the gas genset, shift flexible loads, export to the grid, or shed load for a grid event.
import { rng } from '../domain/synth';

export const BLOCKS = 96;
export const PRICE_CAP = 10; // ₹/kWh, exchange price ceiling (illustrative)

export interface MarketBlock {
  block: number;           // 0..95
  dam: number;             // ₹/kWh day-ahead clearing price
  gdam: number;            // ₹/kWh green day-ahead
  rtm: number;             // ₹/kWh real-time clearing price
  discom: number;          // ₹/kWh DISCOM time-of-day tariff (energy charge)
  gridDemandGW: number;    // regional demand
  solarGW: number;         // regional solar
  netDemandGW: number;     // demand − solar (the duck curve)
  marginalEf: number;      // kg CO₂/kWh, time-of-day marginal (illustrative)
  stress: number;          // 0–100 grid stress index
}

/** Open-access landed adders on top of exchange price (wheeling, transmission, surcharges). Illustrative. */
export const OA_ADDER = { grey: 1.7, green: 1.1 };
export const CEA_EF = 0.71;        // kg/kWh, location-based (CEA average)
export const GENSET_EF = 0.61;     // kg/kWh, natural-gas genset (≈ 2.02 kg/scm ÷ 3.3 kWh/scm)
export const GENSET_KWH_PER_SCM = 3.3;
export const GENSET_FUEL_INR = 5.6; // ₹/kWh fuel cost
export const IMPORT_CAP_KW = 380;  // keep 15-min demand under the 450 kVA contract
export const EXPORT_CAP_KW = 220;

export const SOURCES = ['solar', 'bess', 'genset', 'green', 'rtm', 'dam', 'discom'] as const;
export type Source = typeof SOURCES[number];
export const SOURCE_LABEL: Record<Source, string> = { solar: 'Rooftop solar', bess: 'Battery', genset: 'Gas genset (CHP)', green: 'Green power (G-DAM)', rtm: 'Exchange real-time (RTM)', dam: 'Exchange day-ahead (DAM)', discom: 'DISCOM tariff' };
export const SOURCE_COLOR: Record<Source, string> = { solar: '#F2C14E', bess: '#7C5CFF', genset: '#E8743B', green: '#3FBF7F', rtm: '#4C9BE8', dam: '#2EC4B6', discom: '#8A979F' };

function interp(pts: [number, number][], h: number) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [h0, v0] = pts[i], [h1, v1] = pts[i + 1];
    if (h >= h0 && h <= h1) { const t = (h - h0) / (h1 - h0); return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * t)); }
  }
  return pts[pts.length - 1][1];
}

const PRICE_SHAPE: [number, number][] = [[0, 4.6], [4, 3.9], [6.5, 5.2], [8.5, 5.8], [10, 3.4], [12.5, 2.4], [15, 3.0], [17, 6.2], [18.5, 9.4], [21, 9.6], [22.5, 7.2], [24, 4.6]];
const DEMAND_SHAPE: [number, number][] = [[0, 34], [4, 31], [7, 37], [10, 41], [13, 42], [16, 41], [18, 43], [20, 46], [22, 42], [24, 34]];

export function discomTod(h: number) {
  const base = 7.0;
  if (h >= 9 && h < 17) return +(base * 0.8).toFixed(2);  // solar hours: at least 20% lower
  if (h >= 18 && h < 22) return +(base * 1.2).toFixed(2); // peak hours: at least 20% higher
  return base;
}

/** Deterministic market day: same date → same curve (so forecasts and actuals agree across reloads). */
export function marketDay(dayIndex: number, cloud = 0): MarketBlock[] {
  const r = rng(9001 + dayIndex * 31);
  const dayCloud = 0.15 * r.next();
  const out: MarketBlock[] = [];
  for (let b = 0; b < BLOCKS; b++) {
    const h = b / 4;
    const sun = Math.max(0, Math.sin((Math.PI * (h - 6.2)) / 12.6));
    const solarGW = 22 * sun * (1 - dayCloud - cloud * 0.6);
    const gridDemandGW = interp(DEMAND_SHAPE, h) * (1 + r.normal(0.008));
    const netDemandGW = gridDemandGW - solarGW;
    const dam = Math.min(PRICE_CAP, Math.max(1.6, interp(PRICE_SHAPE, h) + r.normal(0.25) + cloud * 2.5 * sun));
    const rtm = Math.min(PRICE_CAP, Math.max(1.2, dam + r.normal(0.6) + (r.next() < 0.03 ? 2.5 : 0)));
    const gdam = Math.min(PRICE_CAP, dam + (sun > 0.3 ? -0.2 : 0.9));
    const marginalEf = +(0.92 - 0.38 * sun + (h >= 17.5 && h < 22 ? 0.08 : 0)).toFixed(3);
    const ramp = b > 0 ? Math.max(0, netDemandGW - (out[b - 1]?.netDemandGW ?? netDemandGW)) : 0;
    const stress = Math.max(0, Math.min(100, (netDemandGW - 26) * 4.2 + ramp * 30));
    out.push({ block: b, dam: +dam.toFixed(2), gdam: +gdam.toFixed(2), rtm: +rtm.toFixed(2), discom: discomTod(Math.floor(h)), gridDemandGW: +gridDemandGW.toFixed(2), solarGW: +solarGW.toFixed(2), netDemandGW: +netDemandGW.toFixed(2), marginalEf, stress: Math.round(stress) });
  }
  return out;
}

export const landed = (b: MarketBlock) => ({
  discom: b.discom,
  rtm: b.rtm + OA_ADDER.grey,
  dam: b.dam + OA_ADDER.grey,
  green: b.gdam + OA_ADDER.green,
});

export interface Flows { // kW, averaged over the minute
  load: number; flexRun: number; solar: number; bessOut: number; bessIn: number; genset: number;
  green: number; rtm: number; dam: number; discom: number; export: number; curtail: number; shed: number;
}
export interface Decision { t: number; block: number; text: string; mode: string; savedInr: number; avoidedKg: number }

export interface EmsSettings { enabled: boolean; carbonPrice: number; greenCapKw: number; reserveSoc: number }

export class Ems {
  settings: EmsSettings = { enabled: true, carbonPrice: 1500, greenCapKw: 150, reserveSoc: 0.2 };
  // assets
  solarKwp = 250;
  bess = { capKwh: 400, powerKw: 150, soc: 0.55, eff: 0.92 };
  gen = { kw: 150, on: false, gasScm: 0, minRunBlocks: 2, ranBlocks: 0 };
  flex = { queueKwh: 0, runKw: 60, deadlineH: 21 };
  // market
  day = -1;
  market: MarketBlock[] = [];
  tomorrow: MarketBlock[] = [];
  cloud = 0; cloudUntil = 0;
  stressEventUntil = 0; spikeUntil = 0;
  // current plan for the block
  plan = { block: -1, bess: 0, genset: false, export: false, flexOn: false, buy: 'discom' as Source, greenKw: 0, shed: 0, reason: '' };
  flows: Flows = { load: 0, flexRun: 0, solar: 0, bessOut: 0, bessIn: 0, genset: 0, green: 0, rtm: 0, dam: 0, discom: 0, export: 0, curtail: 0, shed: 0 };
  // accounting (today, per source kWh, ₹, kg)
  today = this.blank();
  naive = { costInr: 0, kg: 0, peakKw: 0, peakEveningKwh: 0, exportInr: 0 };
  hour = { solar: 0, green: 0, grid: 0, export: 0, gasScm: 0 };
  blockLog: { t: number; block: number; supply: Record<Source, number>; export: number; load: number; price: number; naiveImport: number; plantNet: number; cost: number; naiveCost: number; kg: number; naiveKg: number; evening: boolean; peakKw: number; naivePeakKw: number; shifted: number; gas: number }[] = [];
  decisions: Decision[] = [];
  drEvents = 0; drKwh = 0; islandMin = 0;
  totals = { solarKwh: 0, greenKwh: 0, savedInr: 0, avoidedKg: 0, exportKwh: 0, exportInr: 0, shiftedKwh: 0 };
  private blockAcc = this.blankBlock();
  private r = rng(777);

  blank() { return { kwh: Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>, costInr: 0, exportKwh: 0, exportInr: 0, kgMarket: 0, kgLocation: 0, kgMarginal: 0, peakKw: 0, peakEveningImportKwh: 0, shiftedKwh: 0, gasScm: 0 }; }
  private blankBlock() { return { supply: Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>, export: 0, load: 0, naiveImport: 0, n: 0, cost: 0, naiveCost: 0, kg: 0, naiveKg: 0, evening: false, peakKw: 0, naivePeakKw: 0, shifted: 0, gas: 0 }; }

  ensureDay(dayIndex: number) {
    if (this.day === dayIndex) return;
    this.day = dayIndex;
    this.market = marketDay(dayIndex, 0);
    this.tomorrow = marketDay(dayIndex + 1, 0);
  }
  current(block: number): MarketBlock {
    const b = { ...this.market[block] };
    if (this.cloudFactor() > 0) { b.rtm = Math.min(PRICE_CAP, b.rtm + 1.5 * this.cloudFactor()); }
    if (this.spikeUntil > 0) b.rtm = PRICE_CAP;
    if (this.stressEventUntil > 0) b.stress = Math.max(b.stress, 92);
    return b;
  }
  private cloudFactor() { return this.cloud; }

  solarKw(clock: number) {
    const d = new Date(clock);
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    const sun = Math.max(0, Math.sin((Math.PI * (h - 6.2)) / 12.6));
    const flicker = 1 - 0.06 * Math.abs(this.r.normal(1)) * sun;
    return this.solarKwp * 0.82 * sun * flicker * (1 - 0.75 * this.cloud);
  }

  /** Price percentile of a block within the coming 24 h (lower = cheaper). */
  private percentile(block: number, price: number) {
    const next = [...this.market.slice(block), ...this.tomorrow.slice(0, block)].map((b) => landed(b).discom > 0 ? Math.min(landed(b).discom, landed(b).rtm, landed(b).green) : 0);
    return next.filter((p) => p < price).length / next.length;
  }

  /** Decide the plan for a new 15-minute block. */
  decide(clock: number, block: number, loadKw: number, flexPendingKwh: number, working: boolean, gridDown: boolean): string {
    const mb = this.current(block);
    const L = landed(mb);
    const cheapestGrid = Math.min(L.discom, L.rtm, L.dam, L.green);
    const pct = this.percentile(block, cheapestGrid);
    const solar = this.solarKw(clock);
    const net = loadKw - solar;
    const cp = this.settings.carbonPrice / 1000; // ₹/kg
    const p = { block, bess: 0, genset: false, export: false, flexOn: false, buy: 'discom' as Source, greenKw: 0, shed: 0, reason: '' };
    const reasons: string[] = [];
    if (!this.settings.enabled) {
      p.reason = 'Optimiser off: solar self-use only, everything else from the DISCOM.';
      p.flexOn = working;
      this.plan = p;
      return p.reason;
    }
    const socKwh = this.bess.soc * this.bess.capKwh;
    const reserve = this.settings.reserveSoc * this.bess.capKwh;
    // effective cost per source including shadow carbon price
    const eff: Record<'discom' | 'rtm' | 'dam' | 'green', number> = {
      discom: L.discom + cp * CEA_EF, rtm: L.rtm + cp * CEA_EF, dam: L.dam + cp * CEA_EF, green: L.green,
    };
    const buy = (Object.keys(eff) as (keyof typeof eff)[]).sort((a, b) => eff[a] - eff[b])[0];
    p.buy = buy;
    if (buy === 'green') p.greenKw = Math.min(this.settings.greenCapKw, Math.max(0, net));
    reasons.push(`buy ${buy.toUpperCase()} at ₹${(buy === 'discom' ? L.discom : L[buy]).toFixed(2)}`);

    const stressed = mb.stress >= 70 || this.stressEventUntil > clock;
    const expensive = pct >= 0.75 || cheapestGrid >= 8;
    const cheap = pct <= 0.3;
    // Battery
    if (gridDown) { p.bess = Math.min(this.bess.powerKw, socKwh * 4); reasons.push('grid down: battery carries critical load'); }
    else if (net < 0) { p.bess = -Math.min(this.bess.powerKw, -net); reasons.push('store surplus solar'); }
    else if ((expensive || stressed) && socKwh > reserve + 5) { p.bess = Math.min(this.bess.powerKw, (socKwh - reserve) * 4); reasons.push(stressed ? `grid stress ${mb.stress}: discharge` : 'peak price: discharge'); }
    else if (cheap && this.bess.soc < 0.95) { p.bess = -this.bess.powerKw; reasons.push('cheap block: charge battery'); }
    // Genset
    const gensetCost = GENSET_FUEL_INR + cp * GENSET_EF;
    const gridCost = Math.min(eff.discom, eff.rtm, eff.green);
    if (gridDown || stressed || gridCost > gensetCost + 1.2 || (this.gen.on && this.gen.ranBlocks < this.gen.minRunBlocks)) { p.genset = true; if (!this.gen.on) reasons.push(`start genset (₹${gensetCost.toFixed(2)}/kWh < grid ₹${gridCost.toFixed(2)})`); }
    // Export when our supply exceeds load and the market pays
    const supplyNoGrid = solar + (p.bess > 0 ? p.bess : 0) + (p.genset ? this.gen.kw : 0);
    if (!gridDown && supplyNoGrid > loadKw && (mb.rtm >= 6 || stressed)) { p.export = true; reasons.push(`export surplus at ₹${mb.rtm.toFixed(2)}`); }
    // Flexible loads (shot blast batches, forklift charging, oven pre-heat)
    const hNow = new Date(clock).getUTCHours();
    const nearDeadline = hNow >= this.flex.deadlineH - 2 || hNow < 6;
    p.flexOn = flexPendingKwh > 1 && (net < 0 || cheap || nearDeadline) && !stressed && !gridDown;
    if (flexPendingKwh > 1 && !p.flexOn && working) reasons.push('defer flexible load');
    if (p.flexOn) reasons.push(net < 0 ? 'run flexible load on solar' : 'run flexible load in cheap block');
    // Demand response
    if (stressed && !gridDown && this.stressEventUntil > clock) { p.shed = Math.min(40, loadKw * 0.12); reasons.push(`DR: shed ${p.shed.toFixed(0)} kW non-critical`); }
    p.reason = reasons.join(' · ');
    this.plan = p;
    return p.reason;
  }

  /** Apply the plan for one minute. Returns the per-minute flows. */
  minute(clock: number, block: number, baseLoadKw: number, flexKwhPending: number, gridDown: boolean) {
    const mb = this.current(block);
    const L = landed(mb);
    const plan = this.plan;
    const solar = this.solarKw(clock);
    const flexRun = plan.flexOn && flexKwhPending > 0 ? Math.min(this.flex.runKw, flexKwhPending * 60) : 0;
    const shed = plan.shed;
    const load = Math.max(0, baseLoadKw + flexRun - shed);
    // genset
    const genKw = plan.genset ? this.gen.kw : 0;
    this.gen.on = plan.genset;
    // battery
    let bessOut = 0, bessIn = 0;
    const capKwh = this.bess.capKwh;
    const need = load - solar - genKw;
    if (plan.bess <= 0 && this.settings.enabled && !gridDown && need > IMPORT_CAP_KW && this.bess.soc > 0.08) {
      bessOut = Math.min(this.bess.powerKw, need - IMPORT_CAP_KW, (this.bess.soc - 0.05) * capKwh * 60); // peak shaving
    } else if (plan.bess > 0) {
      const room = (this.bess.soc - (gridDown ? 0.02 : this.settings.reserveSoc)) * capKwh * 60;
      bessOut = Math.max(0, Math.min(plan.bess, room, Math.max(0, load - solar - genKw) + (plan.export ? EXPORT_CAP_KW : 0)));
    } else if (plan.bess < 0) {
      const room = (1 - this.bess.soc) * capKwh * 60;
      const headroom = gridDown ? Math.max(0, -need) : Math.max(0, IMPORT_CAP_KW - need);
      bessIn = Math.max(0, Math.min(-plan.bess, room, headroom));
    }
    // balance
    let supply = solar + genKw + bessOut;
    let deficit = load + bessIn - supply;
    const f: Flows = { load, flexRun, solar, bessOut, bessIn, genset: genKw, green: 0, rtm: 0, dam: 0, discom: 0, export: 0, curtail: 0, shed };
    if (deficit > 0) {
      if (gridDown) { f.shed += deficit; f.load -= deficit; deficit = 0; }
      else {
        const g = plan.buy === 'green' ? Math.min(deficit, plan.greenKw || deficit) : 0;
        f.green = g; deficit -= g;
        if (plan.buy === 'rtm') { f.rtm = deficit; } else if (plan.buy === 'dam') { f.dam = deficit; } else { f.discom = deficit; }
      }
    } else if (deficit < 0) {
      const surplus = -deficit;
      if (!gridDown && plan.export) f.export = Math.min(EXPORT_CAP_KW, surplus);
      else if (!gridDown && this.settings.enabled) f.export = Math.min(EXPORT_CAP_KW, surplus); // net-metered spill
      f.curtail = surplus - f.export;
    }
    supply += f.green + f.rtm + f.dam + f.discom;
    // battery state
    this.bess.soc = Math.max(0, Math.min(1, this.bess.soc + (bessIn * this.bess.eff - bessOut / this.bess.eff) / 60 / capKwh));
    // accounting
    const m = 1 / 60;
    const T = this.today;
    T.kwh.solar += Math.min(solar, solar) * m; T.kwh.bess += bessOut * m; T.kwh.genset += genKw * m; T.kwh.green += f.green * m; T.kwh.rtm += f.rtm * m; T.kwh.dam += f.dam * m; T.kwh.discom += f.discom * m;
    const exportPrice = mb.rtm - 0.6;
    T.exportKwh += f.export * m; T.exportInr += f.export * m * exportPrice;
    const cost = (f.discom * L.discom + f.rtm * L.rtm + f.dam * L.dam + f.green * L.green + genKw * GENSET_FUEL_INR) * m - f.export * m * exportPrice;
    T.costInr += cost;
    const gridImport = f.discom + f.rtm + f.dam;
    T.kgMarket += (gridImport * CEA_EF + genKw * GENSET_EF) * m;
    T.kgLocation += ((gridImport + f.green) * CEA_EF + genKw * GENSET_EF) * m;
    T.kgMarginal += ((gridImport + f.green - f.export) * mb.marginalEf + genKw * GENSET_EF) * m;
    T.gasScm += genKw * m / GENSET_KWH_PER_SCM;
    T.peakKw = Math.max(T.peakKw, gridImport + f.green);
    const h = new Date(clock).getUTCHours();
    const evening = h >= 18 && h < 22;
    if (evening) T.peakEveningImportKwh += (gridImport + f.green - f.export) * m;
    // naive twin: same base load, flexible load run immediately, solar self-used, rest from DISCOM, surplus net-metered at ₹3
    const naiveLoad = baseLoadKw + (this.naiveFlexNow ?? 0);
    const naiveImport = Math.max(0, naiveLoad - solar);
    const naiveSpill = Math.max(0, solar - naiveLoad);
    const nCost = naiveImport * L.discom * m - naiveSpill * 3 * m;
    this.naive.costInr += nCost;
    const nKg = naiveImport * CEA_EF * m;
    this.naive.kg += nKg;
    this.naive.peakKw = Math.max(this.naive.peakKw, naiveImport);
    if (evening) this.naive.peakEveningKwh += naiveImport * m;
    const nMarg = (naiveImport - naiveSpill) * mb.marginalEf * m;
    const saved = nCost - cost;
    const avoided = nMarg - ((gridImport + f.green - f.export) * mb.marginalEf + genKw * GENSET_EF) * m;
    this.totals.savedInr += saved; this.totals.avoidedKg += avoided;
    this.totals.solarKwh += solar * m; this.totals.greenKwh += f.green * m; this.totals.exportKwh += f.export * m; this.totals.exportInr += f.export * m * exportPrice;
    if (flexRun > 0 && (mb.marginalEf < 0.8)) { T.shiftedKwh += flexRun * m; this.totals.shiftedKwh += flexRun * m; }
    if (shed > 0) this.drKwh += shed * m;
    if (gridDown) this.islandMin++;
    // hourly register buffers
    this.hour.solar += solar * m; this.hour.green += f.green * m; this.hour.grid += gridImport * m; this.hour.export += f.export * m; this.hour.gasScm += genKw * m / GENSET_KWH_PER_SCM;
    // block log
    const a = this.blockAcc;
    a.supply.solar += Math.min(solar, load + bessIn) * m; a.supply.bess += bessOut * m; a.supply.genset += genKw * m; a.supply.green += f.green * m; a.supply.rtm += f.rtm * m; a.supply.dam += f.dam * m; a.supply.discom += f.discom * m;
    a.export += f.export * m; a.load += load * m; a.naiveImport += naiveImport * m; a.n++;
    a.cost += cost; a.naiveCost += nCost; a.kg += (gridImport * CEA_EF + genKw * GENSET_EF) * m; a.naiveKg += nKg; a.evening = evening; a.peakKw = Math.max(a.peakKw, gridImport + f.green); a.naivePeakKw = Math.max(a.naivePeakKw, naiveImport); a.gas += genKw * m / GENSET_KWH_PER_SCM; if (flexRun > 0 && mb.marginalEf < 0.8) a.shifted += flexRun * m;
    this.blockSaved += saved; this.blockAvoided += avoided;
    this.flows = f;
    return f;
  }
  naiveFlexNow = 0;
  blockSaved = 0; blockAvoided = 0;

  closeBlock(clock: number, block: number) {
    const a = this.blockAcc;
    if (a.n) {
      const mb = this.current(block);
      const gridIn = a.supply.green + a.supply.rtm + a.supply.dam + a.supply.discom;
      this.blockLog.push({ t: clock, block, supply: { ...a.supply }, export: a.export, load: a.load, price: mb.rtm, naiveImport: a.naiveImport, plantNet: gridIn - a.export, cost: a.cost, naiveCost: a.naiveCost, kg: a.kg, naiveKg: a.naiveKg, evening: a.evening, peakKw: a.peakKw, naivePeakKw: a.naivePeakKw, shifted: a.shifted, gas: a.gas });
      if (this.blockLog.length > 96) this.blockLog.shift();
      this.decisions.unshift({ t: clock, block, text: this.plan.reason, mode: this.plan.export ? 'export' : this.plan.bess > 0 ? 'discharge' : this.plan.bess < 0 ? 'charge' : this.plan.genset ? 'genset' : 'grid', savedInr: this.blockSaved, avoidedKg: this.blockAvoided });
      if (this.decisions.length > 60) this.decisions.length = 60;
    }
    this.blockAcc = this.blankBlock();
    this.blockSaved = 0; this.blockAvoided = 0;
    if (this.plan.genset) this.gen.ranBlocks++; else this.gen.ranBlocks = 0;
  }

  /** Rolling last-24-hour totals (96 blocks), so the view is never empty after midnight. */
  last24() {
    const L = this.blockLog;
    const kwh = Object.fromEntries(SOURCES.map((s) => [s, L.reduce((a, b) => a + b.supply[s], 0)])) as Record<Source, number>;
    const sum = (f: (b: typeof L[number]) => number) => L.reduce((a, b) => a + f(b), 0);
    return {
      blocks: L.length, kwh, cost: sum((b) => b.cost), naiveCost: sum((b) => b.naiveCost), kg: sum((b) => b.kg), naiveKg: sum((b) => b.naiveKg),
      eve: sum((b) => (b.evening ? b.plantNet : 0)), naiveEve: sum((b) => (b.evening ? b.naiveImport : 0)),
      peak: Math.max(0, ...L.map((b) => b.peakKw)), naivePeak: Math.max(0, ...L.map((b) => b.naivePeakKw)), export: sum((b) => b.export), shifted: sum((b) => b.shifted), gas: sum((b) => b.gas),
    };
  }

  takeHour() { const h = this.hour; this.hour = { solar: 0, green: 0, grid: 0, export: 0, gasScm: 0 }; return h; }

  rollDay() {
    const t = this.today, n = this.naive;
    const summary = { costInr: t.costInr, naiveInr: n.costInr, solar: t.kwh.solar, exportKwh: t.exportKwh, eveningCut: n.peakEveningKwh - t.peakEveningImportKwh };
    this.today = this.blank();
    this.naive = { costInr: 0, kg: 0, peakKw: 0, peakEveningKwh: 0, exportInr: 0 };
    return summary;
  }
}
