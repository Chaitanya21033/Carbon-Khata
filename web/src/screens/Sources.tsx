import { useQuery } from '@tanstack/react-query';
import { api, getToken } from '../api/client';
import { appBase } from '../ui/Qr';
import { Chip, Drawer } from '../ui/kit';

type SourceStatus = 'live' | 'simulated' | 'needs_key' | 'adapter';
interface Source { id: string; name: string; provider: string; role: string; status: SourceStatus; note: string }
const TONE: Record<SourceStatus, 'ok' | 'warn' | 'info' | 'neutral'> = { live: 'ok', simulated: 'warn', needs_key: 'info', adapter: 'neutral' };
const LABEL: Record<SourceStatus, string> = { live: 'live', simulated: 'simulated', needs_key: 'needs key', adapter: 'adapter only' };

/** Status of every external source, as reported by the API's integration adapters. Keys live in the server's .env. */
export default function SourcesDrawer({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['sources'], queryFn: () => api<Source[]>('/sources') });
  return (
    <Drawer title="Data sources & APIs" onClose={onClose} footer={<button className="btn" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? 'Checking…' : 'Re-test all'}</button>}>
      <div className="stack">
        <p className="small muted">Every source has an adapter and a fallback, so the product keeps working. Keys are set on the server (.env), never in the browser.</p>
        {q.isLoading && <div className="card">Checking sources…</div>}
        {q.error && <div className="banner block">Could not reach the API: {(q.error as Error).message}</div>}
        {q.data?.map((r) => (
          <div key={r.id} className="card stack-sm" style={{ boxShadow: 'none' }}>
            <div className="row-between"><strong>{r.name}</strong><Chip tone={TONE[r.status]}>{LABEL[r.status]}</Chip></div>
            <span className="xs muted">{r.provider}</span>
            <span className="small">{r.role}</span>
            {r.note && <span className="xs muted">{r.note}</span>}
          </div>
        ))}
        <ApiLinks />
      </div>
    </Drawer>
  );
}

/** Where every API is, as links that open on this computer or a phone on the same Wi-Fi. */
function ApiLinks() {
  const base = appBase();
  const dev = base.replace(/:5173$/, ':5174');
  const t = encodeURIComponent(getToken());
  const a = (href: string, label: string, note: string) => (
    <div key={href} className="row-between small" style={{ borderTop: '1px solid var(--border)', padding: '6px 0', gap: 8, flexWrap: 'nowrap' }}>
      <span><a href={href} target="_blank" rel="noreferrer">{label}</a><br /><span className="xs muted">{note}</span></span>
    </div>
  );
  return (
    <div className="card stack-sm" style={{ boxShadow: 'none' }}>
      <strong>APIs & endpoints</strong>
      <span className="xs muted">Product API (signed in as you; JSON in the browser)</span>
      {a(`${base}/docs`, 'API docs (Swagger)', `${base}/docs · all 100+ endpoints; use Authorize with your token`)}
      {a(`${base}/api/v1/sensors?token=${t}`, 'Sensors & CO₂ analysers', 'GET /api/v1/sensors')}
      {a(`${base}/api/v1/sensors/co2_air?token=${t}`, 'One sensor with 4 h history', 'GET /api/v1/sensors/{id}')}
      {a(`${base}/api/v1/live/state?token=${t}`, 'Live plant snapshot', 'GET /api/v1/live/state')}
      {a(`${base}/api/v1/energy/twin?token=${t}`, 'EMS vs naive twin', 'GET /api/v1/energy/twin')}
      {a(`${base}/api/v1/energy/decisions?token=${t}`, 'EMS decision log', 'GET /api/v1/energy/decisions')}
      {a(`${base}/api/v1/energy/market?token=${t}`, 'Market today (96 blocks)', 'GET /api/v1/energy/market')}
      {a(`${base}/api/v1/emissions/summary?token=${t}`, 'Emissions, last 12 months', 'GET /api/v1/emissions/summary')}
      {a(`${base}/api/v1/passports?token=${t}`, 'Part passports', 'GET /api/v1/passports')}
      {a(`${base}/api/v1/documents?token=${t}`, 'Photos from phones', 'GET /api/v1/documents')}
      {a(`${base}/api/v1/stream?token=${t}`, 'Live event stream (SSE)', 'GET /api/v1/stream')}
      <span className="xs muted" style={{ marginTop: 6 }}>Field devices (simulated hardware, no login)</span>
      {a(`${dev}/#/devices`, 'Device pages', 'one page per meter / analyser: watch, override, take offline')}
      {a(`${dev}/sim/devices`, 'Device API: all devices', 'GET /sim/devices')}
      {a(`${dev}/sim/devices/co2_air`, 'Device API: one device', 'GET /sim/devices/{id} · POST …/override · POST …/online')}
      {a(`${dev}/sim/docs`, 'Device API docs (Swagger)', `${dev}/sim/docs`)}
      <button className="btn sm" onClick={() => { const t = getToken(); if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(() => alert('Token copied. In /docs click Authorize → bearerAuth and paste it.'), () => prompt('Copy this token:', t)); else prompt('Copy this token, then in /docs click Authorize → bearerAuth and paste it:', t); }}>Copy my token</button>
    </div>
  );
}
