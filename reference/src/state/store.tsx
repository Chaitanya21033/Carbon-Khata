import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuditEvent, EmissionFactor, IssueState, LedgerEntry, LineType, MeasureAssessment, Month, MonthClose } from '../domain/types';
import { buildSeed, FACTORS, PLANT } from '../domain/seed';
import { buildIndex, correctLine, isDuplicateDoc, postEntry, value } from '../domain/ledger';
import { closeBlockers, dqScore, runValidation } from '../domain/validation';
import { effectiveTariff, factorFor, monthEmissions } from '../domain/emissions';
import { MEASURE_SEED } from '../domain/measures';
import { SAMPLE_CASES, type Case } from '../domain/samples';
import { translator, type Lang } from '../i18n';
import { uid } from '../domain/util';
import { OPEN_MONTH } from '../domain/synth';
import { bus, deviceFor } from '../sim/bus';
import type { PostRequest } from '../sim/engine';

export type Role = 'operator' | 'custodian' | 'owner' | 'oem' | 'cluster' | 'admin';
export const PERSONAS: Record<Role, { name: string; title: string; titleHi: string }> = {
  operator: { name: 'Ramesh', title: 'Store keeper (Operator)', titleHi: 'स्टोर कीपर (ऑपरेटर)' },
  custodian: { name: 'Priya', title: 'Accounts & ESG custodian', titleHi: 'अकाउंट्स व ईएसजी कस्टोडियन' },
  owner: { name: 'Plant owner', title: 'Managing director (Owner)', titleHi: 'प्रबंध निदेशक (मालिक)' },
  oem: { name: 'OEM / brand ESG team', title: 'OEM or brand viewer', titleHi: 'ओईएम / ब्रांड व्यूअर' },
  cluster: { name: 'Cluster coordinator', title: 'Cluster coordinator (association)', titleHi: 'क्लस्टर समन्वयक' },
  admin: { name: 'Ops admin', title: 'CarbonKhata platform admin', titleHi: 'प्लेटफ़ॉर्म एडमिन' },
};

export const CURRENT_MONTH: Month = OPEN_MONTH;

export interface MeterReading { id: string; meter: string; value: number; confidence: number; source: 'photo_ai' | 'manual'; at: string; by: string; image?: string }
export interface ExportRecord { id: string; kind: string; period: string; sha: string; by: string; at: string; bytes: number }
export interface ShareLink { id: string; audience: 'verifier' | 'lender'; expires: string; created: string; revoked?: boolean }
export interface OemComment { id: string; month?: Month; text: string; at: string; status: 'open' | 'done' }

export interface WizardState { step: number; company: string; udyam: string; gstin: string; consent: boolean; product: string; unit: string; contractDemand: string; utility: string; registers: string[]; importSummary?: { rows: number; months: number; registers: number; issues: Record<string, number>; intensity?: number; kwhPerUnit?: number; source: string } }

export interface State {
  role: Role | null; lang: Lang; theme: 'light' | 'dark';
  entries: LedgerEntry[]; issueStates: Record<string, IssueState>; closes: Record<Month, MonthClose>;
  measures: MeasureAssessment[]; factors: EmissionFactor[]; audit: AuditEvent[];
  queue: LedgerEntry[]; offline: boolean; meterReadings: MeterReading[];
  consent: 'summary' | 'detailed' | null; shareLinks: ShareLink[]; exportsLog: ExportRecord[]; comments: OemComment[];
  cases: Case[]; wizard: WizardState; readOnly: string | null;
  credits: CreditState;
  fmcg: { recalledLots: string[]; overrides: Record<string, 'pass' | 'fail' | 'pending'>; notified: string[] };
}
export type VintageStatus = 'monitoring' | 'submitted' | 'validated' | 'verified' | 'issued';
export interface Vintage { status: VintageStatus; history: { status: VintageStatus; at: string; by: string }[]; serials?: string; tonnes?: number; buyer?: string }
export interface CreditState { alloc: Record<string, number>; vintages: Record<string, Vintage>; pricePerT: number }

