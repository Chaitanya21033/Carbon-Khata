import { useEffect, useState } from 'react';
import { PERSONAS, useStore, type Role } from './state/store';
import SignIn from './screens/SignIn';
import { AdminOverview, Pipeline, DqCentre, Libraries, AuditSupport } from './screens/Admin';
import { OemOverview, OemProgramme } from './screens/Oem';
import { PLANT } from './domain/seed';
import { useSim } from './live/LiveProvider';
import { Icon } from './ui/Icon';
import { Drawer, Seg } from './ui/kit';
import Live from './screens/Live';
import Energy from './screens/Energy';
import CaptureChecks from './screens/Capture';
import { OemParts } from './screens/Oem';
import { Credits, Brsr } from './screens/Sustain';
import Cluster from './screens/Cluster';
import Onboarding from './screens/Onboarding';
import SourcesDrawer from './screens/Sources';
import { PhoneDrawer, useNetwork } from './ui/Shopfloor';
import Batches, { BatchPublic } from './screens/Batches';
import { PartPublic } from './screens/Oem';

function CreditsBrsr() {
  const [t, setT] = useState<'credits' | 'brsr'>('credits');
  return <div className="stack"><Seg label="Section" value={t} onChange={setT} options={[{ v: 'credits', l: 'Carbon credits' }, { v: 'brsr', l: 'BRSR report' }]} />{t === 'credits' ? <Credits /> : <Brsr />}</div>;
}

type R = { id: string; label: string; short: string; icon: string; el: () => JSX.Element; layer: string };
const ALL: Record<string, Omit<R, 'layer'>> = {
  live: { id: 'live', label: 'Live plant', short: 'Live', icon: 'bolt', el: Live },
  energy: { id: 'energy', label: 'Energy & grid', short: 'Energy', icon: 'sun', el: Energy },
  capture: { id: 'capture', label: 'Capture & checks', short: 'Capture', icon: 'camera', el: CaptureChecks },
  parts: { id: 'parts', label: 'Part passports', short: 'Parts', icon: 'passport', el: OemParts },
  batches: { id: 'batches', label: 'Batch tracing (FMCG)', short: 'Batches', icon: 'qr', el: Batches },
  credits: { id: 'credits', label: 'Credits & BRSR', short: 'Credits', icon: 'shield', el: CreditsBrsr },
  cluster: { id: 'cluster', label: 'Cluster symbiosis', short: 'Cluster', icon: 'users', el: Cluster },
  onboarding: { id: 'onboarding', label: 'Onboard a supplier', short: 'Onboard', icon: 'layers', el: Onboarding },
  suppliers: { id: 'suppliers', label: 'Supplier overview', short: 'Suppliers', icon: 'grid', el: OemOverview },
  programme: { id: 'programme', label: 'Supplier programme', short: 'Programme', icon: 'kanban', el: OemProgramme },
  admin: { id: 'admin', label: 'Platform overview', short: 'Overview', icon: 'grid', el: AdminOverview },
  pipeline: { id: 'pipeline', label: 'Onboarding pipeline', short: 'Pipeline', icon: 'kanban', el: Pipeline },
  dqc: { id: 'dqc', label: 'Data-quality centre', short: 'DQ', icon: 'alert', el: DqCentre },
  libraries: { id: 'libraries', label: 'Factor & rule libraries', short: 'Libraries', icon: 'layers', el: Libraries },
  audit: { id: 'audit', label: 'Audit & support', short: 'Audit', icon: 'shield', el: AuditSupport },
};
const ROLE_ROUTES: Record<Role, [string, string][]> = {
  operator: [['capture', 'Shop floor'], ['live', 'Shop floor']],
  custodian: [['live', 'Measure'], ['capture', 'Measure'], ['energy', 'Optimise'], ['parts', 'Report'], ['credits', 'Monetise'], ['cluster', 'Scale'], ['onboarding', 'Scale']],
  owner: [['live', 'Measure'], ['capture', 'Measure'], ['energy', 'Optimise'], ['parts', 'Report'], ['credits', 'Monetise'], ['cluster', 'Scale'], ['onboarding', 'Scale']],
  oem: [['suppliers', 'Supply chain'], ['parts', 'Passports'], ['programme', 'Supply chain']],
  cluster: [['cluster', 'Cluster']],
  admin: [['admin', 'Platform'], ['pipeline', 'Platform'], ['dqc', 'Platform'], ['libraries', 'Platform'], ['audit', 'Platform'], ['onboarding', 'Scale'], ['live', 'Demo plant'], ['energy', 'Demo plant'], ['batches', 'Demo plant'], ['cluster', 'Demo plant']],
};
const FMCG_ROUTES: [string, string][] = [['batches', 'Report'], ['cluster', 'Scale']];
const BRAND_ROUTES: [string, string][] = [['batches', 'Passports']];
/** Routes depend on role and on the kind of tenant (vehicle OEM vs FMCG brand; body-builder vs co-packer). */
const routesFor = (role: Role, tenantId?: string, tenantKind?: string): R[] =>
  (tenantId === 'afl' ? FMCG_ROUTES : tenantKind === 'brand' ? BRAND_ROUTES : ROLE_ROUTES[role]).map(([id, layer]) => ({ ...ALL[id], layer }));

