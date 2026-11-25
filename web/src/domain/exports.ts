import type { EmissionFactor, Issue, IssueState, LedgerEntry, Month, Register } from './types';
import { monthEmissions, periodTotals, factorFor } from './emissions';
import { value, type LedgerIndex } from './ledger';

export const SCHEMA_VERSION = 'supplier_esg_v1';

// Standard net calorific values (IPCC 2006): diesel 43.0 TJ/Gg at 0.832 kg/L; LPG 47.3 TJ/Gg.
const GJ_PER_KWH = 0.0036;
const GJ_PER_L_DIESEL = 0.043 * 0.832;
const GJ_PER_KG_LPG = 0.0473;

export interface ExportInput {
  supplier: string; plant: string; product: string; oemVendorCode: string;
  registers: Register[]; idx: LedgerIndex; factors: EmissionFactor[]; months: Month[];
  dq: Record<Month, number>; issues: Issue[]; issueStates: Record<string, IssueState>;
  closed: Record<Month, boolean>;
}

const sumReg = (idx: LedgerIndex, reg: string, months: Month[], line: 'issued' | 'reading' = 'issued') =>
  months.reduce((s, m) => s + (value(idx, reg, m, line) ?? 0), 0);

/** Canonical JSON — every other format is written from this. */
export function canonical(inp: ExportInput) {
  const rows = inp.months.map((m) => monthEmissions(inp.registers, inp.idx, inp.factors, m));
  const t = periodTotals(rows);
  const waste = inp.registers.filter((r) => r.category === 'scrap' || r.category === 'waste');
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    supplier: { name: inp.supplier, oem_vendor_code: inp.oemVendorCode },
    plant: inp.plant,
    period: { from: inp.months[0], to: inp.months[inp.months.length - 1] },
    label: 'Estimated from activity data and standard factors',
    months: rows.map((r) => ({
      month: r.month,
      status: inp.closed[r.month] ? 'closed' : 'open',
      output: { qty: r.output, unit: inp.product },
      energy: { grid_kwh: r.kwh, diesel_l: value(inp.idx, 'DIESEL', r.month, 'issued') ?? 0, lpg_kg: value(inp.idx, 'LPG', r.month, 'issued') ?? 0 },
      emissions_kgco2e: { scope1: round(r.scope1), scope2: round(r.scope2), total: round(r.total), by_source: Object.fromEntries(r.items.map((i) => [i.code, round(i.kg)])) },
      intensity: { kgco2e_per_unit: round(r.intensity, 2), kwh_per_unit: round(r.kwhPerUnit, 2) },
      water_l: (value(inp.idx, 'WATER_SUPPLY', r.month, 'issued') ?? 0) + (value(inp.idx, 'WATER_BORE', r.month, 'issued') ?? 0),
      waste_kg: Object.fromEntries(waste.map((w) => [w.code, value(inp.idx, w.id, r.month, 'issued') ?? 0])),
      data_quality_score: inp.dq[r.month] ?? null,
    })),
    totals: { output: t.output, scope1_t: round(t.scope1 / 1000, 1), scope2_t: round(t.scope2 / 1000, 1), total_t: round(t.total / 1000, 1), kgco2e_per_unit: round(t.intensity, 1) },
    factors_used: Array.from(new Set(inp.registers.filter((r) => r.factorCode).map((r) => r.factorCode!))).map((c) => {
      const f = factorFor(inp.factors, c, inp.months[inp.months.length - 1])!;
      return { code: f.code, value: f.kgco2e_per_unit, unit: `kgCO2e/${f.unit}`, version: f.version, source: f.source };
    }),
    open_issues: inp.issues.filter((i) => inp.months.includes(i.month) && (inp.issueStates[i.id]?.status ?? 'open') === 'open').length,
  };
}

function round(n: number, d = 1) { const p = 10 ** d; return Math.round(n * p) / p; }

function toCSV(rows: (string | number)[][]) {
  return rows.map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}

export function prakritiCSV(c: ReturnType<typeof canonical>) {
  const head = ['supplier_vendor_code', 'supplier_name', 'plant', 'month', 'month_status', 'output_qty', 'grid_kwh', 'diesel_l', 'lpg_kg', 'scope1_kgco2e', 'scope2_kgco2e', 'total_kgco2e', 'kgco2e_per_unit', 'kwh_per_unit', 'water_l', 'hazardous_waste_kg', 'scrap_kg', 'dq_score', 'schema_version'];
  const rows = c.months.map((m) => {
    const scrap = Object.entries(m.waste_kg).filter(([k]) => k !== 'SLUDGE').reduce((s, [, v]) => s + (v as number), 0);
    return [c.supplier.oem_vendor_code, c.supplier.name, c.plant, m.month, m.status, m.output.qty, m.energy.grid_kwh, m.energy.diesel_l, m.energy.lpg_kg, m.emissions_kgco2e.scope1, m.emissions_kgco2e.scope2, m.emissions_kgco2e.total, m.intensity.kgco2e_per_unit, m.intensity.kwh_per_unit, m.water_l, (m.waste_kg as Record<string, number>).SLUDGE ?? 0, round(scrap), m.data_quality_score ?? '', c.schema_version];
  });
  return toCSV([head, ...rows]);
}

