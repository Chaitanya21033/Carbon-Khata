// Tiny event bus so manual entries made in the app also show up in the live data-flow view.
type Handler<T> = (p: T) => void;
export interface ManualEntryEvent { registerId: string; line: string; qty: number; device: 'stores' | 'line' | 'paint' | 'docs'; queued: boolean }

const handlers = new Set<Handler<ManualEntryEvent>>();
export const bus = {
  emit(e: ManualEntryEvent) { handlers.forEach((h) => h(e)); },
  on(h: Handler<ManualEntryEvent>) { handlers.add(h); return () => { handlers.delete(h); }; },
};

export function deviceFor(registerId: string): ManualEntryEvent['device'] {
  if (registerId === 'PROD') return 'line';
  if (['PAINT', 'THINNER', 'HARDENER', 'SLUDGE'].includes(registerId)) return 'paint';
  if (['GRID_KWH', 'GRID_KVAH', 'PF', 'MD_KVA', 'BILL_INR'].includes(registerId)) return 'docs';
  return 'stores';
}
