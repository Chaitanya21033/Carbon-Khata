import { useEffect, useRef } from 'react';
import type { DeviceId, Packet, SimEngine } from './engine';
import { DEVICES } from './engine';
import { fmt } from '../domain/util';

// Diagram coordinates live in a 1200 × 500 viewBox.
type Box = { x: number; y: number; w: number; h: number };
const SRC_Y = [20, 113, 206, 299, 392];
const N: Record<string, Box> = {
  src_meters: { x: 20, y: SRC_Y[0], w: 200, h: 70 }, src_stores: { x: 20, y: SRC_Y[1], w: 200, h: 70 }, src_line: { x: 20, y: SRC_Y[2], w: 200, h: 70 },
  src_paint: { x: 20, y: SRC_Y[3], w: 200, h: 70 }, src_docs: { x: 20, y: SRC_Y[4], w: 200, h: 70 },
  gw: { x: 320, y: 175, w: 170, h: 120 },
  val: { x: 575, y: 120, w: 175, h: 110 }, quar: { x: 575, y: 345, w: 175, h: 100 },
  ledger: { x: 815, y: 40, w: 165, h: 110 }, emis: { x: 815, y: 260, w: 165, h: 110 },
  out_dash: { x: 1035, y: 40, w: 150, h: 76 }, out_oem: { x: 1035, y: 200, w: 150, h: 76 }, out_bank: { x: 1035, y: 360, w: 150, h: 76 },
};
const R = (b: Box) => ({ x: b.x + b.w, y: b.y + b.h / 2 });
const L = (b: Box) => ({ x: b.x, y: b.y + b.h / 2 });
type Pt = { x: number; y: number };
type Seg = [Pt, Pt, Pt, Pt];
const curve = (a: Pt, b: Pt): Seg => { const dx = (b.x - a.x) * 0.5; return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b]; };
const vcurve = (a: Pt, b: Pt): Seg => { const dy = (b.y - a.y) * 0.5; return [a, { x: a.x, y: a.y + dy }, { x: b.x, y: b.y - dy }, b]; };

const E: Record<string, Seg> = {
  ...Object.fromEntries(['meters', 'stores', 'line', 'paint', 'docs'].map((d) => [`src_${d}>gw`, curve(R(N[`src_${d}`]), { x: N.gw.x, y: N.gw.y + 20 + SRC_Y.indexOf(N[`src_${d}`].y) * 20 })])),
  'gw>val': curve(R(N.gw), L(N.val)),
  'val>ledger': curve(R(N.val), L(N.ledger)),
  'val>quar': vcurve({ x: N.val.x + N.val.w / 2, y: N.val.y + N.val.h }, { x: N.quar.x + N.quar.w / 2, y: N.quar.y }),
  'quar>ledger': [R(N.quar), { x: 800, y: N.quar.y + 50 }, { x: 760, y: N.ledger.y + 90 }, { x: N.ledger.x, y: N.ledger.y + 90 }],
  'ledger>emis': vcurve({ x: N.ledger.x + N.ledger.w / 2, y: N.ledger.y + N.ledger.h }, { x: N.emis.x + N.emis.w / 2, y: N.emis.y }),
  'emis>out_dash': curve(R(N.emis), L(N.out_dash)),
  'emis>out_oem': curve(R(N.emis), L(N.out_oem)),
  'emis>out_bank': curve(R(N.emis), L(N.out_bank)),
};
const pathD = (s: Seg) => `M${s[0].x},${s[0].y} C${s[1].x},${s[1].y} ${s[2].x},${s[2].y} ${s[3].x},${s[3].y}`;
const at = (s: Seg, t: number): Pt => {
  const u = 1 - t;
  return { x: u * u * u * s[0].x + 3 * u * u * t * s[1].x + 3 * u * t * t * s[2].x + t * t * t * s[3].x, y: u * u * u * s[0].y + 3 * u * u * t * s[1].y + 3 * u * t * t * s[2].y + t * t * t * s[3].y };
};