const seed = buildSeed();
export const REGISTERS = seed.registers;
export const PLANT_MONTHS = seed.plantMonths;
export const BILL_MONTHS = seed.billMonths;
const STORAGE_KEY = 'ck2_demo_v1';
export const SIM_KEY = 'ck2_sim_v1';

function initial(): State {
  return {
    role: null, lang: 'en', theme: 'light',
    entries: seed.entries, issueStates: {}, closes: {}, measures: MEASURE_SEED, factors: FACTORS,
    audit: [{ id: 'a0', at: '2026-11-02T10:00:00.000Z', actor: 'Field associate', role: 'field', action: 'import', entity: PLANT.tenant, detail: `History import: ${seed.entries.length} ledger lines, ${seed.plantMonths.length} plant-months, ${seed.billMonths.length} bills` }],
    queue: [], offline: false, meterReadings: [
      { id: 'm1', meter: 'Main incomer (HT)', value: 4806120, confidence: 0.97, source: 'photo_ai', at: '2026-11-09T09:10:00.000Z', by: 'Ramesh' },
      { id: 'm2', meter: 'Main incomer (HT)', value: 4811240, confidence: 0.93, source: 'photo_ai', at: '2026-11-10T09:05:00.000Z', by: 'Ramesh' },
    ],
    consent: 'summary', shareLinks: [], exportsLog: [], comments: [], cases: SAMPLE_CASES,
    wizard: { step: 0, company: '', udyam: '', gstin: '', consent: false, product: 'Tipper body', unit: 'nos', contractDemand: '450', utility: 'State DISCOM', registers: ['DIESEL', 'LPG', 'CO2_GAS', 'HR_SHEET', 'PAINT', 'HYD_OIL', 'WATER_SUPPLY', 'SCRAP_HR'] },
    readOnly: null,
    credits: { alloc: { SOLAR: 0.6, EE: 0.0 }, vintages: {}, pricePerT: 900 },
    fmcg: { recalledLots: [], overrides: {}, notified: [] },
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...initial(), ...JSON.parse(raw) };
  } catch { /* storage unavailable: run in memory */ }
  return initial();
}

type Result = { ok: true; msg?: string } | { ok: false; msg: string };

