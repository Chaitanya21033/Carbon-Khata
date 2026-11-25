// External data sources. Each adapter tries the real API and falls back to a clearly labelled simulation,
// so the prototype always runs. Status is reported to the "Data sources" panel.
export type SourceStatus = 'live' | 'simulated' | 'needs_key' | 'checking' | 'adapter';
export interface SourceInfo { id: string; name: string; provider: string; role: string; status: SourceStatus; note: string; at?: number }

export const SITE = { lat: 22.8, lon: 86.18, name: 'Jamshedpur', zone: 'IN-EA' };

const KEY_STORE = 'ck2_em_key';
export function getEmKey(): string { try { return localStorage.getItem(KEY_STORE) ?? ''; } catch { return ''; } }
export function setEmKey(k: string) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } }

async function getJSON(url: string, headers: Record<string, string> = {}, timeoutMs = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- Open-Meteo: solar irradiance forecast for the plant site (free, no key) ----------
export interface SolarHour { time: string; ghi: number; cloud: number }
export interface SolarForecast { source: 'live' | 'simulated'; hours: SolarHour[]; note: string }

function simulatedSolar(): SolarHour[] {
  const now = new Date();
  const start = new Date(now); start.setMinutes(0, 0, 0);
  return Array.from({ length: 48 }, (_, i) => {
    const d = new Date(start.getTime() + i * 3600_000);
    const h = (d.getUTCHours() + 5.5) % 24;
    const sun = Math.max(0, Math.sin((Math.PI * (h - 6.2)) / 12.6));
    const cloud = 20 + 25 * Math.max(0, Math.sin(i / 7));
    return { time: d.toISOString(), ghi: Math.round(820 * sun * (1 - cloud / 160)), cloud: Math.round(cloud) };
  });
}

export async function fetchSolarForecast(): Promise<SolarForecast> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${SITE.lat}&longitude=${SITE.lon}&hourly=shortwave_radiation,cloud_cover&forecast_days=2&timezone=Asia%2FKolkata`;
  try {
    const j = await getJSON(url);
    const hours: SolarHour[] = j.hourly.time.map((t: string, i: number) => ({ time: t, ghi: j.hourly.shortwave_radiation[i] ?? 0, cloud: j.hourly.cloud_cover[i] ?? 0 }));
    return { source: 'live', hours, note: `Open-Meteo forecast for ${SITE.name}, fetched ${new Date().toLocaleTimeString('en-IN')}` };
  } catch (e) {
    return { source: 'simulated', hours: simulatedSolar(), note: `Live call not possible here (${(e as Error).message || 'blocked'}); showing a modelled clear-sky curve. Works when the app runs locally.` };
  }
}

/** Expected PV output (kWh) from hourly GHI for a plant of `kwp` with an 0.8 performance ratio. */
export const pvKwh = (hours: SolarHour[], kwp: number) => hours.reduce((s, h) => s + (h.ghi / 1000) * kwp * 0.8, 0);

// ---------- Electricity Maps: live carbon intensity of the regional grid (free personal key) ----------
export interface GridCarbon { source: 'live' | 'simulated' | 'needs_key'; gPerKwh: number; zone: string; note: string; datetime?: string }

export async function fetchGridCarbon(zone = SITE.zone, simulatedValue = 710): Promise<GridCarbon> {
  const key = getEmKey();
  if (!key) return { source: 'needs_key', gPerKwh: simulatedValue, zone, note: 'Add a free Electricity Maps key in Data sources to use the live figure. Using the simulated grid factor.' };
  try {
    const j = await getJSON(`https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${encodeURIComponent(zone)}`, { 'auth-token': key });
    return { source: 'live', gPerKwh: j.carbonIntensity, zone: j.zone ?? zone, datetime: j.datetime, note: `Electricity Maps, zone ${j.zone ?? zone}` };
  } catch (e) {
    return { source: 'simulated', gPerKwh: simulatedValue, zone, note: `Live call failed (${(e as Error).message || 'blocked'}); using the simulated grid factor.` };
  }
}

// ---------- Claude vision (through the artifact viewer's `sample` capability) ----------
type SampleFn = ((input: string, opts?: Record<string, unknown>) => Promise<{ text: string }>) & { json: (input: string, opts?: Record<string, unknown>) => Promise<unknown> };
let samplePromise: Promise<SampleFn | null> | null = null;
export function getSample(): Promise<SampleFn | null> {
  if (samplePromise) return samplePromise;
  const host = (window as unknown as { claude?: { use: (n: string) => Promise<unknown> } }).claude;
  samplePromise = host?.use ? host.use('sample').then((x) => (x as SampleFn) ?? null).catch(() => null) : Promise.resolve(null);
  return samplePromise;
}

export interface MeterRead { value: number; unit: string; confidence: number; meterType: string; source: 'claude' | 'simulated'; note?: string }
export interface BillRead { kwh?: number; kvah?: number; pf?: number; mdKva?: number; amountInr?: number; period?: string; utility?: string; source: 'claude' | 'simulated'; note?: string }

export async function readMeterPhoto(img: Blob, fallback: number): Promise<MeterRead> {
  const sample = await getSample();
  if (sample) {
    try {
      const r = await sample.json(
        'This photo shows an electricity or utility meter. Read the main cumulative register shown on the display. Reply with JSON only: {"value": number (no separators), "unit": "kWh"|"kVAh"|"kVA"|"m3"|"unknown", "confidence": number between 0 and 1, "meterType": short description}. If you cannot read it, set value to 0 and confidence to 0.',
        { images: [img], modelTier: 'quick' },
      ) as { value: number; unit: string; confidence: number; meterType: string };
      return { value: Number(r.value) || 0, unit: r.unit || 'kWh', confidence: Number(r.confidence) || 0, meterType: r.meterType || 'meter', source: 'claude' };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'error';
      return { value: fallback, unit: 'kWh', confidence: 0.6, meterType: 'meter', source: 'simulated', note: `Claude could not read it (${code}); simulated value shown.` };
    }
  }
  return { value: fallback, unit: 'kWh', confidence: 0.9, meterType: 'HT trivector meter', source: 'simulated', note: 'Claude vision is available when the page is opened inside Claude; simulated reading shown.' };
}

export async function readBillPhoto(img: Blob): Promise<BillRead> {
  const sample = await getSample();
  if (sample) {
    try {
      const r = await sample.json(
        'This is a photo or scan of an electricity bill (likely Indian, HT or LT industrial). Extract the billing-period figures. Reply with JSON only: {"kwh": number|null, "kvah": number|null, "pf": number|null, "mdKva": number|null, "amountInr": number|null, "period": "YYYY-MM" or null, "utility": string|null}. Numbers without separators or currency symbols. Use null for anything not shown.',
        { images: [img], modelTier: 'default' },
      ) as Record<string, number | string | null>;
      const n = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
      return { kwh: n(r.kwh), kvah: n(r.kvah), pf: n(r.pf), mdKva: n(r.mdKva), amountInr: n(r.amountInr), period: (r.period as string) ?? undefined, utility: (r.utility as string) ?? undefined, source: 'claude' };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'error';
      return { ...simBill(), note: `Claude could not read it (${code}); simulated values shown.` };
    }
  }
  return { ...simBill(), note: 'Claude vision is available when the page is opened inside Claude; simulated values shown.' };
}
const simBill = (): BillRead => ({ kwh: 168420, kvah: 177280, pf: 0.95, mdKva: 468, amountInr: 1282950, period: '2026-10', utility: 'State DISCOM (demo)', source: 'simulated' });

// ---------- GSTIN / Udyam verification (adapter: Setu, Cashfree and similar KYB APIs) ----------
export interface KybResult { ok: boolean; name?: string; status?: string; state?: string; source: 'adapter'; note: string }
const STATE: Record<string, string> = { '20': 'Jharkhand', '21': 'Odisha', '27': 'Maharashtra', '29': 'Karnataka', '06': 'Haryana', '09': 'Uttar Pradesh', '24': 'Gujarat', '33': 'Tamil Nadu', '19': 'West Bengal', '07': 'Delhi' };
export async function verifyGstin(g: string): Promise<KybResult> {
  const v = g.trim().toUpperCase();
  const ok = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);
  await new Promise((r) => setTimeout(r, 600));
  return ok
    ? { ok, name: 'Shakti Pressings Pvt Ltd (demo)', status: 'Active', state: STATE[v.slice(0, 2)] ?? `State code ${v.slice(0, 2)}`, source: 'adapter', note: 'Format and state code checked locally. In production this calls a GSTN-licensed KYB API (e.g. Setu, Cashfree) for name and status.' }
    : { ok, source: 'adapter', note: 'Not a valid 15-character GSTIN.' };
}
export async function verifyUdyam(u: string): Promise<KybResult> {
  const ok = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(u.trim().toUpperCase());
  await new Promise((r) => setTimeout(r, 500));
  return ok ? { ok, status: 'Registered · Micro/Small (demo)', source: 'adapter', note: 'Format checked locally; a KYB provider returns enterprise class and activity in production.' } : { ok, source: 'adapter', note: 'Format: UDYAM-XX-00-0000000' };
}

export const STATIC_SOURCES: SourceInfo[] = [
  { id: 'iex', name: 'IEX market prices & bidding', provider: 'Indian Energy Exchange member API (via a trading member)', role: 'DAM, G-DAM and RTM prices; place bids', status: 'adapter', note: 'IEX API access is for registered members. The prototype runs a simulated 96-block feed through the same adapter.' },
  { id: 'kyb', name: 'GSTIN & Udyam checks', provider: 'GSTN-licensed KYB APIs (Setu, Cashfree)', role: 'Verify a supplier at onboarding', status: 'adapter', note: 'Format and state checks run locally; live lookup needs a provider key and a server.' },
];
