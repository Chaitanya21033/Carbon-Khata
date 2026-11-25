// FMCG batch tracing for a fictional contract manufacturer (co-packer) making biscuits and snacks for two
// brand owners. Batches are a pure function of the simulation clock, so the list grows live as the sim runs.
// Every ingredient lot, test result, carbon figure and brand here is invented.
import { rng } from './synth';

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
  id: string; index: number; product: Product; line: 'L1' | 'L2'; start: number; end: number; microAt: number;
  status: BatchStatus; holdReason?: string; tests: QcTest[]; lots: LotUse[]; outputKg: number; inputKg: number; yieldPct: number;
  kwh: number; lpgKg: number; carbon: { ingredients: number; packaging: number; energy: number; perPackG: number }; renewableShare: number;
  dispatch: { to: string; packs: number }[]; mfg: string; exp: string;
}

export const T0 = Date.UTC(2026, 10, 9, 0, 30); // first batch slot (06:00 IST)
const SLOT_MIN = 120;      // a new batch every 2 h, alternating lines
const RUN_MIN = 150;       // production run length
const MICRO_MIN = 8 * 60;  // rapid microbiology result after the run

/** Batch slots run 06:00–21:59 IST each day (00:30–16:29 UTC). */
function slotStart(i: number) {
  const perDay = 8;
  const day = Math.floor(i / perDay), k = i % perDay;
  return T0 + day * 864e5 + k * SLOT_MIN * 60_000;
}
export const lotId = (m: Material, n: number) => `${MATERIALS[m].prefix}-${String(2600 + n).padStart(4, '0')}`;
const fmtDate = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
const ist = (t: number) => new Date(t + 5.5 * 3600_000);

export function buildBatch(i: number, clock: number, recalledLots: Set<string>, energyEf: number, renewableShare: number, overrides: Record<string, TestStatus>): Batch {
  const r = rng(5000 + i * 17);
  const product = PRODUCTS[i % 3];
  const start = slotStart(i), end = start + RUN_MIN * 60_000, microAt = end + MICRO_MIN * 60_000;
  const d = ist(start);
  const id = `B${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String((i % 8) + 1).padStart(2, '0')}`;
  const outputKg = (product.packs * product.packG) / 1000;
  const yieldPct = 95 + r.next() * 2.5;
  const inputKg = outputKg / (yieldPct / 100);
  const lots: LotUse[] = (Object.entries(product.recipe) as [Material, number][]).map(([m, share]) => ({ lot: lotId(m, Math.floor(i / MATERIALS[m].every)), material: m, kg: +(inputKg * share).toFixed(1) }));
  lots.push({ lot: lotId('film', Math.floor(i / MATERIALS.film.every)), material: 'film', kg: +((product.packs * product.filmG) / 1000 * 1.03).toFixed(1) });

  // ---- QC tests (deterministic; some batches fail on purpose to show the release gate) ----
  const fillFail = i % 13 === 5, moistFail = i % 17 === 9;
  const fillMean = product.packG + (fillFail ? -1.4 : 0.6 + r.next() * 1.2);
  const moisture = moistFail ? 3.4 : 1.9 + r.next() * 0.8;
  const tpc = Math.round(800 + r.next() * 3200);
  const t = (stage: QcTest['stage'], name: string, spec: string, value: string, ok: boolean, by: string, at: number): QcTest => {
    const key = `${id}|${name}`;
    const pending = clock < at;
    return { stage, name, spec, value: pending ? '—' : value, status: overrides[key] ?? (pending ? 'pending' : ok ? 'pass' : 'fail'), by, at };
  };
  const mid = start + RUN_MIN * 30_000;
  const tests: QcTest[] = [
    t('in-process', 'Dough moisture', '18–22 %', `${(19 + r.next() * 2).toFixed(1)} %`, true, 'Line QC', start + 20 * 60_000),
    t('in-process', 'Oven exit temperature', '180–200 °C', `${Math.round(186 + r.next() * 8)} °C`, true, 'Oven sensor', mid),
    t('in-process', 'Metal detection (Fe 1.5 mm, SS 2.5 mm)', 'All rejects isolated', 'Pass · test pieces rejected', true, 'Metal detector', mid),
    t('final', 'Product moisture', '≤ 3.0 %', `${moisture.toFixed(1)} %`, !moistFail, 'QC lab', end),
    t('final', 'Fill weight (mean of 30 packs)', `≥ ${product.packG} g declared`, `${fillMean.toFixed(1)} g`, !fillFail, 'Checkweigher', end),
    t('final', 'Seal integrity (dye / pressure)', 'No leaks in 20 packs', '0 / 20 leaks', true, 'QC lab', end),
    t('final', 'Label & batch code check', 'Batch, MFG, EXP, MRP legible', 'OK', true, 'Line QC', end),
    t('lab', 'Total plate count', '≤ 10,000 cfu/g', `${tpc.toLocaleString('en-IN')} cfu/g`, true, 'Micro lab (rapid)', microAt),
    t('lab', 'Yeast & mould', '≤ 100 cfu/g', `${Math.round(10 + r.next() * 40)} cfu/g`, true, 'Micro lab (rapid)', microAt),
  ];
  const failed = tests.filter((x) => x.status === 'fail');
  const pending = tests.filter((x) => x.status === 'pending');
  const recalledLot = lots.find((l) => recalledLots.has(l.lot));
  let status: BatchStatus = clock < end ? 'in_production' : failed.length ? 'held' : pending.length ? 'qc_pending' : 'released';
  if (recalledLot && status !== 'in_production') status = 'recalled';
  const holdReason = recalledLot ? `Ingredient lot ${recalledLot.lot} flagged` : failed.length ? `Failed: ${failed.map((f) => f.name).join(', ')}` : undefined;

  // ---- carbon per pack (illustrative factors) ----
  const ing = lots.filter((l) => l.material !== 'film').reduce((s, l) => s + l.kg * MATERIALS[l.material].kgCo2PerKg, 0);
  const pack = lots.filter((l) => l.material === 'film').reduce((s, l) => s + l.kg * MATERIALS.film.kgCo2PerKg, 0);
  const kwh = outputKg * 0.35, lpgKg = outputKg * 0.06;
  const energy = kwh * energyEf + lpgKg * 2.98;
  const perPackG = ((ing + pack + energy) / product.packs) * 1000;

  // ---- dispatch (only released batches ship) ----
  const dispatch: Batch['dispatch'] = [];
  if (status === 'released' || status === 'recalled') {
    let left = product.packs;
    const n = 2 + (i % 3);
    for (let k = 0; k < n; k++) { const p = k === n - 1 ? left : Math.round(product.packs / n); dispatch.push({ to: DISTRIBUTORS[(i + k) % DISTRIBUTORS.length], packs: p }); left -= p; }
  }
  return { id, index: i, product, line: i % 2 ? 'L2' : 'L1', start, end, microAt, status, holdReason, tests, lots, outputKg, inputKg, yieldPct, kwh, lpgKg, carbon: { ingredients: ing, packaging: pack, energy, perPackG }, renewableShare, dispatch, mfg: fmtDate(start), exp: fmtDate(start + product.shelfDays * 864e5) };
}

export function batchesUpTo(clock: number, recalledLots: Set<string>, energyEf: number, renewableShare: number, overrides: Record<string, TestStatus>, max = 48): Batch[] {
  const out: Batch[] = [];
  for (let i = 0; i < 5000; i++) {
    const s = slotStart(i);
    if (s > clock) break;
    out.push(buildBatch(i, clock, recalledLots, energyEf, renewableShare, overrides));
  }
  return out.slice(-max).reverse();
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
