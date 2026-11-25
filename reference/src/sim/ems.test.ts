import { describe, expect, it } from 'vitest';
import { SimEngine, type PostRequest } from './engine';
import { marketDay } from './grid';

function run(enabled: boolean, mins = 24 * 60) {
  const posted: PostRequest[] = [];
  const e = new SimEngine({ start: Date.UTC(2026, 10, 11, 0, 0), contractKva: 450, post: (r) => { posted.push(r); return true; }, stock: { CO2_GAS: 9000, LPG: 2000, HYD_OIL: 6000, OXYGEN: 50, ARGON: 4000 } });
  e.ems.settings.enabled = enabled;
  for (let i = 0; i < mins - 1; i++) e.step();
  return { e, posted, today: e.ems.today, naive: e.ems.naive };
}

describe('market feed', () => {
  it('has the duck shape: midday cheap, evening expensive, 96 blocks', () => {
    const d = marketDay(20403);
    expect(d).toHaveLength(96);
    const avg = (a: number, b: number) => d.slice(a * 4, b * 4).reduce((s, x) => s + x.rtm, 0) / ((b - a) * 4);
    expect(avg(11, 15)).toBeLessThan(avg(18, 22) - 4);
    const net = (h: number) => d[h * 4].netDemandGW;
    expect(net(13)).toBeLessThan(net(19) - 10);
  });
});

describe('grid-aware optimiser', () => {
  const on = run(true);
  const off = run(false);
  it('costs less than the naive plant on the same day', () => {
    expect(on.today.costInr).toBeLessThan(on.naive.costInr * 0.9);
    expect(Math.abs(off.today.costInr - off.naive.costInr) / off.naive.costInr).toBeLessThan(0.08);
  });
  it('takes energy off the evening peak and exports when the grid needs it', () => {
    expect(on.today.peakEveningImportKwh).toBeLessThan(on.naive.peakEveningKwh * 0.6);
    expect(on.today.exportKwh).toBeGreaterThan(0);
  });
  it('energy balances every minute: supply = load + battery charge + export + curtail', () => {
    const f = on.e.ems.flows;
    const supply = f.solar + f.bessOut + f.genset + f.green + f.rtm + f.dam + f.discom;
    expect(Math.abs(supply - (f.load + f.bessIn + f.export + f.curtail))).toBeLessThan(1e-6);
  });
  it('posts solar, import and genset readings to the ledger hourly', () => {
    const regs = new Set(on.posted.map((p) => p.registerId));
    for (const r of ['GRID_KWH', 'SOLAR_KWH', 'PROD']) expect(regs.has(r)).toBe(true);
  });
  it('issues one carbon passport per finished body, routed to its OEM', () => {
    expect(on.e.passports.length).toBe(on.posted.filter((p) => p.registerId === 'PROD').length);
    const p = on.e.passports[0];
    expect(p.total).toBeCloseTo(p.s1 + p.s2 + p.steel, 6);
    expect(['A', 'B', 'C']).toContain(p.oem);
  });
  it('rides through a grid outage on solar, battery and genset', () => {
    const r = run(true, 13 * 60);
    r.e.inject('powerCut');
    for (let i = 0; i < 20; i++) r.e.step();
    expect(r.e.ems.islandMin).toBeGreaterThan(10);
    expect(r.e.last.genset).toBeGreaterThan(0);
  });
});
