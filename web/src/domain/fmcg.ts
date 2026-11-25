// FMCG batch tracing types and display helpers. Batches, release gate and recall are evaluated by the API.
// Original note: (co-packer) making biscuits and snacks for two
// brand owners. Batches are a pure function of the simulation clock, so the list grows live as the sim runs.
// Every ingredient lot, test result, carbon figure and brand here is invented.

export const CO_PACKER = { name: 'Annapurna Foods (co-packer)', plant: 'Unit 1 · Jamshedpur cluster', fssai: 'FSSAI Lic. 1002XXXXXXXXXX (demo)' };
export type BrandId = 'A' | 'B';
export const BRANDS: Record<BrandId, { name: string; color: string }> = {
  A: { name: 'Brand A Foods', color: '#C2410C' },
  B: { name: 'Brand B Nutrition', color: '#1D5FA8' },
};

export type Material = 'flour' | 'oats' | 'sugar' | 'oil' | 'spice' | 'salt' | 'film';
export const MATERIALS: Record<Material, { name: string; supplier: string; prefix: string; every: number; kgCo2PerKg: number; coa: string }> = {
  flour: { name: 'Wheat flour (maida)', supplier: 'Shree Roller Flour Mill', prefix: 'WF', every: 6, kgCo2PerKg: 0.55, coa: 'Moisture ≤ 14%, gluten 9–11%' },
  oats: { name: 'Rolled oats', supplier: 'Himgiri Agro', prefix: 'OT', every: 9, kgCo2PerKg: 0.7, coa: 'Moisture ≤ 12%, foreign matter nil' },
  sugar: { name: 'Sugar (S-30)', supplier: 'Kosi Sugar Mills', prefix: 'SG', every: 10, kgCo2PerKg: 0.8, coa: 'ICUMSA ≤ 150, moisture ≤ 0.1%' },
  oil: { name: 'Palm oil (RBD)', supplier: 'Coastal Edible Oils', prefix: 'PO', every: 8, kgCo2PerKg: 3.0, coa: 'FFA ≤ 0.1%, peroxide ≤ 1 meq/kg' },
  spice: { name: 'Masala seasoning', supplier: 'Spice Route Blends', prefix: 'MS', every: 12, kgCo2PerKg: 1.0, coa: 'Salmonella absent / 25 g, aflatoxin ≤ 10 ppb' },
  salt: { name: 'Iodised salt', supplier: 'Sambhar Salts', prefix: 'SL', every: 20, kgCo2PerKg: 0.2, coa: 'Iodine ≥ 15 ppm' },
  film: { name: 'Laminated pack film', supplier: 'Flexi Pack Industries', prefix: 'PF', every: 15, kgCo2PerKg: 3.5, coa: 'Seal strength ≥ 1.5 N/15 mm, migration within limits' },
};

export interface Product { id: string; name: string; brand: BrandId; packG: number; packs: number; filmG: number; shelfDays: number; recipe: Partial<Record<Material, number>>; mrp: number }
export const PRODUCTS: Product[] = [
  { id: 'MC50', name: 'Masala Crunch 50 g', brand: 'A', packG: 50, packs: 12000, filmG: 2.2, shelfDays: 180, recipe: { flour: 0.62, oil: 0.24, spice: 0.06, sugar: 0.06, salt: 0.02 }, mrp: 10 },
  { id: 'GB100', name: 'Glucose Biscuit 100 g', brand: 'A', packG: 100, packs: 7000, filmG: 3.5, shelfDays: 270, recipe: { flour: 0.65, sugar: 0.25, oil: 0.1 }, mrp: 10 },
  { id: 'OD200', name: 'Oat Digestive 200 g', brand: 'B', packG: 200, packs: 4000, filmG: 6, shelfDays: 240, recipe: { flour: 0.45, oats: 0.2, sugar: 0.2, oil: 0.15 }, mrp: 50 },
];

export const DISTRIBUTORS = ['Ranchi Distributors', 'Kolkata Central Depot', 'Bhubaneswar Traders', 'Patna FMCG Hub', 'Dhanbad Supply Co.'];

export type TestStatus = 'pass' | 'fail' | 'pending';
export interface QcTest { stage: 'in-process' | 'final' | 'lab'; name: string; spec: string; value: string; status: TestStatus; by: string; at: number }
export interface LotUse { lot: string; material: Material; kg: number }
export type BatchStatus = 'in_production' | 'qc_pending' | 'released' | 'held' | 'recalled';
export interface Batch {
  publicCode?: string;
  id: string; index: number; product: Product; line: 'L1' | 'L2'; start: number; end: number; microAt: number;
  status: BatchStatus; holdReason?: string; tests: QcTest[]; lots: LotUse[]; outputKg: number; inputKg: number; yieldPct: number;
  kwh: number; lpgKg: number; carbon: { ingredients: number; packaging: number; energy: number; perPackG: number }; renewableShare: number;
  dispatch: { to: string; packs: number }[]; mfg: string; exp: string;
}

/** Lots appearing in the given batches, with the batches that used each. */
export function lotIndex(batches: Batch[]) {
  const m = new Map<string, { lot: string; material: Material; batches: Batch[]; kg: number }>();
  for (const b of batches) for (const l of b.lots) {
    const e = m.get(l.lot) ?? { lot: l.lot, material: l.material, batches: [], kg: 0 };
    e.batches.push(b); e.kg += l.kg; m.set(l.lot, e);
  }
  return [...m.values()].sort((a, b) => a.material.localeCompare(b.material) || b.lot.localeCompare(a.lot));
}

/** Stable fingerprint of what the pack page shows: if any value is edited, the fingerprint changes. */
export function batchRecord(b: Batch) {
  return JSON.stringify({ id: b.id, product: b.product.id, mfg: b.mfg, exp: b.exp, tests: b.tests.map((t) => [t.name, t.value, t.status]), lots: b.lots.map((l) => [l.lot, l.kg]), carbon: Math.round(b.carbon.perPackG) });
}
