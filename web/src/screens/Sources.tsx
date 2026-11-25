import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
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
      </div>
    </Drawer>
  );
}