function useStoreValue() {
  const [s, setS] = useState<State>(load);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const notify = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ } }, 800);
    document.documentElement.dataset.theme = s.theme;
    document.documentElement.lang = s.lang;
    return () => window.clearTimeout(id);
  }, [s]);

  const actor = s.role ? PERSONAS[s.role].name : 'system';
  const audit = (st: State, action: string, entity: string, detail: string): AuditEvent[] =>
    [{ id: uid('au'), at: new Date().toISOString(), actor: st.role ? PERSONAS[st.role].name : 'system', role: st.role ?? '', action, entity, detail }, ...st.audit].slice(0, 400);

  // ---------- derived ----------
  const derived = useMemo(() => {
    const idx = buildIndex(s.entries);
    const issues = runValidation({ registers: REGISTERS, idx, plantMonths: PLANT_MONTHS, billMonths: BILL_MONTHS, contractDemandKva: PLANT.contractDemandKva });
    const emissions = PLANT_MONTHS.map((m) => monthEmissions(REGISTERS, idx, s.factors, m));
    const dq: Record<Month, number> = {};
    for (const m of PLANT_MONTHS) {
      const missing = ['PROD', 'GRID_KWH', 'BILL_INR'].some((r) => value(idx, r, m, 'reading') === undefined);
      dq[m] = dqScore(m, issues, s.issueStates, s.closes[m], missing);
    }
    const dqAvg = PLANT_MONTHS.reduce((a, m) => a + dq[m], 0) / PLANT_MONTHS.length;
    const tariff = effectiveTariff(idx, PLANT_MONTHS);
    const gridEf = factorFor(s.factors, 'EF_GRID_IN', PLANT_MONTHS[PLANT_MONTHS.length - 1])!.kgco2e_per_unit;
    const openIssues = issues.filter((i) => (s.issueStates[i.id]?.status ?? 'open') === 'open');
    return { idx, issues, openIssues, emissions, dq, dqAvg, tariff, gridEf };
  }, [s.entries, s.issueStates, s.closes, s.factors]);

  const isLocked = (m: Month) => s.closes[m]?.status === 'closed' || s.closes[m]?.status === 'in_review';
  const guard = (): Result | null => (s.readOnly ? { ok: false, msg: 'Read-only support session: changes are disabled.' } : null);

  // ---------- actions ----------
  const actions = {
    signIn: (role: Role) => { setToast(null); setS((st) => ({ ...st, role, audit: audit({ ...st, role }, 'sign_in', 'session', PERSONAS[role].title) })); },
    signOut: () => setS((st) => ({ ...st, role: null, readOnly: null })),
    setLang: (lang: Lang) => setS((st) => ({ ...st, lang })),
    setTheme: (theme: 'light' | 'dark') => setS((st) => ({ ...st, theme })),
    setOffline: (offline: boolean) => setS((st) => ({ ...st, offline })),

    /** Create an entry from the shop floor. Offline → queued with an idempotency key. */
    addEntry: (e: { registerId: string; month: Month; line: LineType; qty: number; docRef?: string; reason?: string; source?: LedgerEntry['source'] }): Result => {
      const g = guard(); if (g) return g;
      if (isLocked(e.month)) return { ok: false, msg: 'This month is closed. Ask the owner to reopen it.' };
      if (!(e.qty > 0) && e.line !== 'opening') return { ok: false, msg: 'Enter a quantity above zero.' };
      const dup = isDuplicateDoc([...s.entries, ...s.queue], e.docRef);
      if (dup) return { ok: false, msg: `V10: this slip (${e.docRef}) was already entered on ${new Date(dup.at).toLocaleDateString('en-IN')}.` };
      const entry: LedgerEntry = { id: uid('ent'), status: 'posted', by: actor, at: new Date().toISOString(), source: e.source ?? 'app', idempotencyKey: uid('idem'), ...e };
      setS((st) => {
        // carry-forward: first entry of a new month in a full register gets an opening line = last closing
        const extra: LedgerEntry[] = [];
        const reg = REGISTERS.find((r) => r.id === e.registerId);
        const all = [...st.entries, ...st.queue];
        if (reg?.mode === 'full' && !all.some((x) => x.registerId === e.registerId && x.month === e.month && x.line === 'opening')) {
          const prev = PLANT_MONTHS[PLANT_MONTHS.length - 1];
          const idx = buildIndex(all);
          const c = value(idx, e.registerId, prev, 'closing') ?? 0;
          extra.push({ ...entry, id: uid('ent'), line: 'opening', qty: c, docRef: undefined, idempotencyKey: uid('idem'), reason: 'Carry-forward from previous closing' });
        }
        if (st.offline) return { ...st, queue: [...st.queue, ...extra, entry] };
        let entries = st.entries;
        for (const x of [...extra, entry]) entries = postEntry(entries, x).entries;
        return { ...st, entries, audit: audit(st, 'create', reg?.label ?? e.registerId, `${e.line} ${e.qty} for ${e.month}${e.docRef ? ` (${e.docRef})` : ''}`) };
      });
      bus.emit({ registerId: e.registerId, line: e.line, qty: e.qty, device: deviceFor(e.registerId), queued: s.offline });
      return { ok: true, msg: s.offline ? 'Saved on this phone. Will sync when online.' : 'Saved' };
    },

    /** Batch of clean entries from the live simulator (already checked at packet level). */
    postSim: (reqs: PostRequest[]) => setS((st) => {
      let entries = st.entries;
      for (const r of reqs) {
        if (st.closes[r.month]?.status === 'closed') continue;
        entries = postEntry(entries, { id: uid('sim'), registerId: r.registerId, month: r.month, line: r.line, qty: r.qty, status: 'posted', by: r.by, at: new Date().toISOString(), source: r.source, docRef: r.docRef, reason: r.reason, idempotencyKey: r.idempotencyKey }).entries;
      }
      return entries === st.entries ? st : { ...st, entries };
    }),

    syncQueue: () => setS((st) => {
      if (st.offline || !st.queue.length) return st;
      let entries = st.entries; let posted = 0;
      for (const q of st.queue) { const r = postEntry(entries, q); entries = r.entries; if (!r.duplicate) posted++; }
      notify(`${posted} entries synced`);
      return { ...st, entries, queue: [], audit: audit(st, 'sync', 'offline queue', `${posted} entries posted (idempotent)`) };
    }),

    correct: (registerId: string, month: Month, line: LineType, newQty: number, reason: string): Result => {
      const g = guard(); if (g) return g;
      if (isLocked(month)) return { ok: false, msg: 'Month is locked. Reopen it first (owner, with reason).' };
      if (!reason.trim()) return { ok: false, msg: 'A reason is required.' };
      setS((st) => {
        const before = value(buildIndex(st.entries), registerId, month, line);
        const { entries } = correctLine(st.entries, registerId, month, line, newQty, reason, actor);
        return { ...st, entries, audit: audit(st, 'correct', REGISTERS.find((r) => r.id === registerId)?.label ?? registerId, `${month} ${line}: ${before} → ${newQty}. Reason: ${reason}`) };
      });
      return { ok: true };
    },

    resolveIssue: (id: string, status: IssueState['status'], note?: string): Result => {
      const g = guard(); if (g) return g;
      if (status !== 'open' && status !== 'dismissed' && !note?.trim()) return { ok: false, msg: 'Add a note explaining why this value is real.' };
      setS((st) => ({ ...st, issueStates: { ...st.issueStates, [id]: { status, note, by: actor, at: new Date().toISOString() } }, audit: audit(st, `issue_${status}`, id.split('|')[0], `${id}${note ? ` — ${note}` : ''}`) }));
      return { ok: true };
    },

    bulkResolve: (ids: string[], note: string) => setS((st) => {
      const next = { ...st.issueStates };
      for (const id of ids) next[id] = { status: 'accepted', note, by: actor, at: new Date().toISOString() };
      return { ...st, issueStates: next, audit: audit(st, 'issue_bulk_accept', `${ids.length} issues`, note) };
    }),

    monthAction: (month: Month, action: 'submit' | 'approve' | 'return' | 'reopen', note?: string): Result => {
      const g = guard(); if (g) return g;
      const cur = s.closes[month] ?? { month, status: 'open', reopenedCount: 0, history: [] };
      if (action === 'submit') {
        const blockers = closeBlockers(month, derived.issues, s.issueStates);
        if (blockers.length) return { ok: false, msg: `${blockers.length} issue(s) must be fixed or confirmed first.` };
        if (s.role !== 'custodian' && s.role !== 'owner') return { ok: false, msg: 'Only the ESG custodian submits a month.' };
      }
      if ((action === 'approve' || action === 'return' || action === 'reopen') && s.role !== 'owner') return { ok: false, msg: 'Only the owner can approve, return or reopen.' };
      if (action === 'reopen' && !note?.trim()) return { ok: false, msg: 'A reason is required to reopen.' };
      const status = action === 'submit' ? 'in_review' : action === 'approve' ? 'closed' : action === 'return' ? 'open' : 'reopened';
      const next: MonthClose = { ...cur, status, reopenedCount: cur.reopenedCount + (action === 'reopen' ? 1 : 0), submittedBy: action === 'submit' ? actor : cur.submittedBy, approvedBy: action === 'approve' ? actor : cur.approvedBy, history: [...cur.history, { action, by: actor, at: new Date().toISOString(), note }] };
      setS((st) => ({ ...st, closes: { ...st.closes, [month]: next }, audit: audit(st, `month_${action}`, month, note ?? '') }));
      return { ok: true };
    },

    setMeasure: (code: string, patch: Partial<MeasureAssessment>) => setS((st) => ({ ...st, measures: st.measures.map((m) => (m.code === code ? { ...m, ...patch } : m)), audit: patch.status ? audit(st, 'measure_status', code, patch.status) : st.audit })),
    setConsent: (consent: State['consent']) => setS((st) => ({ ...st, consent, audit: audit(st, 'consent', 'OEM', consent ?? 'revoked') })),
    addShareLink: (audience: ShareLink['audience'], days: number) => setS((st) => ({ ...st, shareLinks: [{ id: uid('sl').slice(-10), audience, created: new Date().toISOString(), expires: new Date(Date.now() + days * 864e5).toISOString() }, ...st.shareLinks], audit: audit(st, 'share_link', audience, `${days} days`) })),
    revokeShareLink: (id: string) => setS((st) => ({ ...st, shareLinks: st.shareLinks.map((l) => (l.id === id ? { ...l, revoked: true } : l)), audit: audit(st, 'share_revoke', id, '') })),
    logExport: (r: Omit<ExportRecord, 'id' | 'by' | 'at'>) => setS((st) => ({ ...st, exportsLog: [{ ...r, id: uid('ex'), by: actor, at: new Date().toISOString() }, ...st.exportsLog], audit: audit(st, 'export', r.kind, `${r.period} sha256:${r.sha.slice(0, 12)}…`) })),
    addMeterReading: (r: Omit<MeterReading, 'id' | 'at' | 'by'>) => setS((st) => ({ ...st, meterReadings: [...st.meterReadings, { ...r, id: uid('mr'), at: new Date().toISOString(), by: actor }], audit: audit(st, 'meter_reading', r.meter, `${r.value} (${r.source}, conf ${r.confidence.toFixed(2)})`) })),
    addFactorVersion: (f: EmissionFactor) => setS((st) => {
      const factors = st.factors.map((x) => (x.code === f.code && x.valid_to === null && x.valid_from < f.valid_from ? { ...x, valid_to: prevDay(f.valid_from) } : x)).concat(f);
      return { ...st, factors, audit: audit(st, 'factor_publish', f.code, `v${f.version} = ${f.kgco2e_per_unit} from ${f.valid_from}`) };
    }),
    resetFactors: () => setS((st) => ({ ...st, factors: FACTORS, audit: audit(st, 'factor_reset', 'library', 'Restored v1') })),
    moveCase: (id: string, stage: number) => setS((st) => ({ ...st, cases: st.cases.map((c) => (c.id === id ? { ...c, stage, daysInStage: 0 } : c)), audit: audit(st, 'pipeline_move', st.cases.find((c) => c.id === id)?.supplier ?? id, `→ stage ${stage}`) })),
    addCase: (supplier: string, cluster: string, sponsor: string) => setS((st) => ({ ...st, cases: [{ id: uid('case'), supplier, cluster, sponsor, associate: '—', stage: 1, daysInStage: 0, daysTotal: 0, sample: true }, ...st.cases], audit: audit(st, 'lead_create', supplier, sponsor) })),
    oemRequest: (text: string, month?: Month) => setS((st) => ({ ...st, comments: [{ id: uid('cm'), text, month, at: new Date().toISOString(), status: 'open' }, ...st.comments], audit: audit(st, 'oem_request', PLANT.tenant, text) })),
    closeComment: (id: string) => setS((st) => ({ ...st, comments: st.comments.map((c) => (c.id === id ? { ...c, status: 'done' } : c)) })),
    setAlloc: (project: string, share: number) => setS((st) => ({ ...st, credits: { ...st.credits, alloc: { ...st.credits.alloc, [project]: share } }, audit: audit(st, 'claim_allocation', project, `${Math.round(share * 100)}% to carbon credits, ${Math.round((1 - share) * 100)}% to OEM value-chain claim`) })),
    setCreditPrice: (p: number) => setS((st) => ({ ...st, credits: { ...st.credits, pricePerT: p } })),
    /** Simulated verification pipeline: submitted → validated → verified (accredited verifier) → issued on registry. */
    requestVerification: (month: string, tonnes: number) => {
      const steps: [VintageStatus, string, number][] = [['submitted', 'ESG custodian', 0], ['validated', 'Verifier desk review (demo)', 2500], ['verified', 'Accredited verifier site check (demo)', 5500], ['issued', 'Registry (demo)', 8000]];
      for (const [status, by, delay] of steps) {
        window.setTimeout(() => setS((st) => {
          const v: Vintage = st.credits.vintages[month] ?? { status: 'monitoring', history: [] };
          const serials = status === 'issued' ? `CK-DEMO-${month.replace('-', '')}-${String(1).padStart(6, '0')} … ${String(Math.max(1, Math.floor(tonnes))).padStart(6, '0')}` : v.serials;
          const nv: Vintage = { ...v, status, tonnes: status === 'issued' ? Math.floor(tonnes) : v.tonnes, serials, history: [...v.history, { status, at: new Date().toISOString(), by }] };
          return { ...st, credits: { ...st.credits, vintages: { ...st.credits.vintages, [month]: nv } }, audit: audit(st, `credit_${status}`, `Vintage ${month}`, status === 'issued' ? `${Math.floor(tonnes)} t issued (demo serials)` : by) };
        }), delay);
      }
    },
    retireCredits: (month: string, buyer: string) => setS((st) => {
      const v = st.credits.vintages[month]; if (!v) return st;
      return { ...st, credits: { ...st.credits, vintages: { ...st.credits.vintages, [month]: { ...v, buyer } } }, audit: audit(st, 'credit_transfer', `Vintage ${month}`, `Transferred to ${buyer}`) };
    }),
    flagLot: (lot: string, reason: string) => setS((st) => st.fmcg.recalledLots.includes(lot) ? st : ({ ...st, fmcg: { ...st.fmcg, recalledLots: [...st.fmcg.recalledLots, lot] }, audit: audit(st, 'lot_recall', lot, reason) })),
    clearLot: (lot: string) => setS((st) => ({ ...st, fmcg: { ...st.fmcg, recalledLots: st.fmcg.recalledLots.filter((x) => x !== lot), notified: st.fmcg.notified.filter((x) => x !== lot) }, audit: audit(st, 'lot_recall_closed', lot, 'Cleared after investigation') })),
    setTestResult: (key: string, status: 'pass' | 'fail' | 'pending') => setS((st) => ({ ...st, fmcg: { ...st.fmcg, overrides: { ...st.fmcg.overrides, [key]: status } }, audit: audit(st, 'qc_result', key.split('|')[0], `${key.split('|')[1]}: ${status}`) })),
    notifyRecall: (lot: string, who: string[]) => setS((st) => ({ ...st, fmcg: { ...st.fmcg, notified: [...st.fmcg.notified, lot] }, audit: audit(st, 'recall_notice', lot, `Notified: ${who.join(', ')}`) })),
    setWizard: (patch: Partial<WizardState>) => setS((st) => ({ ...st, wizard: { ...st.wizard, ...patch } })),
    impersonate: (reason: string) => setS((st) => ({ ...st, role: 'owner', readOnly: reason, audit: audit(st, 'impersonate', PLANT.tenant, `Read-only view as owner, 30 min. Reason: ${reason}`) })),
    endImpersonation: () => setS((st) => ({ ...st, role: 'admin', readOnly: null })),
    reset: () => { try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(SIM_KEY); } catch { /* ignore */ } window.dispatchEvent(new Event('ck-reset-sim')); setS({ ...initial(), role: s.role, lang: s.lang, theme: s.theme }); notify('Demo data reset'); },
  };

  return { s, d: derived, actions, toast, notify, t: translator(s.lang), isLocked };
}

function prevDay(d: string) {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10);
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
