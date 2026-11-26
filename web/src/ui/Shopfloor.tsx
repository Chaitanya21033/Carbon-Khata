// Shop-floor pieces added for the live demo: field-device readings, photos from phones, and opening the app on a phone.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken } from '../api/client';
import { appBase, Qr, setLanBase } from './Qr';
import { Icon } from './Icon';
import { Chip, Drawer } from './kit';
import { fmt } from '../domain/util';

export interface SensorView { id: string; label: string; unit: string; kind: 'energy' | 'carbon'; value: number | null; ts: number | null; status: 'live' | 'stale' | 'no data'; history: number[] }
export interface Doc { id: string; kind: string; kindLabel: string; filename: string; savedAs?: string; note?: string; docRef?: string; by?: string; at: string; url: string; image: boolean; size?: number }

/** Learn this machine's Wi-Fi address once, so QR codes and the phone link work from a laptop opened at localhost. */
export function useNetwork() {
  const q = useQuery({ queryKey: ['network'], queryFn: () => api<{ ips: string[] }>('/system/network', { noAuth: true }), staleTime: Infinity, retry: 0 });
  const ip = q.data?.ips[0];
  useEffect(() => { if (ip) setLanBase(`${location.protocol}//${ip}:${location.port || '5173'}`); }, [ip]);
  return ip;
}

