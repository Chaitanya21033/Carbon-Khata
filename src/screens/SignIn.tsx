import { useRef, useState } from 'react';
import { PERSONAS, useStore, type Role } from '../state/store';
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

export default function SignIn() {
  const { s, actions, t, notify } = useStore();
  const [role, setRole] = useState<Role>('custodian');
  const [phone, setPhone] = useState('98765 43210');
  const [stage, setStage] = useState<'phone' | 'otp'>('phone');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const send = () => {
    if (phone.replace(/\D/g, '').length !== 10) return notify('Enter a 10-digit mobile number');
    setStage('otp'); notify('Demo OTP sent: use any 6 digits');
    setTimeout(() => refs.current[0]?.focus(), 50);
  };
  const verify = () => {
    if (otp.join('').length !== 6) return notify('Enter all 6 digits');
    actions.signIn(role);
    location.hash = '/';
  };

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
        <p className="xs hero-extra" style={{ opacity: 0.6 }}>Prototype. Every company, figure and event here is simulated dummy data.</p>
      </section>
      <section className="panel">
        <div className="row-between">
          <h2>{t('signIn')}</h2>
          <Seg label={t('language')} value={s.lang} onChange={actions.setLang} options={[{ v: 'en', l: 'English' }, { v: 'hi', l: 'हिन्दी' }]} />
        </div>
        <div className="stack-sm">
          <span className="label-text">{t('choosePersona')}</span>
          {(Object.keys(PERSONAS) as Role[]).map((r) => (
            <button key={r} className="persona" aria-pressed={role === r} onClick={() => setRole(r)}>
              <span className="qa-ic" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--primary-soft)', color: 'var(--primary)', display: 'grid', placeItems: 'center', flex: 'none' }}><Icon name={ICON[r]} /></span>
              <span><strong className="small">{s.lang === 'hi' ? PERSONAS[r].titleHi : PERSONAS[r].title}</strong><br /><span className="xs muted">{HINT[r]}</span></span>
            </button>
          ))}
        </div>
        {stage === 'phone' ? (
          <div className="stack-sm">
            <div className="field"><label htmlFor="ph">{t('phone')}</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}><span className="input" style={{ width: 64, flex: 'none', display: 'grid', placeItems: 'center' }}>+91</span>
                <input id="ph" className="input" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} /></div>
            </div>
            <button className="btn primary block" onClick={send}>{t('sendOtp')}</button>
          </div>
        ) : (
          <div className="stack-sm">
            <span className="label-text">Enter the 6-digit code sent to +91 {phone} <span className="muted">(demo: any digits)</span></span>
            <div className="otp">
              {otp.map((v, i) => (
                <input key={i} ref={(el) => (refs.current[i] = el)} inputMode="numeric" maxLength={1} aria-label={`Digit ${i + 1}`} value={v}
                  onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(-1); const n = [...otp]; n[i] = d; setOtp(n); if (d && i < 5) refs.current[i + 1]?.focus(); }}
                  onKeyDown={(e) => { if (e.key === 'Backspace' && !otp[i] && i) refs.current[i - 1]?.focus(); if (e.key === 'Enter') verify(); }}
                  onPaste={(e) => { const d = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split(''); if (d.length) { e.preventDefault(); setOtp([...d, ...Array(6 - d.length).fill('')]); } }} />
              ))}
            </div>
            <div className="row">
              <button className="btn" onClick={() => setOtp(['1', '2', '3', '4', '5', '6'])}>Fill demo code</button>
              <button className="btn primary" style={{ flex: 1 }} onClick={verify}>{t('verify')}</button>
            </div>
            <button className="btn ghost sm" onClick={() => setStage('phone')}>Change number</button>
          </div>
        )}
      </section>
    </div>
  );
}
