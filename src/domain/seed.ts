import factorsJson from '../data/emission_factors.json';
import type { EmissionFactor, LedgerEntry, LineType, Register } from './types';
import { CONTRACT_KVA, OPEN_MONTH, synthHistory, synthOpenMonthDays } from './synth';

/** Fictional demo company. All data is generated in synth.ts. */
export const PLANT = {
  tenant: 'Vardhan Body Works Pvt. Ltd.',
  plant: 'Unit 2 · Jamshedpur cluster',
  product: { name: 'Tipper body', nameHi: 'टिपर बॉडी', unit: 'nos' },
  contractDemandKva: CONTRACT_KVA,
  utility: 'State DISCOM',
  oem: 'Demo OEM (CV division)',
  udyam: 'UDYAM-JH-00-0000000',
};

const IMPORT_BY = 'Field associate (history import)';
const IMPORT_AT = '2026-11-02T10:00:00.000Z';

type Def = Omit<Register, 'id'> & { col?: string };

export const ISSUE_ONLY: Def[] = [
  { code: 'DIESEL', label: 'Diesel (HSD)', labelHi: 'डीज़ल', unit: 'L', category: 'fuel', mode: 'issue_only', factorCode: 'EF_DIESEL', col: 'diesel_l' },
  { code: 'HR_SHEET', label: 'HR steel sheet', labelHi: 'एचआर स्टील शीट', unit: 'kg', category: 'material', mode: 'issue_only', col: 'hr_sheet_kg' },
  { code: 'TUBE', label: 'Tube / angle', labelHi: 'ट्यूब / एंगल', unit: 'kg', category: 'material', mode: 'issue_only', col: 'tube_angle_kg' },
  { code: 'BAR', label: 'Bar / angle', labelHi: 'बार / एंगल', unit: 'kg', category: 'material', mode: 'issue_only', col: 'bar_angle_kg' },
  { code: 'PAINT', label: 'Paint', labelHi: 'पेंट', unit: 'L', category: 'consumable', mode: 'issue_only', col: 'paint_l' },
  { code: 'MIG_WIRE', label: 'MIG welding wire', labelHi: 'मिग वेल्डिंग तार', unit: 'kg', category: 'consumable', mode: 'issue_only', col: 'mig_wire_kg' },
  { code: 'THINNER', label: 'Thinner', labelHi: 'थिनर', unit: 'L', category: 'consumable', mode: 'issue_only', col: 'thinner_l' },
  { code: 'HARDENER', label: 'Hardener', labelHi: 'हार्डनर', unit: 'L', category: 'consumable', mode: 'issue_only', col: 'hardener_l' },
  { code: 'SHOT', label: 'Steel shot', labelHi: 'स्टील शॉट', unit: 'kg', category: 'consumable', mode: 'issue_only', col: 'steel_shots_kg' },
  { code: 'GRIT', label: 'Steel grit', labelHi: 'स्टील ग्रिट', unit: 'kg', category: 'consumable', mode: 'issue_only', col: 'steel_grits_kg' },
  { code: 'GREASE', label: 'Grease', labelHi: 'ग्रीस', unit: 'kg', category: 'consumable', mode: 'issue_only', col: 'grease_kg' },
  { code: 'WATER_SUPPLY', label: 'Water, supply', labelHi: 'पानी, सप्लाई', unit: 'L', category: 'water', mode: 'issue_only', col: 'water_supply_l' },
  { code: 'WATER_BORE', label: 'Water, borewell', labelHi: 'पानी, बोरवेल', unit: 'L', category: 'water', mode: 'issue_only', col: 'water_bore_l' },
  { code: 'CHEM_BRA', label: 'Brightener A', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'brightener_a_l' },
  { code: 'CHEM_BRB1', label: 'Brightener B1', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'brightener_b1_l' },
  { code: 'CHEM_BRB2', label: 'Brightener B2', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'brightener_b2_l' },
  { code: 'CHEM_COND', label: 'Conditioner', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'conditioner_l' },
  { code: 'CHEM_NCZ', label: 'NCZ-106 salt', unit: 'kg', category: 'chemical', mode: 'issue_only', col: 'ncz106_salt_kg' },
  { code: 'CHEM_HCL', label: 'Hydrochloric acid', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'hydrochloric_acid_l' },
  { code: 'CHEM_HNO3', label: 'Nitric acid', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'nitric_acid_l' },
  { code: 'CHEM_NAOH', label: 'Caustic soda', unit: 'kg', category: 'chemical', mode: 'issue_only', col: 'caustic_soda_kg' },
  { code: 'CHEM_ZN', label: 'Zinc ingot', unit: 'kg', category: 'chemical', mode: 'issue_only', col: 'zinc_ingot_kg' },
  { code: 'CHEM_GTX', label: 'Ginthox 982L', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'ginthox_982l_l' },
  { code: 'CHEM_DW', label: 'Distilled water', unit: 'L', category: 'chemical', mode: 'issue_only', col: 'distilled_water_l' },
  { code: 'SCRAP_HR', label: 'HR sheet scrap', labelHi: 'एचआर शीट स्क्रैप', unit: 'kg', category: 'scrap', mode: 'issue_only', col: 'hr_sheet_scrap_kg' },
  { code: 'SCRAP_TUBE', label: 'Tube scrap', labelHi: 'ट्यूब स्क्रैप', unit: 'kg', category: 'scrap', mode: 'issue_only', col: 'tube_scrap_kg' },
  { code: 'SCRAP_PLASMA', label: 'Plasma scrap', unit: 'kg', category: 'scrap', mode: 'issue_only', col: 'plasma_scrap_kg' },
  { code: 'SCRAP_SHOT', label: 'Shot / grit scrap', unit: 'kg', category: 'scrap', mode: 'issue_only', col: 'shot_grit_scrap_kg' },
  { code: 'SLAG', label: 'Plasma slag', unit: 'kg', category: 'scrap', mode: 'issue_only', col: 'plasma_slag_kg' },
  { code: 'SLUDGE', label: 'Paint sludge (hazardous)', labelHi: 'पेंट कीचड़ (खतरनाक)', unit: 'kg', category: 'waste', mode: 'issue_only', col: 'paint_sludge_kg' },
];