const COLORS = { meter: '#4C9BE8', entry: '#3FBF7F', production: '#F2A900', rollup: '#2EC4B6', export: '#A78BFA', resolve: '#3FBF7F', flagged: '#F0524A', market: '#F2C14E', passport: '#C084FC', credit: '#5EEAD4' };

function routeFor(p: Packet): { edges: string[]; ends: string[] } {
  const src = `src_${p.device === 'grid' ? 'meters' : p.device}`;
  if (p.kind === 'export' || p.kind === 'passport') return { edges: ['emis>out_oem'], ends: ['out_oem'] };
  if (p.kind === 'credit') return { edges: ['emis>out_bank'], ends: ['out_bank'] };
  if (p.kind === 'market') return { edges: [`${src}>gw`, 'gw>val', 'val>ledger'], ends: ['gw', 'val', 'ledger'] };
  if (p.kind === 'resolve') return { edges: ['quar>ledger', 'ledger>emis', 'emis>out_dash'], ends: ['ledger', 'emis', 'out_dash'] };
  const head = [`${src}>gw`, 'gw>val'];
  if (p.flagged) return { edges: [...head, 'val>quar'], ends: ['gw', 'val', 'quar'] };
  if (p.kind === 'meter') return { edges: [...head, 'val>ledger'], ends: ['gw', 'val', 'ledger'] };
  const out = p.kind === 'rollup' && Number(p.id.slice(1)) % 5 === 0 ? 'emis>out_bank' : 'emis>out_dash';
  return { edges: [...head, 'val>ledger', 'ledger>emis', out], ends: ['gw', 'val', 'ledger', 'emis', out.split('>')[1]] };
}

interface Particle { edges: Seg[]; ends: string[]; seg: number; t: number; color: string; r: number; start: number; speed: number }

