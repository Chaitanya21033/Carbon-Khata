// Product-side view of the live plant, built from the API twin snapshot (GET /live/state + SSE "twin" events).
// Shapes mirror the reference prototype so the screens read the same fields.
import type { MarketBlock, Source } from './grid';

export type DeviceId = 'meters' | 'stores' | 'line' | 'paint' | 'docs' | 'grid';
export type PacketKind = 'meter' | 'entry' | 'production' | 'rollup' | 'export' | 'resolve' | 'market' | 'passport' | 'credit';
export interface Packet { id: string; t: number; device: DeviceId; kind: PacketKind; registerId?: string; qty?: number; label: string; flagged?: { rule: string; reason: string }; delay?: number; target?: 'out_dash' | 'out_oem' | 'out_bank' | 'out_reg' }
export interface SimEvent { id: number; t: number; level: 'info' | 'ok' | 'warn' | 'block' | 'flow'; text: string }
export interface Quarantined { id: string; t: number | string; device: DeviceId; registerId: string; line: 'issued' | 'received' | 'reading'; qty: number; suggested?: number; rule: string; reason: string; docRef: string; month: string; kind?: string }
export interface LivePoint { t: number; comp: number; weld: number; paint: number; light: number; util: number; kva: number; dg: number; solar: number; bess: number; genset: number; imp: number; exp: number; price: number }
export type OemId = 'A' | 'B' | 'C';
export const OEMS: Record<OemId, { name: string; sub: string; steelEf: number; steelNote: string }> = {
  A: { name: 'OEM A', sub: 'Commercial vehicles (domestic)', steelEf: 2.3, steelNote: 'BF-BOF steel, India average' },
  B: { name: 'OEM B', sub: 'Construction equipment', steelEf: 2.3, steelNote: 'BF-BOF steel, India average' },
  C: { name: 'OEM C', sub: 'Export to EU (CBAM)', steelEf: 1.55, steelNote: 'Mill-certified lower-carbon steel' },
};
export interface Token { id: number; station: number; oem?: OemId | null; order?: string | null; since?: number | null }
export interface Passport { id: number; oem: OemId; order: string; t: number; started: number; kwh: number; s1: number; s2: number; steel: number; steelKg: number; total: number; renewableShare: number; publicCode?: string; finishedAt?: string }
export const STATIONS = [
  { id: 'cut', label: 'Cutting', mins: 45, cap: 2 },
  { id: 'weld', label: 'Welding & fab', mins: 150, cap: 4 },
  { id: 'blast', label: 'Shot blast', mins: 40, cap: 2 },
  { id: 'paint', label: 'Paint & oven', mins: 110, cap: 3 },
  { id: 'qc', label: 'Inspection', mins: 30, cap: 2 },
];
export const METERS = [
  { id: 'comp', label: 'Compressor' }, { id: 'weld', label: 'Welding bay' }, { id: 'paint', label: 'Paint shop & oven' }, { id: 'light', label: 'Lighting' }, { id: 'util', label: 'Utilities & office' },
] as const;
export const DEVICES: { id: DeviceId; label: string; sub: string }[] = [
  { id: 'meters', label: 'Energy meters', sub: '5 sub-meters, 1-min smart-meter feed' },
  { id: 'stores', label: 'Stores phone', sub: 'Gas, diesel, steel, oil' },
  { id: 'line', label: 'Line supervisor', sub: 'Bodies finished' },
  { id: 'paint', label: 'Paint-shop phone', sub: 'Paint, thinner, sludge' },
  { id: 'docs', label: 'Bills & invoices', sub: 'Photos, PDFs' },
  { id: 'grid', label: 'IEX feed & EMS', sub: 'Prices + dispatch, 15-min' },
];

