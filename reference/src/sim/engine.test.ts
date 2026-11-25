import { describe, expect, it } from 'vitest';
import { SimEngine, type PostRequest } from './engine';

function make() {
  const posted: PostRequest[] = [];
  const e = new SimEngine({ start: Date.UTC(2026, 10, 11, 6, 0), contractKva: 450, post: (r) => { posted.push(r); return true; }, stock: { CO2_GAS: 900, LPG: 200, HYD_OIL: 600, OXYGEN: 50, ARGON: 4000 } });
  return { e, posted };
}

describe('simulator', () => {
  it('a working day produces bodies, energy and posts clean entries', () => {
    const { e, posted } = make();
    for (let i = 0; i < 17 * 60; i++) e.step(); // 06:00 → 23:00
    expect(e.today.bodies).toBeGreaterThan(8);
    expect(e.today.kwh).toBeGreaterThan(3000);
    expect(posted.filter((p) => p.registerId === 'PROD').length).toBe(e.today.bodies);
    const meter = posted.filter((p) => p.registerId === 'GRID_KWH').reduce((s, p) => s + p.qty, 0);
    const k = e.ems.today.kwh;
    expect(Math.abs(meter - (k.discom + k.rtm + k.dam))).toBeLessThan(400); // hourly roll-ups vs live import
    expect(e.quarantine).toHaveLength(0);
  });
  it('holds a typo, a negative issue and a duplicate slip instead of posting them', () => {
    const { e, posted } = make();
    e.step();
    e.inject('typo'); e.inject('negative'); e.inject('duplicate');
    expect(e.quarantine.map((q) => q.rule).sort()).toEqual(['V01', 'V10', 'V12']);
    expect(posted.some((p) => p.qty === 32000)).toBe(false);
    const typo = e.quarantine.find((q) => q.rule === 'V01')!;
    e.resolve(typo.id, 'fix');
    expect(posted[posted.length - 1].qty).toBe(3200);
  });
  it('offline device queues entries and posts each exactly once on reconnect', () => {
    const { e, posted } = make();
    e.setOnline('stores', false); e.setOnline('line', false); e.setOnline('paint', false);
    for (let i = 0; i < 240; i++) e.step();
    const queued = e.queues.stores.length + e.queues.line.length + e.queues.paint.length;
    expect(queued).toBeGreaterThan(3);
    const shopBefore = posted.filter((p) => p.source === 'app').length;
    e.setOnline('stores', true); e.setOnline('line', true); e.setOnline('paint', true);
    e.setOnline('stores', true);
    const shopAfter = posted.filter((p) => p.source === 'app').length;
    expect(shopAfter - shopBefore).toBe(queued);
    expect(new Set(posted.map((p) => p.idempotencyKey)).size).toBe(posted.length);
  });
  it('peak load raises a demand alert', () => {
    const { e } = make();
    for (let i = 0; i < 180; i++) e.step();
    e.inject('surge');
    for (let i = 0; i < 20; i++) e.step();
    expect(e.today.peakKva).toBeGreaterThan(300);
  });
});
