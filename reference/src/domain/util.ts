import type { Month } from './types';

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median of the n nearest other points (by position), ties broken toward earlier months. */
export function nearestMedian(values: (number | undefined)[], i: number, n: number): { median: number; count: number } {
  const idx = values
    .map((v, j) => ({ v, j }))
    .filter((x) => x.j !== i && x.v !== undefined && !Number.isNaN(x.v))
    .sort((a, b) => Math.abs(a.j - i) - Math.abs(b.j - i) || a.j - b.j)
    .slice(0, n)
    .map((x) => x.v as number);
  return { median: median(idx), count: idx.length };
}

export function linreg(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { a, b, r2, meanY: my };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_HI = ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुल', 'अग', 'सित', 'अक्टू', 'नव', 'दिस'];
export function monthLabel(m: Month, lang: 'en' | 'hi' = 'en', short = true): string {
  const [y, mm] = m.split('-').map(Number);
  const name = (lang === 'hi' ? MONTHS_HI : MONTHS)[mm - 1];
  return short ? `${name} ${String(y).slice(2)}` : `${name} ${y}`;
}
export function fy(m: Month): string {
  const [y, mm] = m.split('-').map(Number);
  const start = mm >= 4 ? y : y - 1;
  return `FY ${start}-${String(start + 1).slice(2)}`;
}
export function addMonths(m: Month, k: number): Month {
  const [y, mm] = m.split('-').map(Number);
  const t = y * 12 + (mm - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** Indian digit grouping: 12,34,567 */
export function inr(n: number, digits = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function lakh(n: number, digits = 2): string {
  return `₹${(n / 1e5).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })} L`;
}
export function fmt(n: number | undefined, digits = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter++;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