type BlockLog = { t: number; block: number; supply: Record<Source, number>; export: number; load: number; price: number; naiveImport: number; plantNet: number; cost: number; naiveCost: number; kg: number; naiveKg: number; evening: boolean; peakKw: number; naivePeakKw: number; shifted: number; gas: number };
type Last24 = { blocks: number; kwh: Record<Source, number>; cost: number; naiveCost: number; kg: number; naiveKg: number; eve: number; naiveEve: number; peak: number; naivePeak: number; export: number; shifted: number; gas: number };
type Today = { kwh: Record<Source, number>; costInr: number; exportKwh: number; exportInr: number; kgMarket: number; kgLocation: number; kgMarginal: number; peakKw: number; peakEveningImportKwh: number; shiftedKwh: number; gasScm: number };

export interface Snapshot {
  clock: number; contractKva: number; pf: number; flexQueue: number; meterCum: number; meterKwh: Record<string, number>; shift: string; block: number; month: string; kw: number; kgToday: number;
  today: { bodies: number; kwh: number; diesel: number; lpg: number; co2: number; peakKva: number; packets: number; flagged: number; posted: number };
  totals: { packets: number; posted: number; flagged: number }; last: LivePoint; series: LivePoint[]; events: SimEvent[]; quarantine: Quarantined[]; tokens: Token[];
  oemToday: Record<OemId, number>; machineAlerts: { t: number; machine: string; text: string }[]; online: Record<DeviceId, boolean>; queued: Record<DeviceId, number>;
  ems: {
    settings: { enabled: boolean; carbonPrice: number; greenCapKw: number; reserveSoc: number; solver: string }; solarKwp: number; bess: { capKwh: number; powerKw: number; soc: number };
    gen: { kw: number; on: boolean }; market: MarketBlock[]; tomorrow: MarketBlock[]; current: MarketBlock | null; plan: { block: number; bess: number; genset: boolean; export: boolean; flexOn: boolean; buy: Source; greenKw: number; shed: number; reason: string };
    flows: Record<string, number>; today: Today; naive: { costInr: number; kg: number; peakKw: number; peakEveningKwh: number; exportInr: number }; blockLog: BlockLog[];
    decisions: { t: number; block: number; text: string; mode: string; savedInr: number; avoidedKg: number }[]; totals: Record<string, number>; last24: Last24 | null;
    drEvents: number; drKwh: number; islandMin: number; cloud: number; spikeUntil: number; stressEventUntil: number;
  };
}

const EMPTY24 = (): Last24 => ({ blocks: 0, kwh: { solar: 0, bess: 0, genset: 0, green: 0, rtm: 0, dam: 0, discom: 0 }, cost: 0, naiveCost: 0, kg: 0, naiveKg: 0, eve: 0, naiveEve: 0, peak: 0, naivePeak: 0, export: 0, shifted: 0, gas: 0 });

/** Engine-shaped, read-only view of the snapshot. Actions go to the API through the provider. */
export function toEngine(s: Snapshot, passports: Passport[], subscribe: (fn: (p: Packet) => void) => () => void, actions: { resolve: (id: string, action: 'fix' | 'confirm' | 'reject', value?: number) => void; setEms: (patch: Record<string, unknown>) => void }) {
  const ems = {
    ...s.ems,
    last: s.ems.last24,
    last24: () => s.ems.last24 ?? EMPTY24(),
    current: (b: number) => (b === s.block && s.ems.current ? s.ems.current : s.ems.market[b]),
  };
  return {
    ...s, ems, passports, contractKva: s.contractKva,
    queues: Object.fromEntries(Object.entries(s.queued ?? {}).map(([k, v]) => [k, Array.from({ length: v as number })])) as Record<DeviceId, unknown[]>,
    market: s.ems.current ?? s.ems.market[s.block] ?? ({ rtm: 0, stress: 0 } as MarketBlock),
    onPacket: subscribe,
    resolve: actions.resolve,
    setEms: actions.setEms,
    running: true,
  };
}
export type LiveEngine = ReturnType<typeof toEngine>;
export type SimEngine = LiveEngine;