export const FULL: (Def & { prefix: string; csv: 'full' })[] = [
  { code: 'HYD_OIL', label: 'Hydraulic oil', labelHi: 'हाइड्रॉलिक तेल', unit: 'L', category: 'consumable', mode: 'full', prefix: '', csv: 'full' },
  { code: 'CO2_GAS', label: 'CO₂ welding gas', labelHi: 'CO₂ वेल्डिंग गैस', unit: 'kg', category: 'gas', mode: 'full', factorCode: 'EF_CO2_PROCESS', conversion: { unitLabel: 'cylinder', factor: 30 }, prefix: 'co2_kg', csv: 'full' },
  { code: 'LPG', label: 'LPG', labelHi: 'एलपीजी', unit: 'kg', category: 'fuel', mode: 'full', factorCode: 'EF_LPG', conversion: { unitLabel: 'cylinder', factor: 19 }, prefix: 'lpg_kg', csv: 'full' },
  { code: 'OXYGEN', label: 'Oxygen', labelHi: 'ऑक्सीजन', unit: 'm³', category: 'gas', mode: 'full', conversion: { unitLabel: 'cylinder', factor: 7 }, prefix: 'oxygen', csv: 'full' },
  { code: 'ARGON', label: 'Argon', labelHi: 'आर्गन', unit: 'm³', category: 'gas', mode: 'full', prefix: 'argon_m3', csv: 'full' },
];

export const READINGS: Def[] = [
  { code: 'PROD', label: 'Tipper bodies produced', labelHi: 'बनी टिपर बॉडी', unit: 'nos', category: 'production', mode: 'reading', required: true },
  { code: 'GRID_KWH', label: 'Grid electricity', labelHi: 'ग्रिड बिजली', unit: 'kWh', category: 'utility', mode: 'reading', required: true, factorCode: 'EF_GRID_IN' },
  { code: 'GRID_KVAH', label: 'Grid apparent energy', labelHi: 'ग्रिड kVAh', unit: 'kVAh', category: 'utility', mode: 'reading' },
  { code: 'PF', label: 'Power factor', labelHi: 'पावर फ़ैक्टर', unit: '', category: 'utility', mode: 'reading', required: true },
  { code: 'MD_KVA', label: 'Maximum demand', labelHi: 'अधिकतम मांग', unit: 'kVA', category: 'utility', mode: 'reading' },
  { code: 'SOLAR_KWH', label: 'Rooftop solar generation', labelHi: 'रूफ़टॉप सोलर उत्पादन', unit: 'kWh', category: 'utility', mode: 'reading', factorCode: 'EF_SOLAR_SELF' },
  { code: 'GREEN_OA_KWH', label: 'Green open-access power', labelHi: 'ग्रीन ओपन-एक्सेस बिजली', unit: 'kWh', category: 'utility', mode: 'reading', factorCode: 'EF_GREEN_OA' },
  { code: 'GRID_EXPORT_KWH', label: 'Power exported to grid', labelHi: 'ग्रिड को बेची बिजली', unit: 'kWh', category: 'utility', mode: 'reading' },
  { code: 'GENSET_GAS_SCM', label: 'Gas genset fuel (natural gas)', labelHi: 'गैस जेनसेट ईंधन', unit: 'scm', category: 'fuel', mode: 'reading', factorCode: 'EF_PNG' },
  { code: 'BILL_INR', label: 'Electricity bill', labelHi: 'बिजली बिल', unit: '₹', category: 'utility', mode: 'reading', required: true },
];

