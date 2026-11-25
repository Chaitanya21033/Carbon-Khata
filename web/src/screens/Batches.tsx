import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { BRANDS, CO_PACKER, DISTRIBUTORS, MATERIALS, batchRecord, lotIndex, type Batch, type BatchStatus, type BrandId } from '../domain/fmcg';
import { fmt, sha256 } from '../domain/util';
import { Icon } from '../ui/Icon';
import { Chip, Drawer, Kpi, PageHead, Seg } from '../ui/kit';
import { Qr, packLink } from '../ui/Qr';

const STATUS: Record<BatchStatus, { tone: 'ok' | 'warn' | 'block' | 'info' | 'neutral'; label: string }> = {
  in_production: { tone: 'info', label: 'in production' }, qc_pending: { tone: 'warn', label: 'QC pending' },
  released: { tone: 'ok', label: 'released' }, held: { tone: 'block', label: 'held' }, recalled: { tone: 'block', label: 'RECALLED' },
};
const time = (t: number) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** Batches from the API (line MES + QC lab results, release gate and recall evaluated server-side). */
export function useBatches() {
  const q = useQuery({ queryKey: ['fmcg', 'batches'], queryFn: () => api<{ batches: Batch[] }>('/fmcg/batches?limit=48'), staleTime: 5_000, refetchInterval: 30_000 });
  return { batches: q.data?.batches ?? [], loading: q.isLoading, error: (q.error as Error | null)?.message ?? null };
}

function BatchDrawer({ b, onClose }: { b: Batch; onClose: () => void }) {
  const { actions } = useStore();
  const [fp, setFp] = useState('');
  useEffect(() => { sha256(batchRecord(b)).then((h) => setFp(h.slice(0, 16))); }, [b]);
  const link = packLink(`b-${b.publicCode ?? b.id}`);
  const inBal = b.lots.filter((l) => l.material !== 'film').reduce((s, l) => s + l.kg, 0);
  return (
    <Drawer title={`Batch ${b.id}`} onClose={onClose}>
      <div className="stack">
        <div className="row"><Chip tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Chip><span className="small">{b.product.name} · {BRANDS[b.product.brand].name} · line {b.line}</span></div>
        {b.holdReason && <div className="banner block"><Icon name="alert" />{b.holdReason}{b.status === 'held' ? '. Dispatch is blocked until it is resolved.' : '.'}</div>}
        <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <Qr text={link} size={132} />
          <div className="stack-sm small">
            <span>MFG {b.mfg} · EXP {b.exp}</span>
            <span>{fmt(b.product.packs)} packs · {fmt(b.outputKg)} kg</span>
            <span>Seal <span className="mono">{fp}…</span></span>
            <a className="btn sm" href={`#b-${b.id}`}>Open consumer page</a>
          </div>
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Tests</h3>
          {b.tests.map((t) => (
            <div key={t.name} className="row-between small" style={{ borderBottom: '1px solid var(--border)', padding: '5px 0', flexWrap: 'nowrap', gap: 8 }}>
              <span style={{ flex: 1 }}>{t.name}<br /><span className="xs muted">{t.stage} · spec {t.spec} · {t.by}</span></span>
              <span className="num" style={{ whiteSpace: 'nowrap' }}>{t.value}</span>
              <Chip tone={t.status === 'pass' ? 'ok' : t.status === 'fail' ? 'block' : 'warn'}>{t.status}</Chip>
              {t.status === 'pending' && <button className="btn sm" onClick={() => actions.setTestResult(`${b.id}|${t.name}`, 'pass')}>Record pass</button>}
            </div>
          ))}
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Ingredient lots (traceable to supplier)</h3>
          {b.lots.map((l) => <div key={l.lot} className="row-between small" style={{ padding: '3px 0', flexWrap: 'nowrap' }}><span><span className="mono">{l.lot}</span> · {MATERIALS[l.material].name}<br /><span className="xs muted">{MATERIALS[l.material].supplier} · CoA: {MATERIALS[l.material].coa}</span></span><strong className="num">{fmt(l.kg, 1)} kg</strong></div>)}
          <p className="xs muted" style={{ marginTop: 6 }}>Mass balance: {fmt(inBal, 1)} kg in → {fmt(b.outputKg, 1)} kg out, yield {b.yieldPct.toFixed(1)}%. Output above inputs is flagged automatically.</p>
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Carbon per pack: {fmt(b.carbon.perPackG, 0)} g CO₂e</h3>
          <p className="small muted">Ingredients {fmt(b.carbon.ingredients, 0)} kg · packaging {fmt(b.carbon.packaging, 0)} kg · plant energy {fmt(b.carbon.energy, 0)} kg ({fmt(b.kwh, 0)} kWh, {Math.round(b.renewableShare * 100)}% renewable) for the batch.</p>
        </div>
        {b.dispatch.length > 0 && <div><h3 style={{ marginBottom: 6 }}>Shipped to</h3>{b.dispatch.map((d) => <div key={d.to} className="row-between small"><span>{d.to}</span><strong>{fmt(d.packs)} packs</strong></div>)}</div>}
      </div>
    </Drawer>
  );
}

