import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { Severity } from '../domain/types';

export function Kpi({ label, value, unit, sub, tone }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: 'ok' | 'warn' | 'block' }) {
  const color = tone === 'block' ? 'var(--danger)' : tone === 'warn' ? 'var(--warning)' : undefined;
  return (
    <div className="card kpi">
      <span className="k-label">{label}</span>
      <span className="k-value" style={{ color }}>{value}{unit && <span className="k-unit">{unit}</span>}</span>
      {sub && <span className="k-sub">{sub}</span>}
    </div>
  );
}

const SEV: Record<Severity | 'ok', { cls: string; icon: string; label: string }> = {
  block: { cls: 'block', icon: 'x', label: 'Must fix' },
  warn: { cls: 'warn', icon: 'alert', label: 'Check' },
  info: { cls: 'info', icon: 'info', label: 'Insight' },
  ok: { cls: 'ok', icon: 'check', label: 'Balanced' },
};
export function SevChip({ sev, label }: { sev: Severity | 'ok'; label?: string }) {
  const s = SEV[sev];
  return <span className={`chip ${s.cls}`}><Icon name={s.icon} size={12} stroke={2.5} />{label ?? s.label}</span>;
}

export function Chip({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'block' | 'info' | 'neutral' | 'sample'; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}
export const SampleTag = () => null;

export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={o.v} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.l}</button>)}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="row-between" style={{ marginBottom: 16 }}>
      <div><h1>{title}</h1>{sub && <p className="muted small" style={{ marginTop: 4 }}>{sub}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

type DownloadsNs = { save: (r: { filename: string; data: string }) => Promise<{ status: string }> };
type ClaudeHost = { use: (name: string) => Promise<unknown> };

/**
 * Save a generated file. Inside the claude.ai artifact viewer this goes through the `downloads`
 * capability (the viewer confirms); in the standalone PWA it falls back to a normal browser download.
 */
export async function download(name: string, content: string, mime = 'text/plain'): Promise<boolean> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (host?.use) {
    try {
      const ns = (await host.use('downloads')) as DownloadsNs | null;
      if (ns) { await ns.save({ filename: name, data: content }); return true; }
    } catch { return false; }
  }
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  return true;
}

export function Empty({ icon = 'check', title, sub, action }: { icon?: string; title: string; sub?: string; action?: ReactNode }) {
  return <div className="empty"><div style={{ display: 'inline-grid', placeItems: 'center', width: 56, height: 56, borderRadius: 16, background: 'var(--primary-soft)', color: 'var(--primary)', marginBottom: 10 }}><Icon name={icon} size={28} /></div><h3>{title}</h3>{sub && <p className="small" style={{ marginTop: 4 }}>{sub}</p>}{action && <div style={{ marginTop: 12 }}>{action}</div>}</div>;
}
