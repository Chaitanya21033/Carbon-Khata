import { useState, type ReactNode } from 'react';
import { fmt } from '../domain/util';

/** Every chart has a "view as table" alternative (accessibility rule §1). */
export function ChartCard({ title, sub, legend, table, children, actions }: { title: string; sub?: string; legend?: { label: string; color: string }[]; table?: { head: string[]; rows: (string | number)[][] }; children: ReactNode; actions?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="small muted">{sub}</p>}
        </div>
        <div className="row">
          {actions}
          {table && <button className="btn sm ghost" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{asTable ? 'View chart' : 'View as table'}</button>}
        </div>
      </div>
      {asTable && table ? (
        <div className="table-wrap" style={{ maxHeight: 320 }}>
          <table className="t"><thead><tr>{table.head.map((h, i) => <th key={h} className={i ? 'r' : ''}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'r' : ''}>{typeof c === 'number' ? fmt(c, 1) : c}</td>)}</tr>)}</tbody></table>
        </div>
      ) : (
        <>
          {children}
          {legend && <div className="legend" style={{ marginTop: 8 }}>{legend.map((l) => <span key={l.label}><i style={{ background: l.color }} />{l.label}</span>)}</div>}
        </>
      )}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const short = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(v >= 1e6 ? 0 : 1)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v % 1 ? v.toFixed(1) : String(v));

export function StackedBars({ labels, series, height = 220, refLine, highlight }: { labels: string[]; series: { name: string; color: string; values: number[] }[]; height?: number; refLine?: { value: number; label: string }; highlight?: number[] }) {
  const W = 640, H = height, pl = 44, pb = 26, pt = 10, pr = 8;
  const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = niceMax(Math.max(...totals, refLine?.value ?? 0));
  const bw = (W - pl - pr) / labels.length;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const step = Math.ceil(labels.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Bar chart" style={{ display: 'block' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}><line x1={pl} x2={W - pr} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" strokeDasharray={f ? '3 4' : ''} />
          <text x={pl - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{short(max * f)}</text></g>
      ))}
      {labels.map((l, i) => {
        let acc = 0;
        return (
          <g key={l}>
            {series.map((s) => {
              const v = s.values[i] ?? 0; const y0 = y(acc); acc += v; const y1 = y(acc);
              return <rect key={s.name} x={pl + i * bw + bw * 0.15} y={y1} width={bw * 0.7} height={Math.max(0, y0 - y1)} fill={s.color} opacity={highlight && !highlight.includes(i) ? 0.35 : 1}><title>{`${l} · ${s.name}: ${fmt(v, 1)}`}</title></rect>;
            })}
            {i % step === 0 && <text x={pl + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{l}</text>}
          </g>
        );
      })}
      {refLine && <g><line x1={pl} x2={W - pr} y1={y(refLine.value)} y2={y(refLine.value)} stroke="var(--danger)" strokeDasharray="6 4" strokeWidth="1.5" />
        <text x={W - pr} y={y(refLine.value) - 4} textAnchor="end" fontSize="10" fill="var(--danger)">{refLine.label}</text></g>}
    </svg>
  );
}

