// Acceptance tests (HANDOFF §17 adapted to the dummy dataset). The generator plants known
// data-entry mistakes; these tests prove the engine finds exactly those and computes the
// carbon ledger correctly against the generator's ground truth.
import { describe, expect, it } from 'vitest';
import { buildSeed, FACTORS, PLANT } from '../seed';
import { PLANTED, synthHistory, TRUE_A, TRUE_B } from '../synth';
import { balance, buildIndex, correctLine, postEntry, value } from '../ledger';
import { runValidation, dqScore } from '../validation';
import { baseLoad, effectiveTariff, monthEmissions, periodTotals } from '../emissions';
import { MEASURE_SEED, portfolio } from '../measures';
import type { LedgerEntry } from '../types';

const seed = buildSeed();
const h = synthHistory();
const M = h.months;
const ctx = (entries = seed.entries) => ({ registers: seed.registers, idx: buildIndex(entries), plantMonths: seed.plantMonths, billMonths: seed.billMonths, contractDemandKva: PLANT.contractDemandKva });
const hits = (rule: string, reg?: string) => runValidation(ctx()).filter((i) => i.rule === rule && (!reg || i.registerId === reg)).map((i) => i.month).sort();

describe('T1 import', () => {
  it('24 plant-months with the generated output', () => {
    const idx = buildIndex(seed.entries);
    expect(seed.plantMonths).toHaveLength(24);
    const total = M.reduce((s, m) => s + (value(idx, 'PROD', m, 'reading') ?? 0), 0);
    expect(total).toBe(h.truth.units.reduce((a, b) => a + b, 0));
  });
});

describe('T2 validation finds every planted mistake and nothing else', () => {
  it('V01 extra zero: steel and bill', () => {
    expect(hits('V01')).toEqual([M[PLANTED.hrSheetExtraZero], M[PLANTED.billExtraZero]].sort());
  });
  it('V02 missing digit: steel', () => expect(hits('V02')).toEqual([M[PLANTED.hrSheetMissingDigit]]));
  it('V03 flat-lined water and chemicals', () => {
    const regs = runValidation(ctx()).filter((i) => i.rule === 'V03').map((i) => i.registerId).sort();
    expect(regs).toEqual(['CHEM_COND', 'CHEM_DW', 'CHEM_GTX', 'CHEM_HNO3', 'WATER_SUPPLY']);
  });
  it('V04 power factor missing', () => expect(hits('V04', 'PF')).toEqual([M[PLANTED.pfMissing]]));
  it('V05 hydraulic oil does not balance', () => {
    expect(hits('V05', 'HYD_OIL')).toEqual([...PLANTED.hydClosingWrong, PLANTED.hydOverIssue].map((i) => M[i]).sort());
  });
  it('V07 bill arithmetic', () => expect(hits('V07')).toEqual([M[PLANTED.billExtraZero]]));
  it('V09 intensity outlier in the shutdown month', () => expect(hits('V09')).toEqual([M[PLANTED.lowOutputMonth]]));
  it('V12 negative stock', () => expect(hits('V12', 'HYD_OIL')).toEqual([M[PLANTED.hydOverIssue]]));
  it('V06 matches months above contract demand', () => {
    const expected = M.filter((_, i) => (h.rows[i].max_demand_kva ?? 0) > PLANT.contractDemandKva);
    expect(hits('V06')).toEqual(expected);
  });
});

describe('T3 gas registers balance', () => {
  it('zero V05 across 96 lines', () => {
    const idx = buildIndex(seed.entries);
    let lines = 0;
    for (const reg of ['OXYGEN', 'CO2_GAS', 'LPG', 'ARGON']) for (const m of M) {
      const b = balance(idx, reg, m);
      if (b.calc !== undefined) { lines++; expect(b.ok).toBe(true); }
    }
    expect(lines).toBe(96);
  });
});

describe('T4 emissions equal activity × factor', () => {
  it('totals match an independent calculation within 0.1 t', () => {
    const idx = buildIndex(seed.entries);
    const t = periodTotals(M.map((m) => monthEmissions(seed.registers, idx, FACTORS, m)));
    const kwh = h.truth.kwh.reduce((a, b) => a + b, 0);
    const diesel = h.rows.reduce((s, r) => s + r.diesel_l!, 0);
    const lpg = h.full.LPG.reduce((s, l) => s + l.issued, 0);
    const co2 = h.full.CO2_GAS.reduce((s, l) => s + l.issued, 0);
    const expected = (kwh * 0.71 + diesel * 2.68 + lpg * 2.98 + co2) / 1000;
    expect(Math.abs(t.total / 1000 - expected)).toBeLessThan(0.1);
    expect(t.intensity).toBeCloseTo((expected * 1000) / t.output, 6);
  });
});

