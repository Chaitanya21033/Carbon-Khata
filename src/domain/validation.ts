import rulesJson from '../data/validation_rules.json';
import type { Issue, IssueState, Month, MonthClose, Register, Severity } from './types';
import { balance, primaryLine, value, type LedgerIndex } from './ledger';
import { fmt, monthLabel, nearestMedian } from './util';

interface RuleDef { code: string; name: string; severity: string; params: Record<string, number | boolean>; message_en: string; message_hi: string }
export const RULES: RuleDef[] = (rulesJson as unknown as { rules: RuleDef[] }).rules;
export const DQ = (rulesJson as unknown as { dq_score: Record<string, number> }).dq_score;
const rule = (c: string) => RULES.find((r) => r.code === c)!;

function sev(c: string): { severity: Severity; blocksClose: boolean } {
  const s = rule(c).severity;
  if (s.startsWith('block')) return { severity: 'block', blocksClose: true };
  if (s === 'warn_block_at_close') return { severity: 'warn', blocksClose: true };
  if (s === 'info') return { severity: 'info', blocksClose: false };
  return { severity: 'warn', blocksClose: false };
}

function fill(tpl: string, vars: Record<string, string | number>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export interface ValidationContext {
  registers: Register[];
  idx: LedgerIndex;
  plantMonths: Month[];
  billMonths: Month[];
  contractDemandKva: number;
}

const NO_OUTLIER = new Set(['PF', 'MD_KVA']);
const NO_FLAT = new Set(['PF', 'MD_KVA']);

export function monthsFor(ctx: ValidationContext, r: Register): Month[] {
  return r.category === 'utility' ? ctx.billMonths : ctx.plantMonths;
}

function mk(c: string, partial: Omit<Issue, 'rule' | 'severity' | 'blocksClose' | 'message' | 'messageHi'>, vars: Record<string, string | number>): Issue {
  const def = rule(c);
  return { rule: c, ...sev(c), ...partial, message: fill(def.message_en, vars), messageHi: fill(def.message_hi, vars) };
}

export function runValidation(ctx: ValidationContext): Issue[] {
  const issues: Issue[] = [];
  const { idx } = ctx;

  for (const r of ctx.registers) {
    const months = monthsFor(ctx, r);
    const line = primaryLine(r);
    const vals = months.map((m) => value(idx, r.id, m, line));
    const series = months.map((m, i) => ({ month: m, value: vals[i] ?? 0 }));
    const label = r.label;

    // V01 / V02: order-of-magnitude outliers vs median of the 6 nearest months
    if (!NO_OUTLIER.has(r.id)) {
      const p1 = rule('V01').params, p2 = rule('V02').params;
      vals.forEach((v, i) => {
        if (v === undefined) return;
        const { median, count } = nearestMedian(vals, i, Number(p1.window_months));
        if (count < Number(p1.min_history_months) || !(median > 0)) return;
        const m = months[i];
        const win = series.slice(Math.max(0, i - 6), i + 7);
        if (v > Number(p1.multiple_of_median) * median) {
          issues.push(mk('V01', { id: `V01|${r.id}|${m}|${line}`, registerId: r.id, month: m, line, field: label, expected: median, actual: v, series: win }, { ratio: (v / median).toFixed(1), field: label.toLowerCase() }));
        } else if (v < Number(p2.fraction_of_median) * median) {
          issues.push(mk('V02', { id: `V02|${r.id}|${m}|${line}`, registerId: r.id, month: m, line, field: label, expected: median, actual: v, series: win }, { ratio: (v / median).toFixed(2), field: label.toLowerCase() }));
        }
      });
    }

    // V03: flat-lined non-zero value for ≥ 6 consecutive months
    if (!NO_FLAT.has(r.id)) {
      const need = Number(rule('V03').params.consecutive_months);
      let start = 0;
      for (let i = 1; i <= vals.length; i++) {
        if (i < vals.length && vals[i] !== undefined && vals[i] === vals[start] && vals[i] !== 0) continue;
        const len = i - start;
        if (len >= need && vals[start] !== undefined && vals[start] !== 0) {
          const m = months[start];
          issues.push(mk('V03', { id: `V03|${r.id}|${m}`, registerId: r.id, month: m, line, field: label, actual: vals[start], series: series.slice(start, i) }, { field: label, value: fmt(vals[start]!), n: len }));
        }
        start = i;
      }
    }

    // V04: required source missing
    if (r.required) {
      months.forEach((m, i) => {
        if (vals[i] === undefined) issues.push(mk('V04', { id: `V04|${r.id}|${m}`, registerId: r.id, month: m, line, field: label }, { field: label, month: monthLabel(m, 'en', false) }));
      });
    }

    // V05 / V12: register identity and negative stock
    if (r.mode === 'full') {
      let prevClosing: number | undefined;
      for (const m of months) {
        const b = balance(idx, r.id, m);
        if (b.calc === undefined) { prevClosing = b.closing; continue; }
        if (!b.ok) {
          issues.push(mk('V05', { id: `V05|${r.id}|${m}`, registerId: r.id, month: m, line: 'closing', field: label, expected: b.calc, actual: b.closing }, { o: fmt(b.opening), r: fmt(b.received), i: fmt(b.issued), calc: fmt(b.calc), c: fmt(b.closing) }));
        } else if (prevClosing !== undefined && Math.abs((b.opening ?? 0) - prevClosing) > 0.5) {
          issues.push(mk('V05', { id: `V05cf|${r.id}|${m}`, registerId: r.id, month: m, line: 'opening', field: `${label} (carry-forward)`, expected: prevClosing, actual: b.opening }, { o: fmt(b.opening), r: fmt(b.received), i: fmt(b.issued), calc: fmt(b.calc), c: fmt(b.closing) }));
        }
        if (b.calc < -b.tolerance) {
          issues.push(mk('V12', { id: `V12|${r.id}|${m}`, registerId: r.id, month: m, line: 'issued', field: label, expected: 0, actual: b.calc }, { value: fmt(b.calc) }));
        }
        prevClosing = b.closing;
      }
    }
  }

  // Bill-level rules
  const bm = ctx.billMonths;
  const kwh = bm.map((m) => value(idx, 'GRID_KWH', m, 'reading'));
  const kvah = bm.map((m) => value(idx, 'GRID_KVAH', m, 'reading'));
  const amt = bm.map((m) => value(idx, 'BILL_INR', m, 'reading'));
  const pf = bm.map((m) => value(idx, 'PF', m, 'reading'));
  const md = bm.map((m) => value(idx, 'MD_KVA', m, 'reading'));
  const rate = bm.map((_, i) => (kwh[i] && amt[i] !== undefined ? amt[i]! / kwh[i]! : undefined));
  bm.forEach((m, i) => {
    if (md[i] !== undefined && md[i]! > ctx.contractDemandKva) {
      issues.push(mk('V06', { id: `V06|${m}`, registerId: 'MD_KVA', month: m, line: 'reading', field: 'Maximum demand', expected: ctx.contractDemandKva, actual: md[i] }, { md: fmt(md[i]), cd: ctx.contractDemandKva }));
    }
    if (rate[i] !== undefined) {
      const { median } = nearestMedian(rate, i, 6);
      const p = rule('V07').params;
      if (rate[i]! < Number(p.low) * median || rate[i]! > Number(p.high) * median) {
        issues.push(mk('V07', { id: `V07|${m}`, registerId: 'BILL_INR', month: m, line: 'reading', field: 'Electricity bill', expected: median * kwh[i]!, actual: amt[i] }, { rate: rate[i]!.toFixed(2), median: median.toFixed(2) }));
      }
    }
    if (kwh[i] && kvah[i]) {
      const implied = kwh[i]! / kvah[i]!;
      const tol = Number(rule('V08').params.pf_tolerance);
      if (kvah[i]! < kwh[i]! || (pf[i] !== undefined && Math.abs(implied - pf[i]!) > tol)) {
        issues.push(mk('V08', { id: `V08|${m}`, registerId: 'PF', month: m, line: 'reading', field: 'Power factor', expected: implied, actual: pf[i] }, { pf: pf[i] ?? '—', implied: implied.toFixed(2) }));
      }
    }
  });

  // V09: energy intensity outlier
  const pm = ctx.plantMonths;
  const kpu = pm.map((m) => {
    const k = value(idx, 'GRID_KWH', m, 'reading');
    const p = value(idx, 'PROD', m, 'reading');
    return k && p ? k / p : undefined;
  });
  const band = Number(rule('V09').params.band);
  kpu.forEach((v, i) => {
    if (v === undefined) return;
    const { median } = nearestMedian(kpu, i, 12);
    if (Math.abs(v - median) / median > band) {
      const m = pm[i];
      issues.push(mk('V09', { id: `V09|${m}`, registerId: 'GRID_KWH', month: m, line: 'reading', field: 'kWh per unit', expected: median, actual: v }, { kwh_per_unit: v.toFixed(0), median: median.toFixed(0) }));
    }
  });

  return issues;
}

export function effectiveStatus(issue: Issue, states: Record<string, IssueState>): IssueState['status'] {
  return states[issue.id]?.status ?? 'open';
}

/** Data-quality score per plant-month (0–100). */
export function dqScore(month: Month, issues: Issue[], states: Record<string, IssueState>, close: MonthClose | undefined, missingSource: boolean): number {
  let s = DQ.start;
  for (const i of issues) {
    if (i.month !== month) continue;
    const st = effectiveStatus(i, states);
    if (st === 'open' && i.severity === 'block') s += DQ.per_open_block;
    else if (st === 'open' && i.severity === 'warn') s += DQ.per_open_warn;
    else if (st === 'accepted') s += DQ.per_accepted_as_real;
  }
  if (close && close.reopenedCount > 0) s += DQ.month_reopened * close.reopenedCount;
  if (missingSource) s += DQ.missing_required_source;
  return Math.max(DQ.floor, Math.min(100, s));
}

export function closeBlockers(month: Month, issues: Issue[], states: Record<string, IssueState>): Issue[] {
  return issues.filter((i) => i.month === month && i.blocksClose && effectiveStatus(i, states) === 'open');
}