function Spark({ v }: { v: number[] }) {
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), s = hi - lo || 1;
  return <svg viewBox="0 0 100 24" width="100%" height="24" preserveAspectRatio="none" aria-hidden><polyline points={v.map((x, i) => `${(i / (v.length - 1)) * 100},${22 - ((x - lo) / s) * 20}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

const LIMIT: Record<string, number> = { co2_air: 1000 };

export function SensorsCard({ sensors }: { sensors: SensorView[] }) {
  if (!sensors?.length) return null;
  const carbon = sensors.filter((s) => s.kind === 'carbon');
  const energy = sensors.filter((s) => s.kind === 'energy');
  const tile = (s: SensorView) => {
    const over = LIMIT[s.id] && (s.value ?? 0) > LIMIT[s.id];
    return (
      <div key={s.id} className="card" style={{ padding: 10, boxShadow: 'none', borderColor: over ? 'var(--danger)' : undefined }}>
        <div className="row-between xs"><span className="muted">{s.label}</span><Chip tone={s.status === 'live' ? (over ? 'block' : 'ok') : 'warn'}>{over ? 'above limit' : s.status}</Chip></div>
        <div style={{ fontFamily: 'var(--font-head)', fontSize: 22, fontWeight: 700 }}>{s.value == null ? '—' : fmt(s.value, s.unit === 'kg/h' ? 1 : 0)}<span className="k-unit"> {s.unit}</span></div>
        <div style={{ color: s.kind === 'carbon' ? '#8A6FD1' : '#2EC4B6' }}><Spark v={s.history} /></div>
      </div>
    );
  };
  return (
    <div className="card">
      <div className="card-head"><div><h3>Field devices & CO₂ analysers</h3><p className="xs muted">Readings as reported by each device (GET /api/v1/sensors), last hour. Alerts fire on limits, analyser drift and silent devices.</p></div></div>
      <div className="grid g4" style={{ gap: 8 }}>{carbon.map(tile)}</div>
      <div className="grid g4" style={{ gap: 8, marginTop: 8 }}>{energy.map(tile)}</div>
    </div>
  );
}

export function useDocuments(limit = 12) {
  return useQuery({ queryKey: ['documents', limit], queryFn: () => api<Doc[]>(`/documents?limit=${limit}`), staleTime: 5_000 });
}
const fileUrl = (d: Doc) => `${d.url}?token=${encodeURIComponent(getToken())}`;
const ago = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export function PhotosCard({ limit = 8 }: { limit?: number }) {
  const q = useDocuments(limit);
  return (
    <div className="card">
      <div className="card-head"><div><h3>Photos from the shop floor</h3><p className="xs muted">Taken on phones, saved on the plant server in the captures folder, shown here the moment they arrive.</p></div></div>
      {q.isLoading ? <p className="small muted">Loading…</p> : q.error ? <p className="small" style={{ color: 'var(--danger)' }}>{(q.error as Error).message}</p> : !q.data?.length ? <p className="small muted">No photos yet. On a phone, sign in as the operator, open Capture and take a photo.</p> : (
        <div className="grid g4" style={{ gap: 8 }}>
          {q.data.map((d) => (
            <a key={d.id} href={fileUrl(d)} target="_blank" rel="noreferrer" className="card" style={{ padding: 6, boxShadow: 'none', textDecoration: 'none', color: 'var(--text)' }}>
              {d.image ? <img src={fileUrl(d)} alt={d.kindLabel} style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 8, display: 'block' }} />
                : <div style={{ aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}><Icon name="file" size={32} /></div>}
              <div className="xs" style={{ marginTop: 4 }}><strong>{d.kindLabel}</strong>{d.docRef ? ` · ${d.docRef}` : ''}<br /><span className="muted">{d.by} · {ago(d.at)}</span></div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Camera / file upload used on the operator's phone. */
export function PhotoCapture({ docRef, compact, onUploaded }: { docRef?: string; compact?: boolean; onUploaded?: (d: Doc) => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState(docRef ? 'slip' : 'meter');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Doc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const send = async (f?: File) => {
    if (!f) return;
    setBusy(true); setErr(null); setPreview(f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
    try {
      const fd = new FormData(); fd.append('kind', kind); fd.append('note', note); fd.append('docRef', docRef ?? ''); fd.append('file', f);
      const d = await api<Doc>('/documents', { body: fd });
      setLast(d); setNote(''); onUploaded?.(d); qc.invalidateQueries({ queryKey: ['documents'] });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
    if (input.current) input.current.value = '';
  };
  return (
    <div className="stack-sm">
      {!compact && (
        <div className="field"><label htmlFor="pk">What is it?</label>
          <select id="pk" className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="meter">Meter display</option><option value="slip">Slip / challan</option><option value="bill">Electricity bill</option><option value="site">Shop floor / other</option></select></div>
      )}
      {!compact && <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. CO₂ cylinder delivery" />}
      <label className="btn" style={{ justifyContent: 'center', cursor: 'pointer' }}>
        <Icon name="camera" size={18} />{busy ? 'Uploading…' : compact ? 'Attach slip photo' : 'Take a photo'}
        <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" style={{ display: 'none' }} onChange={(e) => send(e.target.files?.[0])} disabled={busy} />
      </label>
      {preview && <img src={preview} alt="Last photo" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 8 }} />}
      {last && <div className="banner ok xs" style={{ padding: 8 }}><Icon name="check" size={16} />Saved on the plant server{last.savedAs ? `: ${last.savedAs}` : ''}</div>}
      {err && <div className="banner block xs" style={{ padding: 8 }}>{err}</div>}
    </div>
  );
}

export function PhoneDrawer({ onClose }: { onClose: () => void }) {
  const ip = useNetwork();
  const url = `${appBase()}/`;
  const local = ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  return (
    <Drawer title="Open on your phone" onClose={onClose}>
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        {local ? <div className="banner warn">Could not find this computer's Wi-Fi address. Open the app using the computer's IP address instead of localhost.</div> : <Qr text={url} size={220} label="QR code to open CarbonKhata on a phone" />}
        <div><strong className="num" style={{ fontSize: 18 }}>{url}</strong></div>
        <p className="small muted">Phone and computer must be on the same Wi-Fi. Scan with the phone camera, then sign in (the operator account suits a phone). If it does not open, allow Node.js through the Windows firewall on private networks.</p>
        {ip && <p className="xs muted">Demo controls and device pages on a phone: {`${location.protocol}//${ip}:5174/#/devices`}</p>}
      </div>
    </Drawer>
  );
}