export function brsrP6CSV(c: ReturnType<typeof canonical>, inp: ExportInput) {
  const kwh = c.months.reduce((s, m) => s + m.energy.grid_kwh, 0);
  const diesel = c.months.reduce((s, m) => s + m.energy.diesel_l, 0);
  const lpg = c.months.reduce((s, m) => s + m.energy.lpg_kg, 0);
  const water = c.months.reduce((s, m) => s + m.water_l, 0);
  const sludge = sumReg(inp.idx, 'SLUDGE', inp.months);
  const scrap = inp.registers.filter((r) => r.category === 'scrap').reduce((s, r) => s + sumReg(inp.idx, r.id, inp.months), 0);
  return toCSV([
    ['BRSR Principle 6 indicator', 'Value', 'Unit', 'Basis'],
    ['Total electricity consumption (A)', round(kwh * GJ_PER_KWH, 1), 'GJ', 'Grid bills'],
    ['Total fuel consumption (B)', round(diesel * GJ_PER_L_DIESEL + lpg * GJ_PER_KG_LPG, 1), 'GJ', 'Diesel and LPG issues, IPCC 2006 NCV'],
    ['Total energy consumption (A+B)', round(kwh * GJ_PER_KWH + diesel * GJ_PER_L_DIESEL + lpg * GJ_PER_KG_LPG, 1), 'GJ', ''],
    ['Energy intensity per unit of output', round((kwh * GJ_PER_KWH + diesel * GJ_PER_L_DIESEL + lpg * GJ_PER_KG_LPG) / c.totals.output, 3), 'GJ per unit', ''],
    ['Total Scope 1 emissions', c.totals.scope1_t, 'tCO2e', 'Diesel, LPG, CO2 welding gas'],
    ['Total Scope 2 emissions', c.totals.scope2_t, 'tCO2e', 'CEA grid factor'],
    ['GHG intensity per unit of output', c.totals.kgco2e_per_unit, 'kgCO2e per unit', ''],
    ['Total water withdrawal', round(water / 1000, 1), 'kL', 'Supply + borewell registers'],
    ['Hazardous waste generated (paint sludge)', round(sludge / 1000, 2), 't', ''],
    ['Metal scrap generated (sent for recycling)', round(scrap / 1000, 1), 't', ''],
    ['Period', `${c.period.from} to ${c.period.to}`, '', c.schema_version],
  ]);
}

export function rawLedgerCSV(entries: LedgerEntry[], registers: Register[]) {
  const name = Object.fromEntries(registers.map((r) => [r.id, r.label]));
  return toCSV([
    ['entry_id', 'register', 'month', 'line', 'qty', 'unit', 'status', 'reverses_entry_id', 'corrects_entry_id', 'reason', 'doc_ref', 'entered_by', 'entered_at', 'source'],
    ...entries.map((e) => [e.id, name[e.registerId] ?? e.registerId, e.month, e.line, e.qty, registers.find((r) => r.id === e.registerId)?.unit ?? '', e.status, e.reversesId ?? '', e.correctsId ?? '', e.reason ?? '', e.docRef ?? '', e.by, e.at, e.source]),
  ]);
}

/**
 * Supplier passport: one product-carbon-footprint record per product, in a shape modelled on
 * WBCSD PACT (Pathfinder) data exchange. Fill once, share with every OEM portal that accepts it.
 * Gate-to-gate (Scope 1 + 2 of this plant) only; upstream steel is flagged as excluded.
 */
export function passportJSON(c: ReturnType<typeof canonical>, dqAvg: number) {
  return {
    format: 'pact-inspired-pcf (prototype; not certified)',
    id: `pcf-${c.supplier.oem_vendor_code}-${c.period.to}`,
    companyName: c.supplier.name,
    productDescription: c.months[0]?.output.unit ?? 'unit',
    declaredUnit: 'piece',
    pcf: {
      boundary: 'gate-to-gate (plant Scope 1 + 2)',
      excludedEmissions: 'Purchased steel and other upstream materials (Scope 3) not yet included',
      pCfExcludingBiogenic_kgCO2e_per_unit: c.totals.kgco2e_per_unit,
      referencePeriodStart: c.period.from,
      referencePeriodEnd: c.period.to,
      crossSectoralStandardsUsed: ['GHG Protocol Corporate Standard'],
      emissionFactorSources: c.factors_used.map((f) => `${f.code} v${f.version}: ${f.source}`),
      primaryDataShare: 100,
      dataQualityScore_0_100: Math.round(dqAvg),
      assurance: 'none (self-declared; verifier share available)',
    },
    status: 'Active',
    version: 1,
  };
}

export function lenderPack(c: ReturnType<typeof canonical>, portfolio: { capex: number; savingInr: number; co2t: number; payback: number }, tariff: number, dqAvg: number) {
  return {
    title: 'Green-loan readiness pack',
    supplier: c.supplier.name, plant: c.plant, period: c.period,
    baseline: { kgco2e_per_unit: c.totals.kgco2e_per_unit, total_t: c.totals.total_t, effective_tariff_inr_per_kwh: round(tariff, 2) },
    proposed_measures: { capex_inr: portfolio.capex, saving_inr_per_yr: Math.round(portfolio.savingInr), co2_t_per_yr: round(portfolio.co2t, 1), simple_payback_yr: round(portfolio.payback, 1) },
    data_quality_avg: Math.round(dqAvg),
    mv_method: 'Post-implementation months compared with baseline adjusted for output (kWh = a + b × output).',
  };
}
