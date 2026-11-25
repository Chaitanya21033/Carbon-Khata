import { describe, expect, it } from 'vitest';
import { batchesUpTo, buildBatch, lotIndex, batchRecord } from '../fmcg';

const clock = Date.UTC(2026, 10, 12, 12, 0);
const all = batchesUpTo(clock, new Set(), 0.6, 0.3, {}, 999);

describe('FMCG batch tracing', () => {
  it('produces batches with lots, tests and carbon', () => {
    expect(all.length).toBeGreaterThan(20);
    for (const b of all) { expect(b.lots.length).toBeGreaterThan(2); expect(b.carbon.perPackG).toBeGreaterThan(0); }
  });
  it('release gate: a failed test holds the batch and blocks dispatch', () => {
    const held = all.filter((b) => b.status === 'held');
    expect(held.length).toBeGreaterThan(0);
    for (const b of held) { expect(b.tests.some((t) => t.status === 'fail')).toBe(true); expect(b.dispatch).toHaveLength(0); }
  });
  it('mass balance: output never exceeds ingredient input', () => {
    for (const b of all) expect(b.outputKg).toBeLessThan(b.lots.filter((l) => l.material !== 'film').reduce((s, l) => s + l.kg, 0) + 0.5);
  });
  it('recall: flagging a lot recalls exactly the finished batches that used it', () => {
    const lot = lotIndex(all).find((l) => l.material === 'spice')!;
    const after = batchesUpTo(clock, new Set([lot.lot]), 0.6, 0.3, {}, 999);
    const users = new Set(lot.batches.filter((b) => b.status !== 'in_production').map((b) => b.id));
    const recalled = new Set(after.filter((b) => b.status === 'recalled').map((b) => b.id));
    expect(recalled).toEqual(users);
  });
  it('fingerprint changes if a result is edited', () => {
    const b = buildBatch(3, clock, new Set(), 0.6, 0.3, {});
    const c = buildBatch(3, clock, new Set(), 0.6, 0.3, { [`${b.id}|Product moisture`]: 'fail' });
    expect(batchRecord(b)).not.toEqual(batchRecord(c));
  });
});
