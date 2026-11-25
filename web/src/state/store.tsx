// API-backed store. Same shape as the reference prototype's in-browser store (s, d, actions), but every value
// comes from the CarbonKhata API (GET /workspace and friends) and every action is a REST call followed by a refetch.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuditEvent, EmissionFactor, Issue, IssueState, LedgerEntry, LineType, MeasureAssessment, Month, MonthClose, Register } from '../domain/types';
import { buildIndex, type LedgerIndex } from '../domain/ledger';
import { setFactors, setPlant } from '../domain/seed';
import { translator, type Lang } from '../i18n';
import { api, getToken, idemKey, setToken } from '../api/client';
import type { MonthEmissions } from '../domain/emissions';

export type Role = 'operator' | 'custodian' | 'owner' | 'oem' | 'cluster' | 'admin';
export const PERSONAS: Record<Role, { name: string; title: string; titleHi: string }> = {
  operator: { name: 'Ramesh', title: 'Store keeper (Operator)', titleHi: 'स्टोर कीपर (ऑपरेटर)' },
  custodian: { name: 'Priya', title: 'Accounts & ESG custodian', titleHi: 'अकाउंट्स व ईएसजी कस्टोडियन' },
  owner: { name: 'Plant owner', title: 'Managing director (Owner)', titleHi: 'प्रबंध निदेशक (मालिक)' },
  oem: { name: 'OEM / brand ESG team', title: 'OEM or brand viewer', titleHi: 'ओईएम / ब्रांड व्यूअर' },
  cluster: { name: 'Cluster coordinator', title: 'Cluster coordinator (association)', titleHi: 'क्लस्टर समन्वयक' },
  admin: { name: 'Ops admin', title: 'CarbonKhata platform admin', titleHi: 'प्लेटफ़ॉर्म एडमिन' },
};

// Live bindings (ES modules): screens import these as values; they update when the workspace loads.
export let CURRENT_MONTH: Month = '2026-11';
export let REGISTERS: Register[] = [];
export let PLANT_MONTHS: Month[] = [];
export let BILL_MONTHS: Month[] = [];

export interface MeterReading { id: string; meter: string; value: number; confidence: number; source: string; at: string; by: string }
export interface ExportRecord { id: string; kind: string; period: string; sha: string; by: string; at: string; bytes: number }
export interface ShareLink { id: string; audience: 'verifier' | 'lender'; expires: string; created: string; revoked?: boolean }
export interface OemComment { id: string; month?: Month; text: string; at: string; status: 'open' | 'done' }
export interface Case { id: string; supplier: string; cluster: string; sponsor: string; associate: string; stage: number; daysInStage: number; daysTotal: number; sample: boolean }
export interface WizardState { step: number; company: string; udyam: string; gstin: string; consent: boolean; product: string; unit: string; contractDemand: string; utility: string; registers: string[]; importSummary?: { rows: number; months: number; registers: number; issues: Record<string, number>; intensity?: number; kwhPerUnit?: number; source: string } }
export type VintageStatus = 'monitoring' | 'submitted' | 'validated' | 'verified' | 'issued';
export interface Vintage { status: VintageStatus; history: { status: VintageStatus; at: string; by: string }[]; serials?: string; tonnes?: number; buyer?: string }
export interface CreditState { alloc: Record<string, number>; vintages: Record<string, Vintage>; pricePerT: number }
export interface Me { id: string; name: string; email: string; title?: string; titleHi?: string; role: Role; readOnly: boolean; tenant: { id: string; kind: string; name: string; plant?: string; code?: string } }

interface Workspace {
  role: Role; plant: { id: string; tenant: string; plant: string; product?: { name: string; nameHi: string; unit: string }; contractDemandKva: number; utility?: string; oem?: string; udyam?: string; gstin?: string } | null;
  registers: Register[]; plantMonths: Month[]; openMonth: Month; factors: EmissionFactor[]; closes: Record<Month, MonthClose>; issueStates: Record<string, IssueState>;
  derived: { issues: Issue[]; emissions: MonthEmissions[]; dq: Record<Month, number>; dqAvg: number; tariff: number; gridEf: number };
  entries: LedgerEntry[]; held?: unknown[]; measures: MeasureAssessment[]; consent: 'summary' | 'detailed' | null; comments: OemComment[]; exportsLog: ExportRecord[]; shareLinks: ShareLink[];
  meterReadings?: MeterReading[]; audit?: AuditEvent[]; cases?: Case[]; credits: CreditState; fmcg: { recalledLots: string[]; overrides: Record<string, 'pass' | 'fail' | 'pending'>; notified: string[] };
}

