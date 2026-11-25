import { useEffect, useState } from 'react';
import { fetchGridCarbon, fetchSolarForecast, getEmKey, getSample, setEmKey, SITE, STATIC_SOURCES, type SourceStatus } from '../api/sources';
import { Chip, Drawer } from '../ui/kit';

const TONE: Record<SourceStatus, 'ok' | 'warn' | 'info' | 'neutral' | 'block'> = { live: 'ok', simulated: 'warn', needs_key: 'info', checking: 'neutral', adapter: 'neutral' };
const LABEL: Record<SourceStatus, string> = { live: 'live', simulated: 'simulated', needs_key: 'needs key', checking: 'checking…', adapter: 'adapter ready' };

export default function SourcesDrawer({ onClose }: { onClose: () => void }) {
  const [solar, setSolar] = useState<{ s: SourceStatus; note: string }>({ s: 'checking', note: '' });
  const [carbon, setCarbon] = useState<{ s: SourceStatus; note: string }>({ s: 'checking', note: '' });
  const [vision, setVision] = useState<{ s: SourceStatus; note: string }>({ s: 'checking', note: '' });
  const [key, setKey] = useState(getEmKey());
  const run = async () => {
    setSolar({ s: 'checking', note: '' }); setCarbon({ s: 'checking', note: '' }); setVision({ s: 'checking', note: '' });
    const f = await fetchSolarForecast(); setSolar({ s: f.source, note: f.note });
    const c = await fetchGridCarbon(); setCarbon({ s: c.source, note: c.source === 'live' ? `${c.gPerKwh} g CO₂/kWh · ${c.note}` : c.note });
    const smp = await getSample(); setVision(smp ? { s: 'live', note: 'Meter and bill photos are read by Claude on your account (you are asked once).' } : { s: 'simulated', note: 'Open the page inside Claude to read photos with Claude vision.' });
  };
  useEffect(() => { run(); }, []);
  const rows = [
    { name: 'Solar forecast', provider: 'Open-Meteo (free, no key)', role: `Irradiance and cloud for ${SITE.name}, next 48 h; plans tomorrow's battery and loads`, ...solar },
    { name: 'Grid carbon intensity', provider: `Electricity Maps (free personal key) · zone ${SITE.zone}`, role: 'Live g CO₂/kWh of the regional grid; when to draw and when to export', ...carbon },
    { name: 'Meter & bill reading', provider: 'Claude vision', role: 'Reads meter displays and electricity bills from photos', ...vision },
    ...STATIC_SOURCES.map((x) => ({ name: x.name, provider: x.provider, role: x.role, s: x.status, note: x.note })),
  ];
  return (
    <Drawer title="Data sources & APIs" onClose={onClose} footer={<button className="btn" onClick={run}>Re-test all</button>}>
      <div className="stack">
        <p className="small muted">Every source has a fallback, so the demo never stops. A published claude.ai page blocks calls to outside websites, so Open-Meteo and Electricity Maps show live data when the app runs locally (npm run dev) or from the standalone file.</p>
        {rows.map((r) => (
          <div key={r.name} className="card stack-sm" style={{ boxShadow: 'none' }}>
            <div className="row-between"><strong>{r.name}</strong><Chip tone={TONE[r.s]}>{LABEL[r.s]}</Chip></div>
            <span className="xs muted">{r.provider}</span>
            <span className="small">{r.role}</span>
            {r.note && <span className="xs muted">{r.note}</span>}
          </div>
        ))}
        <div className="card stack-sm" style={{ boxShadow: 'none' }}>
          <strong>Electricity Maps key</strong>
          <span className="xs muted">Get a free personal key at electricitymaps.com. It stays in this browser only.</span>
          <div className="row"><input className="input" style={{ flex: 1 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="auth-token" aria-label="Electricity Maps key" /><button className="btn primary" onClick={() => { setEmKey(key.trim()); run(); }}>Save & test</button></div>
        </div>
      </div>
    </Drawer>
  );
}