export function LineChart({ labels, series, height = 200, refLine, yMin }: { labels: string[]; series: { name: string; color: string; values: (number | null)[]; dashed?: boolean }[]; height?: number; refLine?: { value: number; label: string }; yMin?: number }) {
  const W = 640, H = height, pl = 44, pb = 26, pt = 10, pr = 10;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = niceMax(Math.max(...all, refLine?.value ?? 0) * 1.05);
  const min = yMin ?? 0;
  const x = (i: number) => pl + (W - pl - pr) * (labels.length === 1 ? 0.5 : i / (labels.length - 1));
  const y = (v: number) => pt + (H - pt - pb) * (1 - (v - min) / (max - min));
  const step = Math.ceil(labels.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Line chart" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => { const v = min + (max - min) * f; return <g key={f}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={f ? '3 4' : ''} /><text x={pl - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{short(Math.round(v))}</text></g>; })}
      {labels.map((l, i) => i % step === 0 && <text key={l} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{l}</text>)}
      {refLine && <g><line x1={pl} x2={W - pr} y1={y(refLine.value)} y2={y(refLine.value)} stroke="var(--text-muted)" strokeDasharray="6 4" /><text x={W - pr} y={y(refLine.value) - 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{refLine.label}</text></g>}
      {series.map((s) => {
        const pts = s.values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
        return <g key={s.name}><polyline points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth="2.2" strokeDasharray={s.dashed ? '5 4' : ''} />
          {s.values.map((v, i) => v !== null && <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={s.color}><title>{`${labels[i]}: ${fmt(v, 1)}`}</title></circle>)}</g>;
      })}
    </svg>
  );
}

export function ScatterFit({ points, a, b, xLabel, yLabel, height = 220 }: { points: { x: number; y: number; label: string }[]; a: number; b: number; xLabel: string; yLabel: string; height?: number }) {
  const W = 640, H = height, pl = 50, pb = 34, pt = 10, pr = 10;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xmin = Math.floor(Math.min(...xs) * 0.9 / 50) * 50, xmax = Math.ceil(Math.max(...xs) * 1.05 / 50) * 50;
  const ymax = niceMax(Math.max(...ys) * 1.05);
  const x = (v: number) => pl + (W - pl - pr) * (v - xmin) / (xmax - xmin);
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / ymax);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Scatter chart with fitted line" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={pl} x2={W - pr} y1={y(ymax * f)} y2={y(ymax * f)} stroke="var(--border)" strokeDasharray={f ? '3 4' : ''} /><text x={pl - 6} y={y(ymax * f) + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{short(ymax * f)}</text></g>)}
      <rect x={pl} y={y(a)} width={W - pl - pr} height={y(0) - y(a)} fill="var(--accent)" opacity="0.12" />
      <text x={pl + 6} y={y(a) + 14} fontSize="10" fill="var(--accent-text)">Base load ≈ {short(Math.round(a))} kWh/month</text>
      <line x1={x(xmin)} y1={y(a + b * xmin)} x2={x(xmax)} y2={y(a + b * xmax)} stroke="var(--primary)" strokeWidth="2" />
      {points.map((p) => <circle key={p.label} cx={x(p.x)} cy={y(p.y)} r="4.5" fill="var(--c5)" opacity="0.85"><title>{`${p.label}: ${fmt(p.x)} units, ${fmt(p.y)} kWh`}</title></circle>)}
      {[xmin, (xmin + xmax) / 2, xmax].map((v) => <text key={v} x={x(v)} y={H - 18} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{Math.round(v)}</text>)}
      <text x={(W + pl) / 2} y={H - 3} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{xLabel}</text>
      <text x={12} y={pt + 6} fontSize="10" fill="var(--text-muted)">{yLabel}</text>
    </svg>
  );
}

export function Waterfall({ steps, height = 220, unit }: { steps: { label: string; value: number; kind: 'total' | 'delta' }[]; height?: number; unit: string }) {
  const W = 640, H = height, pl = 46, pb = 40, pt = 16, pr = 8;
  const max = niceMax(Math.max(...steps.map((s) => (s.kind === 'total' ? s.value : 0))));
  const bw = (W - pl - pr) / steps.length;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  let run = 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Waterfall chart" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={pl} x2={W - pr} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" strokeDasharray={f ? '3 4' : ''} /><text x={pl - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{short(max * f)}</text></g>)}
      {steps.map((s, i) => {
        let top: number, bot: number, color: string;
        if (s.kind === 'total') { top = s.value; bot = 0; run = s.value; color = i === 0 ? 'var(--text-muted)' : 'var(--primary)'; }
        else { top = run; bot = run - s.value; run = bot; color = 'var(--c3)'; }
        return (
          <g key={s.label}>
            <rect x={pl + i * bw + bw * 0.15} y={y(top)} width={bw * 0.7} height={Math.max(1, y(bot) - y(top))} fill={color} rx="3"><title>{`${s.label}: ${fmt(s.value, 1)} ${unit}`}</title></rect>
            <text x={pl + i * bw + bw / 2} y={y(top) - 4} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text)">{s.kind === 'delta' ? '−' : ''}{fmt(s.value, 0)}</text>
            <text x={pl + i * bw + bw / 2} y={H - 22} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{s.label}</text>
          </g>
        );
      })}
      <text x={pl} y={H - 4} fontSize="10" fill="var(--text-muted)">{unit} per year</text>
    </svg>
  );
}

export function Sparkline({ values, highlight, width = 120, height = 32 }: { values: number[]; highlight?: number; width?: number; height?: number }) {
  if (!values.length) return null;
  const max = Math.max(...values), min = Math.min(0, ...values);
  const x = (i: number) => 2 + (width - 4) * (values.length === 1 ? 0.5 : i / (values.length - 1));
  const y = (v: number) => 2 + (height - 4) * (1 - (v - min) / (max - min || 1));
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke="var(--text-muted)" strokeWidth="1.5" />
      {highlight !== undefined && highlight >= 0 && <circle cx={x(highlight)} cy={y(values[highlight])} r="3.5" fill="var(--danger)" />}
    </svg>
  );
}

export function HBar({ value, max, color = 'var(--primary)' }: { value: number; max: number; color?: string }) {
  return <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, background: color }} /></div>;
}
