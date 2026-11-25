import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useStore, type Me, type Role } from '../state/store';
import { Icon } from '../ui/Icon';
import { Seg } from '../ui/kit';

const ICON: Record<Role, string> = { operator: 'phone', custodian: 'alert', owner: 'chart', oem: 'grid', cluster: 'users', admin: 'shield' };
const HINT: Record<Role, string> = {
  operator: 'Photos of meters and bills, register entries, on a phone',
  custodian: 'Data checks, corrections, batches, BRSR and credits',
  owner: 'Live plant, energy savings, credits, green finance',
  oem: 'Part and batch passports from consented suppliers only',
  cluster: 'Energy pool, resource exchange and shared savings across member plants',
  admin: 'Onboarding pipeline, data-quality centre, factor library, audit',
};

interface DemoUser { role: Role; email: string; name: string; title: string; titleHi: string; tenant: string; tenantCode?: string }

export default function SignIn() {
  const { s, actions, t, notify } = useStore();
  const users = useQuery({ queryKey: ['demo-users'], queryFn: () => api<DemoUser[]>('/auth/demo-users', { noAuth: true }), retry: 1 });
  const [email, setEmail] = useState('priya@vardhan.example');
  const pick = users.data?.find((u) => u.email === email);
  const role: Role = pick?.role ?? 'custodian';
  const [stage, setStage] = useState<'phone' | 'otp'>('phone');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [dev, setDev] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const send = () => {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return notify('Enter your work e-mail');
    setBusy(true);
    api<{ sent: boolean; devCode?: string }>('/auth/otp/request', { body: { email }, noAuth: true })
      .then((r) => { setStage('otp'); setDev(r.devCode ?? null); notify(r.devCode ? 'Code sent (dev mode: also printed in the API console)' : 'Code sent to your e-mail'); setTimeout(() => refs.current[0]?.focus(), 50); })
      .catch((e: Error) => notify(e.message)).finally(() => setBusy(false));
  };
  const verify = () => {
    const code = otp.join('');
    if (code.length !== 6) return notify('Enter all 6 digits');
    setBusy(true);
    api<{ token: string; me: Me }>('/auth/otp/verify', { body: { email, code, role }, noAuth: true })
      .then((r) => { actions.signedIn(r.token, r.me); location.hash = '/'; })
      .catch((e: Error) => notify(e.message)).finally(() => setBusy(false));
  };
  const phone = email;

  return (
    <div className="signin">
      <section className="hero">
        <div className="row"><span className="brand-mark" style={{ background: '#F2A900', color: '#0A3D28' }}>CK</span><strong style={{ fontFamily: 'var(--font-head)', fontSize: 20 }}>CarbonKhata</strong></div>
        <div className="stack">
          <h1 style={{ fontSize: 34, color: '#fff', maxWidth: 520 }}>{t('tagline')}</h1>
          <p style={{ maxWidth: 520, opacity: 0.85 }} className="hero-extra">The supplier-side ESG layer for MSME manufacturers. Paper registers in, OEM-ready Scope 1 and 2 data out, with every number traceable to a balanced register line.</p>
          <div className="grid g3 hero-extra" style={{ maxWidth: 560 }}>
            {[['24', 'months of plant history'], ['5', 'live data streams'], ['12', 'automatic checks']].map(([a, b]) => (
              <div key={b}><div style={{ fontFamily: 'var(--font-head)', fontSize: 26, fontWeight: 700, color: '#F2A900' }}>{a}</div><div className="small" style={{ opacity: 0.8 }}>{b}</div></div>
            ))}
          </div>
        </div>
        <p className="xs hero-extra" style={{ opacity: 0.6 }}>Every company, figure and event here is fictional dummy data.</p>
      </section>
      <section className="panel">
        <div className="row-between">
          <h2>{t('signIn')}</h2>
          <Seg label={t('language')} value={s.lang} onChange={actions.setLang} options={[{ v: 'en', l: 'English' }, { v: 'hi', l: 'हिन्दी' }]} />
        </div>
        <div className="stack-sm">
          <span className="label-text">{t('choosePersona')}</span>
          {users.isLoading && <div className="card small muted">Loading demo accounts…</div>}
          {users.error && <div className="banner block"><Icon name="alert" />Cannot reach the CarbonKhata server. Start the API (scripts\\dev.ps1) and reload.</div>}
          <div className="stack-sm" style={{ maxHeight: 330, overflowY: 'auto' }}>
          {users.data?.map((u) => (
            <button key={u.email} className="persona" aria-pressed={email === u.email} onClick={() => { setEmail(u.email); setStage('phone'); setOtp(['', '', '', '', '', '']); }}>
              <span className="qa-ic" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--primary-soft)', color: 'var(--primary)', display: 'grid', placeItems: 'center', flex: 'none' }}><Icon name={ICON[u.role]} /></span>
              <span><strong className="small">{s.lang === 'hi' ? u.titleHi : u.title}</strong><br /><span className="xs muted">{u.tenant} · {HINT[u.role]}</span></span>
            </button>
          ))}
          </div>
        </div>
        {stage === 'phone' ? (
          <div className="stack-sm">
            <div className="field"><label htmlFor="ph">Work e-mail</label>
              <input id="ph" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && send()} />
            </div>
            <button className="btn primary block" onClick={send} disabled={busy}>{busy ? 'Sending…' : t('sendOtp')}</button>
          </div>
        ) : (
          <div className="stack-sm">
            <span className="label-text">Enter the 6-digit code sent to {phone}{dev && <span className="muted"> (dev mode: code {dev}, also in the API console)</span>}</span>
            <div className="otp">
              {otp.map((v, i) => (
                <input key={i} ref={(el) => (refs.current[i] = el)} inputMode="numeric" maxLength={1} aria-label={`Digit ${i + 1}`} value={v}
                  onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(-1); const n = [...otp]; n[i] = d; setOtp(n); if (d && i < 5) refs.current[i + 1]?.focus(); }}
                  onKeyDown={(e) => { if (e.key === 'Backspace' && !otp[i] && i) refs.current[i - 1]?.focus(); if (e.key === 'Enter') verify(); }}
                  onPaste={(e) => { const d = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split(''); if (d.length) { e.preventDefault(); setOtp([...d, ...Array(6 - d.length).fill('')]); } }} />
              ))}
            </div>
            <div className="row">
              {dev && <button className="btn" onClick={() => setOtp(dev.split(''))}>Fill dev code</button>}
              <button className="btn primary" style={{ flex: 1 }} onClick={verify} disabled={busy}>{t('verify')}</button>
            </div>
            <button className="btn ghost sm" onClick={() => setStage('phone')}>Change e-mail</button>
          </div>
        )}
      </section>
    </div>
  );
}