describe('T5 tariff after correcting the planted bill', () => {
  it('equals the true tariff', () => {
    const i = PLANTED.billExtraZero;
    const { entries } = correctLine(seed.entries, 'BILL_INR', M[i], 'reading', h.truth.bill[i], 'Extra zero typed', 'test');
    const truth = h.truth.bill.reduce((a, b) => a + b, 0) / h.truth.kwh.reduce((a, b) => a + b, 0);
    expect(effectiveTariff(buildIndex(entries), M)).toBeCloseTo(truth, 6);
    expect(effectiveTariff(buildIndex(seed.entries), M)).toBeGreaterThan(truth * 1.3);
  });
});

describe('T6 base-load fit recovers the generator', () => {
  it('a and b within noise', () => {
    const bl = baseLoad(buildIndex(seed.entries), M)!;
    expect(Math.abs(bl.a - TRUE_A) / TRUE_A).toBeLessThan(0.08);
    expect(Math.abs(bl.b - TRUE_B) / TRUE_B).toBeLessThan(0.15);
    expect(bl.r2).toBeGreaterThan(0.5);
  });
});

describe('T7 measures arithmetic', () => {
  it('saving = kWh × tariff + demand cut; payback = capex / saving', () => {
    const p = portfolio(MEASURE_SEED, 7.5, 0.71);
    const kwh = MEASURE_SEED.reduce((s, m) => s + m.kwhPerYr, 0);
    const extra = MEASURE_SEED.reduce((s, m) => s + m.extraInrPerYr, 0);
    expect(p.savingInr).toBeCloseTo(kwh * 7.5 + extra, 6);
    expect(p.co2t).toBeCloseTo(MEASURE_SEED.filter((m) => m.co2Counted).reduce((s, m) => s + m.kwhPerYr, 0) * 0.71 / 1000, 6);
    expect(p.payback).toBeCloseTo(p.capex / p.savingInr, 9);
  });
});

describe('T8 correction = reversal + new entry', () => {
  it('keeps the original, recomputes emissions, shows the delta', () => {
    const m = M[0];
    const before = monthEmissions(seed.registers, buildIndex(seed.entries), FACTORS, m);
    const orig = seed.entries.find((e) => e.registerId === 'DIESEL' && e.month === m)!;
    const { entries, created } = correctLine(seed.entries, 'DIESEL', m, 'issued', 2000, 'Re-counted from slips', 'custodian');
    expect(created).toHaveLength(2);
    expect(created[0].qty).toBe(-orig.qty);
    expect(created[0].reversesId).toBe(orig.id);
    expect(entries.find((e) => e.id === orig.id)?.status).toBe('reversed');
    const after = monthEmissions(seed.registers, buildIndex(entries), FACTORS, m);
    expect(before.total - after.total).toBeCloseTo((orig.qty - 2000) * 2.68, 3);
  });
  it('rejects a correction without a reason', () => {
    expect(() => correctLine(seed.entries, 'DIESEL', M[0], 'issued', 1, ' ', 'x')).toThrow();
  });
});

describe('T9 reopen lowers DQ score', () => {
  it('−10 per reopen', () => {
    const issues = runValidation(ctx());
    const base = dqScore(M[20], issues, {}, undefined, false);
    const reopened = dqScore(M[20], issues, {}, { month: M[20], status: 'reopened', reopenedCount: 1, history: [] }, false);
    expect(base - reopened).toBe(10);
  });
});

describe('T11 offline sync posts exactly once', () => {
  it('10 queued items, sent twice, post once', () => {
    let entries: LedgerEntry[] = seed.entries;
    const queue: LedgerEntry[] = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, registerId: 'DIESEL', month: '2026-11', line: 'issued', qty: 10, status: 'posted', by: 'op', at: '', source: 'app', idempotencyKey: `k${i}` }));
    for (const pass of [1, 2]) for (const q of queue) entries = postEntry(entries, { ...q, id: `${q.id}_${pass}` }).entries;
    expect(entries.length - seed.entries.length).toBe(10);
  });
});
