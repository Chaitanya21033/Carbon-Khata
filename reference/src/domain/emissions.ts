import type { EmissionFactor, Month, Register } from './types';
import { consumption, value, type LedgerIndex } from './ledger';
import { addMonths, linreg } from './util';

/** A month uses the highest version valid in that month; months before any validity use the earliest version. */
export function factorFor(factors: EmissionFactor[], code: string, month: Month): EmissionFactor | undefined {
  const d = `${month}-01`;
  const list = factors.filter((f) => f.code === code);
  const valid = list.filter((f) => f.valid_from <= d && (f.valid_to === null || f.valid_to >= d)).sort((a, b) => b.version - a.version);
  if (valid[0]) return valid[0];
  return list.sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.version - b.version)[0];
}

export interface MonthEmissions {
  month: Month;
  output: number;
  kwh: number;
  items: { code: string; label: string; scope: 1 | 2; qty: number; unit: string; factor: number; factorVersion: number; kg: number }[];
  scope1: number; scope2: number; total: number; // kg
  intensity: number;   // kg per unit
  kwhPerUnit: number;
}

export function monthEmissions(registers: Register[], idx: LedgerIndex, factors: EmissionFactor[], month: Month): MonthEmissions {
  const items: MonthEmissions['items'] = [];
  for (const r of registers) {
    if (!r.factorCode) continue;
    const f = factorFor(factors, r.factorCode, month);
    if (!f || f.scope === 3) continue;
    const qty = consumption(idx, r, month) ?? 0;
    items.push({ code: r.code, label: r.label, scope: f.scope as 1 | 2, qty, unit: r.unit, factor: f.kgco2e_per_unit, factorVersion: f.version, kg: qty * f.kgco2e_per_unit });
  }
  const scope1 = items.filter((i) => i.scope === 1).reduce((s, i) => s + i.kg, 0);
  const scope2 = items.filter((i) => i.scope === 2).reduce((s, i) => s + i.kg, 0);
  const output = value(idx, 'PROD', month, 'reading') ?? 0;
  const kwh = value(idx, 'GRID_KWH', month, 'reading') ?? 0;
  const total = scope1 + scope2;
  return { month, output, kwh, items, scope1, scope2, total, intensity: output ? total / output : 0, kwhPerUnit: output ? kwh / output : 0 };
}

export function periodTotals(rows: MonthEmissions[]) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const output = rows.reduce((s, r) => s + r.output, 0);
  const kwh = rows.reduce((s, r) => s + r.kwh, 0);
  const byItem: Record<string, { label: string; qty: number; unit: string; kg: number; scope: number }> = {};
  for (const r of rows) for (const i of r.items) {
    byItem[i.code] ??= { label: i.label, qty: 0, unit: i.unit, kg: 0, scope: i.scope };
    byItem[i.code].qty += i.qty;
    byItem[i.code].kg += i.kg;
  }
  return {
    months: rows.length, total, output, kwh,
    scope1: rows.reduce((s, r) => s + r.scope1, 0), scope2: rows.reduce((s, r) => s + r.scope2, 0),
    intensity: output ? total / output : 0, byItem,
  };
}

/** Effective tariff from the plant's own bills: Σ₹ / ΣkWh. */
export function effectiveTariff(idx: LedgerIndex, months: Month[]): number {
  let inr = 0, kwh = 0;
  for (const m of months) {
    const a = value(idx, 'BILL_INR', m, 'reading');
    const k = value(idx, 'GRID_KWH', m, 'reading');
    if (a !== undefined && k !== undefined) { inr += a; kwh += k; }
  }
  return kwh ? inr / kwh : 0;
}

/** Base-load fit: monthly kWh = a + b × output. */
export function baseLoad(idx: LedgerIndex, months: Month[]) {
  const pts = months
    .map((m) => ({ month: m, x: value(idx, 'PROD', m, 'reading'), y: value(idx, 'GRID_KWH', m, 'reading') }))
    .filter((p): p is { month: Month; x: number; y: number } => p.x !== undefined && p.y !== undefined);
  if (pts.length < 9) return null;
  const { a, b, r2, meanY } = linreg(pts.map((p) => p.x), pts.map((p) => p.y));
  return { a, b, r2, share: a / meanY, points: pts };
}

export function last12(months: Month[]): Month[] {
  const end = months[months.length - 1];
  const start = addMonths(end, -11);
  return months.filter((m) => m >= start);
}
