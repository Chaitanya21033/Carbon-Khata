import type { MeasureAssessment } from './types';

/** Measures library (demo inputs). Savings always use the plant's own tariff from its bills. */
export const MEASURE_SEED: MeasureAssessment[] = [
  { code: 'APFC', name: 'Automatic power-factor correction panel', nameHi: 'ऑटोमैटिक पावर-फ़ैक्टर पैनल', kwhPerYr: 48000, extraInrPerYr: 65000, capexInr: 140000, co2Counted: false, status: 'accepted', note: 'kVAh billing: better PF cuts billed energy and demand charge. Cost saving only.' },
  { code: 'LED', name: 'LED high-bay retrofit', nameHi: 'एलईडी हाई-बे लाइट', kwhPerYr: 160000, extraInrPerYr: 0, capexInr: 1100000, co2Counted: true, status: 'suggested', note: 'Fixtures × (old W − new W) × operating hours.' },
  { code: 'VFD', name: 'Variable-frequency drives (compressor, pumps, fans)', nameHi: 'वीएफडी (कंप्रेसर, पंप, पंखे)', kwhPerYr: 150000, extraInrPerYr: 0, capexInr: 750000, co2Counted: true, status: 'suggested', note: 'Motor kWh × 25–35% at part load.' },
  { code: 'SOLAR', name: 'Rooftop solar, 120 kW', nameHi: 'रूफ़टॉप सोलर, 120 kW', kwhPerYr: 120 * 4.5 * 365, extraInrPerYr: 0, capexInr: 5400000, co2Counted: true, status: 'in_progress', note: '120 kW × 4.5 kWh/kW/day × 365.' },
];

export function evaluate(m: MeasureAssessment, tariff: number, gridEf: number) {
  const savingInr = m.kwhPerYr * tariff + m.extraInrPerYr;
  const co2t = m.co2Counted ? (m.kwhPerYr * gridEf) / 1000 : 0;
  return { savingInr, co2t, payback: savingInr ? m.capexInr / savingInr : Infinity };
}

export function portfolio(ms: MeasureAssessment[], tariff: number, gridEf: number) {
  const active = ms.filter((m) => m.status !== 'rejected');
  const rows = active.map((m) => ({ m, ...evaluate(m, tariff, gridEf) }));
  const capex = rows.reduce((s, r) => s + r.m.capexInr, 0);
  const savingInr = rows.reduce((s, r) => s + r.savingInr, 0);
  const co2t = rows.reduce((s, r) => s + r.co2t, 0);
  return { rows, capex, savingInr, co2t, payback: savingInr ? capex / savingInr : Infinity };
}
