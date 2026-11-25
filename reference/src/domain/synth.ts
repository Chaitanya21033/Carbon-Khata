// Deterministic dummy-data generator. Every company, figure and error here is invented.
// It plants a known set of data-entry mistakes so the validation engine has something to catch.
import { addMonths } from './util';

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (sd = 1) => {
    const u = Math.max(1e-9, next()), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
  };
  return { next, normal, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

export const HISTORY_START = '2024-11';
export const HISTORY_MONTHS = 24;
export const OPEN_MONTH = '2026-11';
export const CONTRACT_KVA = 450;
export const TRUE_A = 120000;   // base load kWh / month
export const TRUE_B = 110;      // kWh per extra body
export const ENERGY_RATE = 6.45; // ₹/kWh
export const DEMAND_RATE = 420;  // ₹/kVA/month

/** Planted mistakes (index into the 24 history months). */
export const PLANTED = {
  hrSheetExtraZero: 4,    // V01
  hrSheetMissingDigit: 13, // V02
  lowOutputMonth: 7,      // V09 (strike / shutdown)
  pfMissing: 9,           // V04
  billExtraZero: 17,      // V01 + V07
  hydClosingWrong: [3, 11, 19], // V05
  hydOverIssue: 15,       // V12 + V05
};

export type FullLine = { opening: number; received: number; issued: number; closing: number };

export interface SynthHistory {
  months: string[];
  rows: Record<string, number | undefined>[];
  full: Record<string, FullLine[]>;
  truth: { units: number[]; kwh: number[]; bill: number[]; pf: number[] };
}

const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

export function synthHistory(seed = 2026): SynthHistory {
  const r = rng(seed);
  const months = Array.from({ length: HISTORY_MONTHS }, (_, i) => addMonths(HISTORY_START, i));
  const rows: SynthHistory['rows'] = [];
  const truth: SynthHistory['truth'] = { units: [], kwh: [], bill: [], pf: [] };
  const stock = { CO2_GAS: 240, LPG: 76, OXYGEN: 70, ARGON: 6000, HYD_OIL: 1260 };
  const size = { CO2_GAS: 30, LPG: 19, OXYGEN: 7, ARGON: 1000, HYD_OIL: 210 };
  const full: SynthHistory['full'] = { CO2_GAS: [], LPG: [], OXYGEN: [], ARGON: [], HYD_OIL: [] };

  months.forEach((_, i) => {
    const season = 1 + 0.1 * Math.sin((2 * Math.PI * (i + 2)) / 12);
    let units = Math.round(400 * season * (1 + r.normal(0.05)));
    if (i === PLANTED.lowOutputMonth) units = Math.round(units * 0.55);
    const kwh = Math.round(TRUE_A + TRUE_B * units + r.normal(4500));
    const pf = round(0.93 + r.next() * 0.04, 2);
    const kvah = Math.round(kwh / pf);
    const md = Math.round(360 + 0.2 * units + r.normal(20));
    const bill = Math.round(kwh * ENERGY_RATE + md * DEMAND_RATE);
    truth.units.push(units); truth.kwh.push(kwh); truth.bill.push(bill); truth.pf.push(pf);

    const hrTrue = Math.round(units * 3200 * (1 + r.normal(0.04)));
    let hr = hrTrue;
    if (i === PLANTED.hrSheetExtraZero) hr = hrTrue * 10;
    if (i === PLANTED.hrSheetMissingDigit) hr = Math.round(hrTrue / 10);

    const row: Record<string, number | undefined> = {
      bodies_produced: units,
      grid_kwh: kwh, grid_kvah: kvah, power_factor: i === PLANTED.pfMissing ? undefined : pf, max_demand_kva: md,
      bill_inr: i === PLANTED.billExtraZero ? bill * 10 : bill,
      diesel_l: Math.round(2600 + r.normal(320)),
      hr_sheet_kg: hr,
      tube_angle_kg: Math.round(units * 420 * (1 + r.normal(0.05))),
      bar_angle_kg: Math.round(units * 12 * (1 + r.normal(0.08))),
      paint_l: Math.round(units * 22 * (1 + r.normal(0.05))),
      mig_wire_kg: Math.round(units * 38 * (1 + r.normal(0.05))),
      thinner_l: Math.round(units * 9 * (1 + r.normal(0.06))),
      hardener_l: Math.round(units * 4 * (1 + r.normal(0.06))),
      steel_shots_kg: Math.round(units * 7 * (1 + r.normal(0.08))),
      steel_grits_kg: Math.round(units * 3.5 * (1 + r.normal(0.08))),
      grease_kg: Math.round(90 + r.normal(8)),
      water_supply_l: 9000,                                  // flat-lined (V03)
      water_bore_l: Math.round(14000 + r.normal(1300)),
      brightener_a_l: Math.round(28 + r.normal(4)),
      brightener_b1_l: Math.round(26 + r.normal(4)),
      brightener_b2_l: Math.round(24 + r.normal(4)),
      conditioner_l: 30,                                     // flat (V03)
      ncz106_salt_kg: Math.round(48 + r.normal(5)),
      hydrochloric_acid_l: Math.round(850 + r.normal(70)),
      nitric_acid_l: 30,                                     // flat (V03)
      caustic_soda_kg: Math.round(72 + r.normal(7)),
      zinc_ingot_kg: Math.round(96 + r.normal(9)),
      ginthox_982l_l: 30,                                    // flat (V03)
      distilled_water_l: 1200,                               // flat (V03)
      hr_sheet_scrap_kg: Math.round(hrTrue * 0.032 * (1 + r.normal(0.05))),
      tube_scrap_kg: Math.round(units * 13 * (1 + r.normal(0.08))),
      plasma_scrap_kg: Math.round(1700 + r.normal(150)),
      shot_grit_scrap_kg: Math.round(240 + r.normal(25)),
      plasma_slag_kg: Math.round(430 + r.normal(40)),
      paint_sludge_kg: Math.round(units * 0.45 * (1 + r.normal(0.08))),
    };
    rows.push(row);

    // Full registers: receipts arrive in whole cylinders / drums; books carry closing → opening.
    const issue: Record<keyof typeof stock, number> = {
      CO2_GAS: Math.round(units * 21 * (1 + r.normal(0.04))),
      LPG: Math.round(units * 2.2 * (1 + r.normal(0.06))),
      OXYGEN: round(units * 0.75 * (1 + r.normal(0.06)), 1),
      ARGON: round(units * 65 * (1 + r.normal(0.05)), 1),
      HYD_OIL: Math.round(900 + r.normal(140)),
    };
    for (const k of Object.keys(stock) as (keyof typeof stock)[]) {
      const opening = stock[k];
      let received = 0;
      const buffer = size[k] * 2;
      if (k === 'HYD_OIL' && i === PLANTED.hydOverIssue) received = 0; // delivery not booked
      else if (opening - issue[k] < buffer) received = Math.ceil((issue[k] + buffer - opening) / size[k]) * size[k];
      let iss = issue[k];
      if (k === 'HYD_OIL' && i === PLANTED.hydOverIssue) iss = opening + 420;
      let closing = round(opening + received - iss, 1);
      if (k === 'HYD_OIL' && i === PLANTED.hydOverIssue) closing = 0;
      if (k === 'HYD_OIL' && PLANTED.hydClosingWrong.includes(i)) {
        const s = String(Math.round(closing)).padStart(3, '0');
        closing = Number(s.slice(0, -2) + s.slice(-1) + s.slice(-2, -1)) + 100; // transposed digits + slip
      }
      full[k].push({ opening, received, issued: iss, closing });
      stock[k] = Math.max(closing, 0);
    }
  });
  return { months, rows, full, truth };
}

/** The history as a flat monthly CSV (what a supplier's Excel sheet looks like). */
export function synthMonthlyCSV(h = synthHistory()): string {
  const cols = Object.keys(h.rows[0]);
  const lines = [['period_month', ...cols].join(',')];
  h.rows.forEach((row, i) => lines.push([h.months[i], ...cols.map((c) => (row[c] === undefined ? '' : row[c]))].join(',')));
  return lines.join('\n');
}

/** Open-month entries already captured before the live demo starts (days 1–9). */
export function synthOpenMonthDays(h = synthHistory(), seed = 77) {
  const r = rng(seed);
  const days: { day: number; bodies: number; kwh: number; diesel: number; hr: number; paint: number; co2: number; lpg: number; hyd: number }[] = [];
  for (let d = 1; d <= 9; d++) { // day 10 onward is produced live by the simulator
    const sunday = new Date(Date.UTC(2026, 10, d)).getUTCDay() === 0;
    const bodies = sunday ? 0 : r.int(14, 18);
    days.push({
      day: d, bodies,
      kwh: Math.round((TRUE_A / 30) + TRUE_B * bodies + 950 + r.normal(150)),
      diesel: Math.round(sunday ? 20 : 85 + r.normal(15)),
      hr: bodies * 3200 + Math.round(r.normal(2000)),
      paint: Math.round(bodies * 22 + r.normal(10)),
      co2: sunday ? 0 : 300 + r.int(0, 3) * 30,
      lpg: sunday ? 0 : 38,
      hyd: Math.round(30 + r.normal(5)),
    });
  }
  void h;
  return days;
}
