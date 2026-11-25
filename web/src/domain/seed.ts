// Plant identity comes from the API (workspace.plant); this live binding is updated when the workspace loads.
import type { Register } from './types';

export let PLANT = {
  tenant: '—', plant: '—', product: { name: 'Tipper body', nameHi: 'टिपर बॉडी', unit: 'nos' }, contractDemandKva: 450, utility: 'State DISCOM', oem: '', udyam: '', gstin: '',
};
export function setPlant(p: Partial<typeof PLANT> | null) { if (p) PLANT = { ...PLANT, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)) }; }

type Def = Omit<Register, 'id'> & { col?: string };
/** Register catalogue used by the onboarding mapping step (CSV column → register). */
export const ISSUE_ONLY: Def[] = [
  { code: 'DIESEL', label: 'Diesel (HSD)', unit: 'L', category: 'fuel', mode: 'issue_only', factorCode: 'EF_DIESEL', col: 'diesel_l' },
  { code: 'HR_SHEET', label: 'HR steel sheet', unit: 'kg', category: 'material', mode: 'issue_only', col: 'hr_sheet_kg' },
  { code: 'TUBE', label: 'Tube / angle', unit: 'kg', category: 'material', mode: 'issue_only', col: 'tube_angle_kg' },
  { code: 'PAINT', label: 'Paint', unit: 'L', category: 'consumable', mode: 'issue_only', col: 'paint_l' },
  { code: 'MIG_WIRE', label: 'MIG welding wire', unit: 'kg', category: 'consumable', mode: 'issue_only', col: 'mig_wire_kg' },
  { code: 'WATER_SUPPLY', label: 'Water, supply', unit: 'L', category: 'water', mode: 'issue_only', col: 'water_supply_l' },
  { code: 'WATER_BORE', label: 'Water, borewell', unit: 'L', category: 'water', mode: 'issue_only', col: 'water_bore_l' },
  { code: 'SCRAP_HR', label: 'HR sheet scrap', unit: 'kg', category: 'scrap', mode: 'issue_only', col: 'hr_sheet_scrap_kg' },
  { code: 'SLUDGE', label: 'Paint sludge (hazardous)', unit: 'kg', category: 'waste', mode: 'issue_only', col: 'paint_sludge_kg' },
];
export let FACTORS: import('./types').EmissionFactor[] = [];
export function setFactors(f: import('./types').EmissionFactor[]) { FACTORS = f; }