export const FACTORS: EmissionFactor[] = (factorsJson as unknown as { factors: EmissionFactor[] }).factors;

export interface Seed {
  registers: Register[];
  entries: LedgerEntry[];
  plantMonths: string[];
  billMonths: string[];
}

let n = 0;
function entry(registerId: string, month: string, line: LineType, qty: number, source: LedgerEntry['source'] = 'import'): LedgerEntry {
  n++;
  return { id: `seed_${n}`, registerId, month, line, qty, status: 'posted', by: IMPORT_BY, at: IMPORT_AT, source, docRef: `IMPORT-${registerId}-${month}-${line}` };
}

export function buildSeed(): Seed {
  n = 0;
  const h = synthHistory();
  const registers: Register[] = [];
  const entries: LedgerEntry[] = [];

  for (const d of READINGS) registers.push({ ...d, id: d.code });
  for (const d of FULL) {
    const { prefix: _p, csv: _c, ...rest } = d;
    registers.push({ ...rest, id: d.code });
  }
  for (const d of ISSUE_ONLY) {
    const { col: _c, ...rest } = d;
    registers.push({ ...rest, id: d.code });
  }

  h.months.forEach((m, i) => {
    const row = h.rows[i];
    entries.push(entry('PROD', m, 'reading', row.bodies_produced!));
    const map: [string, string][] = [['GRID_KWH', 'grid_kwh'], ['GRID_KVAH', 'grid_kvah'], ['PF', 'power_factor'], ['MD_KVA', 'max_demand_kva'], ['BILL_INR', 'bill_inr']];
    for (const [reg, col] of map) if (row[col] !== undefined) entries.push(entry(reg, m, 'reading', row[col]!, 'bill'));
    for (const d of FULL) {
      const l = h.full[d.code][i];
      for (const line of ['opening', 'received', 'issued', 'closing'] as const) entries.push(entry(d.code, m, line, l[line]));
    }
    for (const d of ISSUE_ONLY) if (row[d.col!] !== undefined) entries.push(entry(d.code, m, 'issued', row[d.col!]!));
  });

  // Open month: days 1–9 already captured on the shop floor before the live demo starts.
  const last = h.months.length - 1;
  for (const d of FULL) entries.push({ ...entry(d.code, OPEN_MONTH, 'opening', Math.max(0, h.full[d.code][last].closing)), source: 'app', by: 'System (carry-forward)', reason: 'Carry-forward from previous closing', docRef: undefined });
  entries.push({ ...entry('CO2_GAS', OPEN_MONTH, 'received', 3000), source: 'app', by: 'Stores', docRef: 'GRN-2611-014' });
  entries.push({ ...entry('LPG', OPEN_MONTH, 'received', 380), source: 'app', by: 'Stores', docRef: 'GRN-2611-015' });
  for (const day of synthOpenMonthDays(h)) {
    const at = `2026-11-${String(day.day).padStart(2, '0')}T18:00:00.000Z`;
    const tag = (reg: string) => `${reg}-2611${String(day.day).padStart(2, '0')}-D`;
    const add = (reg: string, line: LineType, qty: number, by: string, source: LedgerEntry['source'] = 'app') => {
      if (qty > 0) entries.push({ ...entry(reg, OPEN_MONTH, line, qty, source), at, by, docRef: tag(reg) });
    };
    add('PROD', 'reading', day.bodies, 'Line supervisor');
    // EMS live since 1 Nov: solar, green open access and the gas genset cover part of the load.
    const sunday = day.bodies === 0;
    const solar = Math.round(1350 + ((day.day * 37) % 9) * 40 - (day.day === 4 ? 700 : 0));
    const green = sunday ? 600 : 1900 + ((day.day * 53) % 7) * 30;
    const genKwh = sunday ? 0 : 1050 + ((day.day * 29) % 5) * 40;
    add('GRID_KWH', 'reading', Math.max(400, day.kwh - solar - green - genKwh + 140), 'Meter gateway', 'meter');
    add('SOLAR_KWH', 'reading', solar, 'EMS gateway', 'meter');
    add('GREEN_OA_KWH', 'reading', green, 'EMS gateway', 'meter');
    add('GENSET_GAS_SCM', 'reading', Math.round(genKwh / 3.3), 'EMS gateway', 'meter');
    add('GRID_EXPORT_KWH', 'reading', sunday ? 520 : 140, 'EMS gateway', 'meter');
    add('DIESEL', 'issued', day.diesel, 'Stores');
    add('HR_SHEET', 'issued', day.hr, 'Stores');
    add('PAINT', 'issued', day.paint, 'Paint shop');
    add('CO2_GAS', 'issued', day.co2, 'Stores');
    add('LPG', 'issued', day.lpg, 'Stores');
    add('HYD_OIL', 'issued', day.hyd, 'Stores');
  }
  return { registers, entries, plantMonths: h.months, billMonths: h.months };
}