export default function Pipeline({ engine, ledgerCount }: { engine: SimEngine; ledgerCount: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const nodes = useRef<Record<string, SVGGElement | null>>({});
  const parts = useRef<Particle[]>([]);

  const flash = (id: string) => {
    const el = nodes.current[id];
    if (!el) return;
    el.classList.remove('flash');
    void (el as unknown as HTMLElement).getBoundingClientRect();
    el.classList.add('flash');
  };

  useEffect(() => {
    const off = engine.onPacket((p) => {
      if (parts.current.length > 180) return;
      if (p.device === 'grid' || p.kind === 'passport' || p.kind === 'market' || p.kind === 'credit') return; // keep the flow as calm as the original
      const { edges, ends } = routeFor(p);
      const color = p.flagged ? COLORS.flagged : COLORS[p.kind];
      parts.current.push({ edges: edges.map((e) => E[e]), ends, seg: 0, t: 0, color, r: p.kind === 'production' ? 6 : p.flagged ? 6.5 : p.kind === 'meter' ? 3.6 : 5, start: performance.now() + (p.delay ?? 0), speed: 1 / (p.kind === 'meter' ? 650 : 560) });
      flash(`src_${p.device}`);
    });
    return off;
  }, [engine]);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let prev = performance.now();
    const draw = (now: number) => {
      const c = canvas.current, w = wrap.current;
      if (!c || !w) { raf = requestAnimationFrame(draw); return; }
      const rect = w.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(rect.width * dpr)) { c.width = Math.round(rect.width * dpr); c.height = Math.round(rect.height * dpr); }
      const ctx = c.getContext('2d')!;
      const k = (rect.width / 1200) * dpr;
      const dt = Math.min(64, now - prev); prev = now;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = reduced ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.globalCompositeOperation = 'lighter';
      const alive: Particle[] = [];
      for (const p of parts.current) {
        if (now < p.start) { alive.push(p); continue; }
        p.t += dt * p.speed;
        while (p.t >= 1 && p.seg < p.edges.length) { flash(p.ends[p.seg]); p.t -= 1; p.seg++; }
        if (p.seg >= p.edges.length) continue;
        const pt = at(p.edges[p.seg], p.t);
        ctx.shadowBlur = 14 * dpr; ctx.shadowColor = p.color; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(pt.x * k, pt.y * k, p.r * dpr * Math.max(0.7, rect.width / 1200), 0, Math.PI * 2); ctx.fill();
        alive.push(p);
      }
      ctx.shadowBlur = 0;
      parts.current = alive;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const q = engine.queues;
  const passRate = engine.totals.packets ? 100 * (1 - engine.totals.flagged / engine.totals.packets) : 100;
  const recent = engine.series.slice(-15);
  const kgToday = engine.kgToday;
  const node = (id: string, title: string, lines: (string | JSX.Element)[], tone: 'src' | 'core' | 'bad' | 'out' | 'off' = 'core') => {
    const b = N[id];
    return (
      <g ref={(el) => (nodes.current[id] = el)} className={`pnode ${tone}`} transform={`translate(${b.x},${b.y})`}>
        <rect width={b.w} height={b.h} rx="12" />
        <text x="14" y="24" className="pt">{title}</text>
        {lines.map((l, i) => <text key={i} x="14" y={45 + i * 18} className="ps">{l}</text>)}
      </g>
    );
  };
  void recent;
  return (
    <div className="pipeline" ref={wrap}>
      <svg viewBox="0 0 1200 500" width="100%" role="img" aria-label="Live data flow from shop floor to OEM">
        {Object.entries(E).map(([k, s]) => {
          const dev = k.startsWith('src_') ? (k.slice(4, k.indexOf('>')) as DeviceId) : null;
          const offline = dev ? !engine.online[dev] : false;
          return <g key={k}><path d={pathD(s)} className="pedge-base" /><path d={pathD(s)} className={`pedge ${offline ? 'off' : ''} ${k.includes('quar') ? 'bad' : ''}`} /></g>;
        })}
        {DEVICES.filter((d) => d.id !== 'grid').map((d) => {
          const off = !engine.online[d.id];
          return node(`src_${d.id}`, `${off ? '◌ ' : '● '}${d.label}`, [off ? `OFFLINE · ${q[d.id].length} saved on device` : d.sub], off ? 'off' : 'src');
        })}
        {node('gw', 'Sync gateway', [`${fmt(engine.today.packets)} packets today`, `${engine.totals.packets ? fmt(engine.totals.packets) : 0} since start`, Object.values(q).some((x) => x.length) ? `${Object.values(q).reduce((a, x) => a + x.length, 0)} waiting offline` : 'idempotent, exactly-once'])}
        {node('val', 'Checks V01–V12', [`${passRate.toFixed(1)}% passed`, `${fmt(engine.totals.flagged)} held since start`, 'stock, size, duplicates'])}
        {node('quar', 'Held for review', [`${engine.quarantine.length} waiting`, engine.quarantine[0] ? `latest: ${engine.quarantine[0].rule}` : 'nothing to review'], engine.quarantine.length ? 'bad' : 'core')}
        {node('ledger', 'Double-entry ledger', [`${fmt(ledgerCount)} posted lines`, 'reversals, never overwrites', `${fmt(engine.today.posted)} posted today`])}
        {node('emis', 'Emissions engine', [`${fmt(kgToday, 0)} kg CO₂e today`, `${engine.today.bodies ? fmt(kgToday / engine.today.bodies, 0) : '—'} kg per body`, 'CEA grid · IPCC fuels'])}
        {node('out_dash', 'Plant dashboard', ['live, every minute'], 'out')}
        {node('out_oem', 'OEM portal', ['nightly, consented'], 'out')}
        {node('out_bank', 'Lender · BRSR', ['M&V, on request'], 'out')}
      </svg>
      <canvas ref={canvas} className="pcanvas" aria-hidden="true" />
      <div className="plegend">
        {[['Meter packet', COLORS.meter], ['Shop-floor entry', COLORS.entry], ['Body finished', COLORS.production], ['Hourly roll-up', COLORS.rollup], ['Held by a check', COLORS.flagged], ['OEM sync', COLORS.export]].map(([l, c]) => <span key={l}><i style={{ background: c, boxShadow: `0 0 8px ${c}` }} />{l}</span>)}
      </div>
    </div>
  );
}
