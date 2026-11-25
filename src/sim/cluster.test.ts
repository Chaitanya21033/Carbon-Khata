import { describe, expect, it } from 'vitest';
import { cluster } from './cluster';

const T = Date.UTC(2026, 10, 10, 20, 0);
describe('cluster pool', () => {
  it('pooled deviation and charges are lower than members alone', () => {
    const { rows } = cluster.day(T);
    const sum = (f: (r: typeof rows[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    expect(rows.length).toBe(81);
    expect(sum((r) => r.pooledDev)).toBeLessThan(sum((r) => r.indivDev) * 0.6);
    expect(sum((r) => r.pooledPen)).toBeLessThan(sum((r) => r.indivPen));
    expect(sum((r) => r.pooledCost)).toBeLessThan(sum((r) => r.soloCost));
  });
  it('accepting a proposal adds a stream and a paired ledger line; mismatch is held', () => {
    cluster.reset();
    cluster.inject('scrapShort', T);
    expect(cluster.proposals().some((p) => p.id === 'p-offcut')).toBe(true);
    const n = cluster.exchanges().length;
    cluster.accept('p-offcut', T);
    expect(cluster.exchanges().length).toBe(n + 1);
    expect(cluster.ledger[0].status).toBe('reconciled');
    cluster.inject('mismatch', T);
    expect(cluster.ledger[0].status).toBe('mismatch');
  });
  it('year-to-date scoreboard accrues and heat trip pauses heat', () => {
    cluster.reset();
    cluster.advance(T);
    const t0 = cluster.acc.t;
    expect(t0).toBeGreaterThan(1000);
    cluster.inject('heatTrip', T);
    expect(cluster.exchanges().filter((x) => cluster.isPaused(x, T + 1)).every((x) => x.kind === 'heat')).toBe(true);
    cluster.advance(T + 3_600_000);
    expect(cluster.acc.t).toBeGreaterThan(t0);
  });
});
