import type { LedgerEntry, LineType, Month, Register } from './types';
import { uid } from './util';

export type LedgerIndex = Map<string, { sum: number; entries: LedgerEntry[] }>;

const key = (reg: string, month: Month, line: LineType) => `${reg}|${month}|${line}`;

/** Sum of all entries per register/month/line. Reversals carry negative qty, so the sum is the current value. */
export function buildIndex(entries: LedgerEntry[]): LedgerIndex {
  const idx: LedgerIndex = new Map();
  for (const e of entries) {
    const k = key(e.registerId, e.month, e.line);
    const cur = idx.get(k) ?? { sum: 0, entries: [] };
    cur.sum += e.qty;
    cur.entries.push(e);
    idx.set(k, cur);
  }
  return idx;
}

export function value(idx: LedgerIndex, reg: string, month: Month, line: LineType): number | undefined {
  const v = idx.get(key(reg, month, line));
  if (!v) return undefined;
  return Math.round(v.sum * 1e6) / 1e6;
}

export function lineEntries(idx: LedgerIndex, reg: string, month: Month, line: LineType): LedgerEntry[] {
  return idx.get(key(reg, month, line))?.entries ?? [];
}

export function primaryLine(r: Register): LineType {
  return r.mode === 'reading' ? 'reading' : 'issued';
}

/** Consumption for emissions = Σ issued (not received). Readings return the reading. */
export function consumption(idx: LedgerIndex, r: Register, month: Month): number | undefined {
  return value(idx, r.id, month, primaryLine(r));
}

export interface Balance {
  opening?: number; received: number; issued: number; adjustment: number; closing?: number;
  calc?: number; diff?: number; ok: boolean; tolerance: number; running?: number;
}

export function tolerance(calc: number) {
  return Math.max(0.5, Math.abs(calc) * 0.001);
}

/** Balance identity: opening + Σreceived − Σissued ± Σadjustment = closing (tolerance 0.5 unit or 0.1%). */
export function balance(idx: LedgerIndex, regId: string, month: Month): Balance {
  const opening = value(idx, regId, month, 'opening');
  const received = value(idx, regId, month, 'received') ?? 0;
  const issued = value(idx, regId, month, 'issued') ?? 0;
  const adjustment = value(idx, regId, month, 'adjustment') ?? 0;
  const closing = value(idx, regId, month, 'closing');
  if (opening === undefined || closing === undefined) return { opening, received, issued, adjustment, closing, ok: true, tolerance: 0.5 };
  const calc = opening + received - issued + adjustment;
  const tol = tolerance(calc);
  const diff = closing - calc;
  return { opening, received, issued, adjustment, closing, calc, diff, ok: Math.abs(diff) <= tol, tolerance: tol, running: calc };
}

/**
 * Correct a line. Posted entries are never edited: each active entry gets a reversal
 * (same qty, opposite sign) and one new entry carries the corrected quantity.
 */
export function correctLine(
  entries: LedgerEntry[], regId: string, month: Month, line: LineType, newQty: number, reason: string, by: string,
): { entries: LedgerEntry[]; created: LedgerEntry[] } {
  if (!reason || !reason.trim()) throw new Error('A reason is required for every correction');
  const at = new Date().toISOString();
  const active = entries.filter((e) => e.registerId === regId && e.month === month && e.line === line && e.status === 'posted' && !e.reversesId);
  const created: LedgerEntry[] = [];
  const reversedIds = new Set<string>();
  for (const e of active) {
    reversedIds.add(e.id);
    created.push({ id: uid('rev'), registerId: regId, month, line, qty: -e.qty, status: 'posted', reversesId: e.id, reason, by, at, source: 'app' });
  }
  created.push({ id: uid('ent'), registerId: regId, month, line, qty: newQty, status: 'posted', correctsId: active[0]?.id, reason, by, at, source: 'app' });
  const next = entries.map((e) => (reversedIds.has(e.id) ? { ...e, status: 'reversed' as const } : e)).concat(created);
  return { entries: next, created };
}

/** Post a new entry with idempotency (offline sync may send the same item twice). */
export function postEntry(entries: LedgerEntry[], e: LedgerEntry): { entries: LedgerEntry[]; duplicate: boolean } {
  if (e.idempotencyKey && entries.some((x) => x.idempotencyKey === e.idempotencyKey)) return { entries, duplicate: true };
  return { entries: entries.concat(e), duplicate: false };
}

export function isDuplicateDoc(entries: LedgerEntry[], docRef?: string): LedgerEntry | undefined {
  if (!docRef) return undefined;
  return entries.find((e) => e.docRef === docRef && e.status === 'posted' && !e.reversesId);
}

/** Correction history for a line, newest first, in "Corrected from X to Y" form. */
export function history(idx: LedgerIndex, reg: string, month: Month, line: LineType) {
  const es = lineEntries(idx, reg, month, line);
  return es.filter((e) => e.correctsId !== undefined || (e.reason && !e.reversesId)).map((e) => {
    const reversed = es.filter((r) => r.reversesId && r.at === e.at).reduce((s, r) => s - r.qty, 0);
    return { from: reversed, to: e.qty, by: e.by, at: e.at, reason: e.reason ?? '' };
  }).reverse();
}