const WIZARD0: WizardState = { step: 0, company: '', udyam: '', gstin: '', consent: false, product: 'Tipper body', unit: 'nos', contractDemand: '450', utility: 'State DISCOM', registers: ['DIESEL', 'LPG', 'CO2_GAS', 'HR_SHEET', 'PAINT', 'HYD_OIL', 'WATER_SUPPLY', 'SCRAP_HR'] };
const PREF_KEY = 'ck_prefs';
const QUEUE_KEY = 'ck_offline_queue';
type Result = { ok: true; msg?: string } | { ok: false; msg: string };
type QueuedEntry = LedgerEntry & { idem: string };

function loadPrefs(): { lang: Lang; theme: 'light' | 'dark' } { try { return { lang: 'en', theme: 'light', ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') }; } catch { return { lang: 'en', theme: 'light' }; } }
function loadQueue(): QueuedEntry[] { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); } catch { return []; } }

function useStoreValue() {
  const qc = useQueryClient();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [wizard, setWizardState] = useState<WizardState>(WIZARD0);
  const [offline, setOfflineState] = useState(false);
  const [queue, setQueue] = useState<QueuedEntry[]>(loadQueue);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const notify = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } document.documentElement.dataset.theme = prefs.theme; document.documentElement.lang = prefs.lang; }, [prefs]);
  useEffect(() => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* ignore */ } }, [queue]);

  // session
  useEffect(() => {
    if (!getToken()) { setAuthChecked(true); return; }
    api<Me>('/me').then(setMe).catch(() => setToken('')).finally(() => setAuthChecked(true));
    const out = () => { setMe(null); qc.clear(); };
    window.addEventListener('ck-signed-out', out);
    return () => window.removeEventListener('ck-signed-out', out);
  }, [qc]);

  const ws = useQuery({ queryKey: ['workspace', me?.id, me?.role], queryFn: () => api<Workspace>('/workspace'), enabled: !!me && me.role !== 'cluster' && me.tenant.kind !== 'brand', staleTime: 5_000 });
  const w = ws.data;
  if (w) {
    CURRENT_MONTH = w.openMonth; REGISTERS = w.registers ?? []; PLANT_MONTHS = w.plantMonths ?? []; BILL_MONTHS = w.plantMonths ?? [];
    if (w.plant) setPlant({ tenant: w.plant.tenant, plant: w.plant.plant, product: w.plant.product, contractDemandKva: w.plant.contractDemandKva, utility: w.plant.utility, oem: w.plant.oem, udyam: w.plant.udyam, gstin: w.plant.gstin });
    setFactors(w.factors ?? []);
  }

  const s = useMemo(() => ({
    role: (me?.role ?? null) as Role | null, me, lang: prefs.lang, theme: prefs.theme,
    entries: w?.entries ?? [], issueStates: w?.issueStates ?? {}, closes: w?.closes ?? {}, measures: w?.measures ?? [], factors: w?.factors ?? [], audit: w?.audit ?? [],
    queue, offline, meterReadings: w?.meterReadings ?? [], consent: w?.consent ?? null, shareLinks: w?.shareLinks ?? [], exportsLog: w?.exportsLog ?? [], comments: w?.comments ?? [],
    cases: w?.cases ?? [], wizard, readOnly: me?.readOnly ? 'Read-only support session' : null,
    credits: w?.credits ?? { alloc: { SOLAR: 0.6 }, vintages: {}, pricePerT: 900 },
    fmcg: w?.fmcg ?? { recalledLots: [], overrides: {}, notified: [] },
    held: w?.held ?? [], plant: w?.plant ?? null,
  }), [me, prefs, w, queue, offline, wizard]);

  const d = useMemo(() => {
    const idx: LedgerIndex = buildIndex(w?.entries ?? []);
    const issues = w?.derived.issues ?? [];
    const openIssues = issues.filter((i) => (w?.issueStates[i.id]?.status ?? 'open') === 'open');
    return { idx, issues, openIssues, emissions: w?.derived.emissions ?? [], dq: w?.derived.dq ?? {}, dqAvg: w?.derived.dqAvg ?? 0, tariff: w?.derived.tariff ?? 0, gridEf: w?.derived.gridEf ?? 0.71 };
  }, [w]);

  const refresh = useCallback(() => { qc.invalidateQueries({ queryKey: ['workspace'] }); }, [qc]);
  const isLocked = (m: Month) => s.closes[m]?.status === 'closed' || s.closes[m]?.status === 'in_review';

  /** Run an API call; refresh; toast errors. Returns a Result synchronously-optimistic for screens that expect one. */
  const run = useCallback((p: Promise<unknown>, ok?: string, after?: () => void): Result => {
    p.then(() => { refresh(); if (ok) notify(ok); after?.(); }).catch((e: Error) => notify(e.message));
    return { ok: true, msg: ok };
  }, [notify, refresh]);

  const postEntry = (q: QueuedEntry) => api<{ result: string; hold?: { rule: string; reason: string } }>('/ledger/entries', { body: { registerId: q.registerId, month: q.month, line: q.line, qty: q.qty, docRef: q.docRef, reason: q.reason, source: q.source }, headers: { 'Idempotency-Key': q.idem } });

  const actions = {
    signedIn: (token: string, m: Me) => { setToken(token); setMe(m); qc.clear(); },
    signIn: (_role: Role) => { /* sign-in is OTP based: see SignIn screen */ },
    signOut: () => { setToken(''); setMe(null); qc.clear(); location.hash = '/'; },
    setLang: (lang: Lang) => setPrefs((p) => ({ ...p, lang })),
    setTheme: (theme: 'light' | 'dark') => setPrefs((p) => ({ ...p, theme })),
    setOffline: (v: boolean) => setOfflineState(v),

    addEntry: (e: { registerId: string; month: Month; line: LineType; qty: number; docRef?: string; reason?: string; source?: LedgerEntry['source'] }): Result => {
      if (s.readOnly) return { ok: false, msg: 'Read-only support session: changes are disabled.' };
      if (isLocked(e.month)) return { ok: false, msg: 'This month is closed. Ask the owner to reopen it.' };
      if (!(e.qty > 0) && e.line !== 'opening') return { ok: false, msg: 'Enter a quantity above zero.' };
      const q: QueuedEntry = { id: idemKey(), status: 'posted', by: me?.name ?? '', at: new Date().toISOString(), source: e.source ?? 'app', idem: idemKey(), ...e };
      if (offline) { setQueue((x) => [...x, q]); return { ok: true, msg: 'Saved on this phone. Will sync when online.' }; }
      postEntry(q).then((r) => {
        refresh();
        notify(r.result === 'held' ? `${r.hold?.rule} held for review: ${r.hold?.reason}` : r.result === 'duplicate' ? 'Already posted (same idempotency key)' : 'Saved');
      }).catch((err: Error) => notify(err.message));
      return { ok: true, msg: 'Sending…' };
    },
    syncQueue: async () => {
      if (offline || !queue.length) return;
      let n = 0;
      const left: QueuedEntry[] = [];
      for (const q of queue) { try { const r = await postEntry(q); if (r.result !== 'duplicate') n++; } catch { left.push(q); } }
      setQueue(left); refresh(); notify(`${n} entries synced${left.length ? `, ${left.length} still waiting` : ''}`);
    },
    correct: (registerId: string, month: Month, line: LineType, newQty: number, reason: string): Result => {
      if (isLocked(month)) return { ok: false, msg: 'Month is locked. Reopen it first (owner, with reason).' };
      if (!reason.trim()) return { ok: false, msg: 'A reason is required.' };
      return run(api('/ledger/lines/correct', { body: { registerId, month, line, qty: newQty, reason } }), 'Corrected (reversal + new entry)');
    },
    reverse: (id: string, reason: string) => run(api(`/ledger/entries/${id}/reverse`, { body: { reason } }), 'Reversed'),
    resolveIssue: (id: string, status: IssueState['status'], note?: string): Result => {
      if (status !== 'open' && status !== 'dismissed' && !note?.trim()) return { ok: false, msg: 'Add a note explaining why this value is real.' };
      return run(api(`/validation/issues/${encodeURIComponent(id)}/decide`, { body: { status, note } }));
    },
    bulkResolve: (ids: string[], note: string) => run(api('/validation/issues/bulk-accept', { body: { ids, note } }), `${ids.length} issues accepted`),
    decideHeld: (id: string, action: 'fix' | 'confirm' | 'reject', value?: number) => run(api(id.startsWith('q') ? `/validation/meter-glitch/${id}/decide` : `/validation/held/${id}/decide`, { body: { action, value } }), action === 'reject' ? 'Discarded' : 'Posted to the ledger'),
    monthAction: (month: Month, action: 'submit' | 'approve' | 'return' | 'reopen', note?: string): Result => {
      if (action === 'reopen' && !note?.trim()) return { ok: false, msg: 'A reason is required to reopen.' };
      return run(api(`/periods/${month}/close`, { body: { action, note } }), `Month ${action === 'submit' ? 'submitted' : action === 'approve' ? 'closed' : action === 'reopen' ? 'reopened' : 'returned'}`);
    },
    setMeasure: (code: string, patch: Partial<MeasureAssessment>) => run(api(`/measures/${code}`, { method: 'PATCH', body: patch })),
    setConsent: (consent: 'summary' | 'detailed' | null) => run(api('/sharing/consent', { body: { consent } }), consent ? `Sharing: ${consent}` : 'Sharing revoked'),
    addShareLink: (audience: ShareLink['audience'], days: number) => run(api('/sharing/links', { body: { audience, days } }), 'Link created'),
    revokeShareLink: (id: string) => run(api(`/sharing/links/${id}/revoke`, { method: 'POST' }), 'Link revoked'),
    logExport: (r: Omit<ExportRecord, 'id' | 'by' | 'at'>) => run(api('/exports/log', { body: r })),
    addMeterReading: (r: { meter: string; value: number; confidence: number; source: string }) => run(api('/meters/incomer/readings', { body: r }), 'Reading saved'),
    addFactorVersion: (f: EmissionFactor) => run(api('/factors', { body: { code: f.code, kgco2e_per_unit: f.kgco2e_per_unit, valid_from: f.valid_from, source: f.source, status: f.status } }), `New version of ${f.code} published`),
    resetFactors: () => notify('Factor versions are append-only. Publish a new version instead.'),
    moveCase: (id: string, stage: number) => run(api(`/onboarding/cases/${id}/move`, { body: { stage } })),
    addCase: (supplier: string, cluster: string, sponsor: string) => run(api('/onboarding/cases', { body: { supplier, cluster, sponsor } }), 'Lead added'),
    oemRequest: (text: string, month?: Month) => run(api('/oem/requests', { body: { text, month } }), 'Request sent to the supplier'),
    closeComment: (id: string) => run(api(`/oem/requests/${id}/close`, { method: 'POST' })),
    setAlloc: (_project: string, share: number) => run(api('/credits/allocation', { method: 'PUT', body: { share } })),
    setCreditPrice: (p: number) => run(api('/credits/price', { method: 'PUT', body: { price: p } })),
    requestVerification: (month: string, tonnes: number) => run(api('/credits/verify', { body: { month, tonnes } }), 'Monitoring report submitted to the verifier'),
    retireCredits: (month: string, buyer: string) => run(api('/credits/transfer', { body: { month, buyer } }), 'Transferred'),
    flagLot: (lot: string, reason: string) => run(api('/fmcg/recall', { body: { lot, reason } }), `Lot ${lot} flagged: recall traced`, () => qc.invalidateQueries({ queryKey: ['fmcg'] })),
    clearLot: (lot: string) => run(api(`/fmcg/lots/${lot}/clear`, { method: 'POST' }), 'Recall closed', () => qc.invalidateQueries({ queryKey: ['fmcg'] })),
    setTestResult: (key: string, status: 'pass' | 'fail' | 'pending') => { const [code, name] = key.split('|'); return run(api(`/fmcg/batches/${code}/tests/${encodeURIComponent(name)}/override`, { body: { status } }), undefined, () => qc.invalidateQueries({ queryKey: ['fmcg'] })); },
    notifyRecall: (lot: string, who: string[]) => run(api('/fmcg/recall/notify', { body: { lot, who } }), 'Distributors notified', () => qc.invalidateQueries({ queryKey: ['fmcg'] })),
    setWizard: (patch: Partial<WizardState>) => setWizardState((x) => ({ ...x, ...patch })),
    impersonate: (reason: string) => { api<{ token: string; me: Me }>('/auth/support-session', { body: { reason } }).then((r) => { sessionStorage.setItem('ck_admin_token', getToken()); setToken(r.token); setMe(r.me); qc.clear(); }).catch((e: Error) => notify(e.message)); },
    endImpersonation: () => { const t = sessionStorage.getItem('ck_admin_token'); if (t) { setToken(t); sessionStorage.removeItem('ck_admin_token'); api<Me>('/me').then(setMe); qc.clear(); } },
    reset: () => notify('Demo data is reset from the simulator control panel, not from the product.'),
    refresh,
  };

  // auto-sync the offline queue when going back online
  useEffect(() => { if (!offline && queue.length) void actions.syncQueue(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  return { s, d, actions, toast, notify, t: translator(prefs.lang), isLocked, loading: ws.isLoading, error: ws.error as Error | null, authChecked, me };
}

type Store = ReturnType<typeof useStoreValue>;
const Ctx = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const v = useStoreValue();
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider missing');
  return v;
}