export default function Batches() {
  const { batches, loading, error } = useBatches();
  const { s, actions, notify } = useStore();
  const [brand, setBrand] = useState<'all' | BrandId>('all');
  const [sel, setSel] = useState<Batch | null>(null);
  const [tab, setTab] = useState<'batches' | 'lots'>('batches');
  const list = batches.filter((b) => brand === 'all' || b.product.brand === brand);
  const lots = useMemo(() => lotIndex(batches), [batches]);
  const recalled = s.fmcg.recalledLots;
  const today = list.filter((b) => b.mfg === batches[0]?.mfg);
  const count = (st: BatchStatus) => list.filter((b) => b.status === st).length;
  const recallBatches = list.filter((b) => b.status === 'recalled');
  const recallPacks = recallBatches.reduce((a, b) => a + b.product.packs, 0);
  const byDist = DISTRIBUTORS.map((d) => ({ d, packs: recallBatches.reduce((a, b) => a + (b.dispatch.find((x) => x.to === d)?.packs ?? 0), 0) })).filter((x) => x.packs > 0);
  const avgCarbon = list.filter((b) => b.status !== 'in_production').reduce((a, b, _, arr) => a + b.carbon.perPackG / b.product.packG / arr.length, 0);
  const current = sel ? batches.find((b) => b.id === sel.id) ?? sel : null;
  if (error) return <div className="banner block"><Icon name="alert" />Could not load batches: {error}</div>;
  if (loading) return <div className="card"><p className="muted">Loading batches from the line…</p></div>;
  if (!batches.length) return <div className="card"><h3>No batches yet</h3><p className="small muted">Batches appear as the line MES reports them.</p></div>;

  return (
    <div className="stack">
      <PageHead title="Batch tracing" sub={`${CO_PACKER.name} makes biscuits and snacks for two brands. Every pack carries a QR that opens its batch: tests, ingredient lots, carbon and recall status.`}
        actions={<Seg label="Brand" value={brand} onChange={setBrand} options={[{ v: 'all', l: 'All brands' }, { v: 'A', l: BRANDS.A.name }, { v: 'B', l: BRANDS.B.name }]} />} />
      <div className="banner info"><Icon name="info" />Same ledger as the auto plant: lots are issued to batches like steel to bodies, so a recall is a lookup, not a paper hunt. Brand owners see only their own batches.</div>
      {recallBatches.length > 0 && (
        <div className="card stack-sm" style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
          <div className="row-between"><h3 style={{ color: 'var(--danger)' }}><Icon name="alert" /> Recall active: lot {recalled.join(', ')}</h3><span className="small">{recallBatches.length} batches · {fmt(recallPacks)} packs</span></div>
          <div className="row">{byDist.map((x) => <Chip key={x.d} tone="block">{x.d}: {fmt(x.packs)}</Chip>)}</div>
          <div className="row">
            {recalled.map((lot) => s.fmcg.notified.includes(lot)
              ? <Chip key={lot} tone="ok">Distributors notified for {lot}</Chip>
              : <button key={lot} className="btn sm primary" onClick={() => { actions.notifyRecall(lot, byDist.map((x) => x.d)); notify(`Recall notice sent to ${byDist.length} distributors (demo)`); }}>Notify distributors & brand</button>)}
            {recalled.map((lot) => <button key={`c${lot}`} className="btn sm ghost" onClick={() => actions.clearLot(lot)}>Close recall {lot}</button>)}
          </div>
          <span className="xs muted">Consumers scanning an affected pack now see a "Do not consume" warning.</span>
        </div>
      )}
      <div className="grid g6">
        <Kpi label="Batches today" value={today.length} sub={`${list.length} in view`} />
        <Kpi label="Released" value={count('released')} tone="ok" />
        <Kpi label="QC pending" value={count('qc_pending') + count('in_production')} sub="incl. in production" />
        <Kpi label="Held at release gate" value={count('held')} tone={count('held') ? 'block' : undefined} sub="failed a test" />
        <Kpi label="Recalled packs" value={fmt(recallPacks)} tone={recallPacks ? 'block' : undefined} />
        <Kpi label="Carbon" value={fmt(avgCarbon, 2)} unit="kg CO₂e/kg" sub="product, cradle to gate" />
      </div>
      <Seg label="View" value={tab} onChange={setTab} options={[{ v: 'batches', l: 'Batches' }, { v: 'lots', l: 'Ingredient lots' }]} />
      {tab === 'batches' ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap" style={{ border: 0, maxHeight: 560 }}><table className="t">
            <thead><tr><th>Batch</th><th>Product</th><th>Started</th><th>Status</th><th className="r">Tests</th><th className="r">Packs</th><th className="r">g CO₂e / pack</th><th /></tr></thead>
            <tbody>{list.map((b) => {
              const passed = b.tests.filter((t) => t.status === 'pass').length;
              return (
                <tr key={b.id} className="clickable" onClick={() => setSel(b)}>
                  <td className="mono">{b.id}</td>
                  <td><span className="dot" style={{ background: BRANDS[b.product.brand].color }} />{b.product.name}</td>
                  <td className="small">{time(b.start)}</td>
                  <td><Chip tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Chip></td>
                  <td className="r">{passed}/{b.tests.length}</td>
                  <td className="r">{fmt(b.product.packs)}</td>
                  <td className="r">{b.status === 'in_production' ? '—' : fmt(b.carbon.perPackG, 0)}</td>
                  <td><Icon name="qr" size={18} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap" style={{ border: 0, maxHeight: 560 }}><table className="t">
            <thead><tr><th>Lot</th><th>Material</th><th>Supplier</th><th className="r">Used (kg)</th><th className="r">Batches</th><th /></tr></thead>
            <tbody>{lots.map((l) => {
              const on = recalled.includes(l.lot);
              return (
                <tr key={l.lot}>
                  <td className="mono">{l.lot}</td><td>{MATERIALS[l.material].name}</td><td className="small">{MATERIALS[l.material].supplier}</td>
                  <td className="r">{fmt(l.kg, 0)}</td><td className="r">{l.batches.length}</td>
                  <td>{on ? <Chip tone="block">recalled</Chip> : <button className="btn sm danger" onClick={() => { actions.flagLot(l.lot, 'Flagged from lot list'); notify(`Lot ${l.lot}: ${l.batches.length} batches traced`); }}>Flag lot</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      )}
      {current && <BatchDrawer b={current} onClose={() => setSel(null)} />}
    </div>
  );
}

// ---------------- Public pages a QR opens ----------------
interface PublicBatch { batch: string; product: string; brand: string; maker: string; fssai: string; mfg: string; exp: string; mrp: number; status: string; recalled: boolean; tests: { name: string; result: string }[]; carbon_g_per_pack: number; note: string }
export function BatchPublic({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['public', 'b', id], queryFn: () => api<PublicBatch>(`/public/batch/${encodeURIComponent(id)}`, { noAuth: true }), retry: false });
  const b = q.data;
  if (q.isLoading) return <div className="pub"><div className="card">Checking this pack…</div></div>;
  if (!b) return <div className="pub"><div className="card"><h2>Batch {id} not found</h2><p className="small muted" style={{ marginTop: 6 }}>This code is not in the record. If the pack looks genuine, report it to the brand.</p></div></div>;
  const color = b.brand.startsWith('Brand A') ? BRANDS.A.color : BRANDS.B.color;
  return (
    <div className="pub">
      <div className="pub-head" style={{ background: color }}>
        <span className="xs" style={{ opacity: 0.85 }}>{b.brand}</span>
        <h1 style={{ color: '#fff' }}>{b.product}</h1>
        <span className="small" style={{ opacity: 0.9 }}>Batch {b.batch} · MFG {b.mfg} · EXP {b.exp} · MRP ₹{b.mrp}</span>
      </div>
      {b.recalled ? <div className="banner block" style={{ fontSize: 16 }}><Icon name="alert" /><div><strong>Do not consume.</strong> {b.status}</div></div>
        : b.status.startsWith('Released') ? <div className="banner ok"><Icon name="check" />Genuine pack · {b.status}</div>
        : <div className="banner warn"><Icon name="info" />{b.status}</div>}
      <div className="card stack-sm">
        <h3>Quality tests</h3>
        {b.tests.map((t) => <div key={t.name} className="row-between small"><span>{t.name}</span><Chip tone={t.result === 'pass' ? 'ok' : t.result === 'fail' ? 'block' : 'warn'}>{t.result}</Chip></div>)}
      </div>
      <div className="card stack-sm">
        <h3>Footprint</h3>
        <div className="row" style={{ alignItems: 'baseline' }}><span style={{ fontFamily: 'var(--font-head)', fontSize: 32, fontWeight: 700 }}>{fmt(b.carbon_g_per_pack, 0)} g</span><span className="small muted">CO₂e per pack, cradle to factory gate</span></div>
      </div>
      <p className="xs muted" style={{ textAlign: 'center' }}>Made by {b.maker} · {b.fssai}<br />{b.note}</p>
    </div>
  );
}