function useRoute(): [string, (r: string) => void] {
  const get = () => location.hash.replace(/^#\/?/, '');
  const [r, setR] = useState(get());
  useEffect(() => { const h = () => { setR(get()); window.scrollTo(0, 0); }; window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  return [r, (x) => { location.hash = `/${x}`; }];
}

export default function App() {
  const { s, actions, toast, authChecked } = useStore();
  const [canBack, setCanBack] = useState(false);
  useEffect(() => { const h = () => setCanBack(true); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  const { engine } = useSim();
  const [route, go] = useRoute();
  const [sources, setSources] = useState(false);
  const [phone, setPhone] = useState(false);
  const [more, setMore] = useState(false);
  useNetwork();

  if (route.startsWith('b-')) return <><BatchPublic id={route.slice(2)} />{toast && <div className="toast" role="status">{toast}</div>}</>;
  if (route.startsWith('p-')) return <PartPublic id={route.slice(2)} />;
  if (!authChecked) return <div className="content"><div className="card">Loading…</div></div>;
  if (!s.role) return <><SignIn />{toast && <div className="toast" role="status">{toast}</div>}</>;
  const ROUTES = routesFor(s.role, s.me?.tenant.id, s.me?.tenant.kind);
  const persona = { name: s.me?.name ?? PERSONAS[s.role].name, title: s.me?.title ?? PERSONAS[s.role].title };
  const back = () => { if (canBack && history.length > 1) history.back(); else go(ROUTES[0].id); };
  const cur = ROUTES.find((r) => r.id === route) ?? ROUTES[0];
  const Page = cur.el;
  const badge = (id: string) => (id === 'live' ? engine?.quarantine.length ?? 0 : 0);
  void Drawer;
  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand"><span className="brand-mark">CK</span><span className="label">CarbonKhata</span></div>
        <nav className="nav">
          {Array.from(new Set(ROUTES.map((r) => r.layer))).map((layer) => (
            <div key={layer} style={{ display: 'contents' }}>
              <div className="nav-section">{layer}</div>
              {ROUTES.filter((r) => r.layer === layer).map((r) => (
                <button key={r.id} aria-current={cur.id === r.id ? 'page' : undefined} onClick={() => go(r.id)} title={r.label}>
                  <Icon name={r.icon} /><span className="label">{r.label}</span>{badge(r.id) > 0 && <span className="count">{badge(r.id)}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="label" style={{ marginTop: 'auto', padding: 14 }}>
          <div className="card" style={{ padding: 12, boxShadow: 'none' }}>
            <div className="small" style={{ fontWeight: 600 }}>{persona.name}</div>
            <div className="xs muted">{persona.title}</div>
            <div className="xs muted" style={{ marginTop: 4 }}>{s.me?.tenant.name ?? PLANT.tenant} · demo data</div>
            <button className="btn sm block" style={{ marginTop: 8 }} onClick={() => { actions.signOut(); location.hash = ''; }}><Icon name="logout" size={16} />Switch login</button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="iconbtn" onClick={back} aria-label="Back" title="Back" disabled={cur.id === ROUTES[0].id && !canBack}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="arrowright" size={18} /></span></button>
          <span className="title">{cur.label}</span>
          <span className="spacer" />
          <span className="chip warn desktop-only">Demo data</span>
          <button className="btn sm desktop-only" onClick={() => setPhone(true)} title="Open this app on a phone on the same Wi-Fi"><Icon name="phone" size={16} />Open on phone</button>
          <button className="btn sm" onClick={() => setSources(true)}><Icon name="globe" size={16} /><span className="desktop-only">Data sources</span></button>
          <span className="chip neutral desktop-only" title="Signed in as">{persona.title}</span>
          <button className="iconbtn mobile-only" onClick={() => { actions.signOut(); location.hash = ''; }} aria-label="Switch login"><Icon name="logout" size={18} /></button>
          <button className="iconbtn" onClick={() => actions.setTheme(s.theme === 'light' ? 'dark' : 'light')} aria-label="Toggle dark mode"><Icon name={s.theme === 'light' ? 'moon' : 'sun'} size={18} /></button>
        </header>
        {s.readOnly && <div className="banner warn" style={{ borderRadius: 0 }}><Icon name="eye" />Read-only support view (audited, visible to the supplier). Reason: {s.readOnly}<button className="btn sm" onClick={actions.endImpersonation}>End session</button></div>}
        <main id="main" className="content"><Page /></main>
      </div>
      <nav className="bottomnav" aria-label="Main navigation">
        {ROUTES.slice(0, 4).map((r) => (
          <button key={r.id} aria-current={cur.id === r.id ? 'page' : undefined} onClick={() => go(r.id)}><Icon name={r.icon} size={22} />{r.short}</button>
        ))}
        <button onClick={() => setMore(true)} aria-current={ROUTES.slice(4).includes(cur) ? 'page' : undefined}><Icon name="menu" size={22} />More</button>
      </nav>
      {more && (
        <Drawer title="More" onClose={() => setMore(false)}>
          <div className="stack-sm">
            {ROUTES.slice(4).map((r) => <button key={r.id} className="persona" onClick={() => { go(r.id); setMore(false); }}><Icon name={r.icon} /><span>{r.label}</span></button>)}
            <button className="persona" onClick={() => { setSources(true); setMore(false); }}><Icon name="globe" /><span>Data sources & APIs</span></button>
          </div>
        </Drawer>
      )}
      {sources && <SourcesDrawer onClose={() => setSources(false)} />}
      {phone && <PhoneDrawer onClose={() => setPhone(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
