// Frontend tests: Indian number formatting, ledger index used for display, and the live-engine adapter.
import { describe, expect, it } from 'vitest';
import { fmt, lakh, monthLabel } from '../domain/util';
import { buildIndex, value } from '../domain/ledger';
import { toEngine, type Snapshot } from '../live/engine';
import type { LedgerEntry } from '../domain/types';

describe('formatting', () => {
  it('groups digits the Indian way (lakh, crore)', () => {
    expect(fmt(1234567)).toBe('12,34,567');
    expect(fmt(1234567.891, 2)).toBe('12,34,567.89');
    expect(lakh(1925000)).toBe('₹19.25 L');
    expect(monthLabel('2026-11', 'en', false)).toBe('Nov 2026');
  });
});

describe('ledger index for display', () => {
  it('sums posted lines and reversals per register / month / line', () => {
    const e = (id: string, qty: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id, registerId: 'DIESEL', month: '2026-11', line: 'issued', qty, status: 'posted', by: 't', at: '', source: 'app', ...extra });
    const idx = buildIndex([e('a', 40), e('b', 60), e('r', -40, { reversesId: 'a' })]);
    expect(value(idx, 'DIESEL', '2026-11', 'issued')).toBe(60);
    expect(value(idx, 'DIESEL', '2026-10', 'issued')).toBeUndefined();
  });
});

describe('live engine adapter', () => {
  it('exposes last24 and the current block with event overrides', () => {
    const mb = (rtm: number) => ({ block: 0, dam: 4, gdam: 4, rtm, discom: 7, gridDemandGW: 40, solarGW: 0, netDemandGW: 40, marginalEf: 0.9, stress: 10 });
    const snap = { clock: 0, block: 0, queued: { stores: 2 }, ems: { market: [mb(4)], current: mb(10), last24: null } } as unknown as Snapshot;
    const e = toEngine(snap, [], () => () => undefined, { resolve: () => undefined, setEms: () => undefined });
    expect(e.ems.current(0).rtm).toBe(10);
    expect(e.ems.last24().blocks).toBe(0);
    expect(e.queues.stores).toHaveLength(2);
  });
});
