import { useState } from 'react';
import { CURRENT_MONTH, REGISTERS, useStore } from '../state/store';
import { readBillPhoto, readMeterPhoto, type BillRead, type MeterRead } from '../api/sources';
import { fmt, monthLabel } from '../domain/util';
import { Icon } from '../ui/Icon';
import { Chip, PageHead, Seg } from '../ui/kit';
import DataQuality from './DataQuality';
import Registers from './Registers';

type Tab = 'capture' | 'checks' | 'registers';

export default function CaptureChecks() {
  const [tab, setTab] = useState<Tab>('capture');
  const { d } = useStore();
  const blocks = d.openIssues.filter((i) => i.severity === 'block').length;
  return (
    <div className="stack">
      <Seg label="Section" value={tab} onChange={setTab} options={[{ v: 'capture', l: 'Capture' }, { v: 'checks', l: `Data checks${blocks ? ` (${blocks})` : ''}` }, { v: 'registers', l: 'Registers' }]} />
      {tab === 'capture' ? <Capture /> : tab === 'checks' ? <DataQuality /> : <Registers />}
    </div>
  );
}

function SourceChip({ src }: { src: 'claude' | 'simulated' }) {
  return src === 'claude' ? <Chip tone="ok">Read by Claude vision</Chip> : <Chip tone="warn">Simulated read</Chip>;
}

function Capture() {
  const { s, actions, notify } = useStore();
  // ---- meter ----
  const [mImg, setMImg] = useState<string | null>(null);
  const [mBusy, setMBusy] = useState(false);
  const [mRead, setMRead] = useState<MeterRead | null>(null);
  const [mVal, setMVal] = useState('');
  const last = s.meterReadings.filter((m) => m.meter === 'Main incomer (HT)').slice(-1)[0];
  const onMeter = async (f?: File) => {
    if (!f) return;
    setMImg(URL.createObjectURL(f)); setMRead(null); setMBusy(true);
    const r = await readMeterPhoto(f, (last?.value ?? 4_812_000) + 5200 + Math.round(Math.random() * 900));
    setMRead(r); setMVal(String(Math.round(r.value))); setMBusy(false);
  };
  const v = Number(mVal);
  const backwards = !!last && v > 0 && v < last.value;
  const confirmMeter = () => {
    if (!mRead) return;
    if (!(v > 0)) return notify('Enter the reading.');
    if (backwards) return notify('V11: lower than the last reading. Retake the photo or check the meter.');
    actions.addMeterReading({ meter: 'Main incomer (HT)', value: v, confidence: mRead.confidence, source: v === Math.round(mRead.value) ? 'photo_ai' : 'manual' });
    notify(`Meter reading saved: ${fmt(v)} kWh`);
    setMImg(null); setMRead(null); setMVal('');
  };

  // ---- bill ----
  const [bImg, setBImg] = useState<string | null>(null);
  const [bBusy, setBBusy] = useState(false);
  const [bill, setBill] = useState<BillRead | null>(null);
  const onBill = async (f?: File) => {
    if (!f) return;
    setBImg(f.type.startsWith('image/') ? URL.createObjectURL(f) : null); setBill(null); setBBusy(true);
    setBill(await readBillPhoto(f)); setBBusy(false);
  };
  const postBill = () => {
    if (!bill) return;
    const doc = `BILL-${bill.period ?? CURRENT_MONTH}-${bill.kwh ?? 0}`;
    const rows: [string, number | undefined][] = [['GRID_KVAH', bill.kvah], ['PF', bill.pf], ['MD_KVA', bill.mdKva], ['BILL_INR', bill.amountInr]];
    let ok = 0;
    const r = actions.addEntry({ registerId: 'GRID_KWH', month: CURRENT_MONTH, line: 'reading', qty: bill.kwh ?? 0, docRef: doc, source: 'bill' });
    if (!r.ok) return notify(r.msg);
    ok++;
    for (const [reg, q] of rows) if (q && q > 0) { const x = actions.addEntry({ registerId: reg, month: CURRENT_MONTH, line: 'reading', qty: q, docRef: `${doc}-${reg}`, source: 'bill' }); if (x.ok) ok++; }
    notify(`${ok} bill figures posted to ${monthLabel(CURRENT_MONTH, 'en', false)}. Checks run on them now.`);
    setBill(null); setBImg(null);
  };

  // ---- quick entry ----
  const regs = REGISTERS.filter((r) => ['DIESEL', 'LPG', 'CO2_GAS', 'HR_SHEET', 'PAINT', 'HYD_OIL', 'SCRAP_HR', 'SLUDGE'].includes(r.id));
  const [reg, setReg] = useState('DIESEL');
  const [qty, setQty] = useState('');
  const [doc, setDoc] = useState('');
  const [held, setHeld] = useState<{ qty: number; typ: number } | null>(null);
  const TYPICAL: Record<string, number> = { HR_SHEET: 3200, DIESEL: 40, LPG: 19, CO2_GAS: 30, PAINT: 22, HYD_OIL: 30, SCRAP_HR: 1600, SLUDGE: 7 };
  const saveEntry = (force?: number) => {
    const q = force ?? Number(qty);
    const typ = TYPICAL[reg];
    if (force === undefined && typ && q > 5 * typ) { setHeld({ qty: q, typ }); return; }
    setHeld(null);
    const r = actions.addEntry({ registerId: reg, month: CURRENT_MONTH, line: 'issued', qty: q, docRef: doc.trim() || undefined, reason: force !== undefined && force !== Number(qty) ? `Corrected from ${qty} (V01)` : undefined });
    notify(r.ok ? `Posted ${fmt(q)} ${REGISTERS.find((x) => x.id === reg)?.unit} · watch it travel on the Live plant diagram` : r.msg);
    if (r.ok) { setQty(''); setDoc(''); }
  };

  return (
    <div className="stack">
      <PageHead title="Capture" sub="Photos of meters and bills are read by Claude vision and confirmed by a person before anything is posted. Every entry then passes the same checks as the live feed." />
      <div className="grid g3">
        <div className="card stack-sm">
          <div className="row-between"><h3>Meter photo</h3>{mRead && <SourceChip src={mRead.source} />}</div>
          <label className="camera" style={{ cursor: 'pointer' }}>
            {mImg ? <img src={mImg} alt="Meter" /> : <span className="stack-sm" style={{ alignItems: 'center' }}><Icon name="camera" size={36} /><span className="small">Take or choose a meter photo</span></span>}
            <span className="frame" />
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => onMeter(e.target.files?.[0])} />
          </label>
          {mBusy && <div className="banner info"><Icon name="refresh" />Reading the display…</div>}
          {mRead && (
            <>
              <div className="row-between small"><span>{mRead.meterType} · {mRead.unit}</span><Chip tone={mRead.confidence >= 0.85 ? 'ok' : 'warn'}>confidence {Math.round(mRead.confidence * 100)}%</Chip></div>
              <input className="input num" style={{ fontSize: 24, fontWeight: 700 }} inputMode="numeric" value={mVal} onChange={(e) => setMVal(e.target.value.replace(/\D/g, ''))} aria-label="Reading" />
              {mRead.note && <p className="xs muted">{mRead.note}</p>}
              {backwards && <p className="xs" style={{ color: 'var(--danger)' }}>Lower than the last reading ({fmt(last!.value)}).</p>}
              <button className="btn primary" onClick={confirmMeter}>Confirm reading</button>
            </>
          )}
          <p className="xs muted">Last: {last ? `${fmt(last.value)} kWh` : '—'}</p>
        </div>

        <div className="card stack-sm">
          <div className="row-between"><h3>Electricity bill</h3>{bill && <SourceChip src={bill.source} />}</div>
          <label className="camera" style={{ cursor: 'pointer', aspectRatio: '4 / 3' }}>
            {bImg ? <img src={bImg} alt="Bill" /> : <span className="stack-sm" style={{ alignItems: 'center' }}><Icon name="file" size={36} /><span className="small">Photo of a bill</span></span>}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onBill(e.target.files?.[0])} />
          </label>
          {bBusy && <div className="banner info"><Icon name="refresh" />Extracting kWh, kVAh, PF, demand and amount…</div>}
          {bill && (
            <>
              <div className="stack-sm" style={{ gap: 4 }}>
                {([['Energy', bill.kwh, 'kWh'], ['Apparent energy', bill.kvah, 'kVAh'], ['Power factor', bill.pf, ''], ['Max demand', bill.mdKva, 'kVA'], ['Amount', bill.amountInr, '₹'], ['Period', bill.period, ''], ['Utility', bill.utility, '']] as [string, number | string | undefined, string][]).map(([k, val, u]) => (
                  <div key={k} className="row-between small" style={{ borderBottom: '1px solid var(--border)', padding: '4px 0', flexWrap: 'nowrap' }}><span className="muted">{k}</span><strong className="num" style={{ textAlign: 'right' }}>{val === undefined ? '—' : typeof val === 'number' ? fmt(val, k === 'Power factor' ? 3 : 0) : val} {u}</strong></div>
                ))}
              </div>
              {bill.kwh && bill.kvah && bill.pf ? <p className="xs muted">kWh ÷ kVAh = {(bill.kwh / bill.kvah).toFixed(3)} vs printed PF {bill.pf} {Math.abs(bill.kwh / bill.kvah - bill.pf) > 0.03 ? '· V08 mismatch' : '· consistent'}</p> : null}
              {bill.note && <p className="xs muted">{bill.note}</p>}
              <button className="btn primary" disabled={!bill.kwh} onClick={postBill}>Post to {monthLabel(CURRENT_MONTH, 'en', false)} ledger</button>
            </>
          )}
        </div>

        <div className="card stack-sm">
          <h3>Register entry</h3>
          <div className="field"><label htmlFor="reg">Register</label><select id="reg" className="input" value={reg} onChange={(e) => setReg(e.target.value)}>{regs.map((r) => <option key={r.id} value={r.id}>{r.label} ({r.unit})</option>)}</select></div>
          <div className="field"><label htmlFor="q">Quantity issued</label><input id="q" className="input num" inputMode="decimal" style={{ fontSize: 20 }} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
          <div className="field"><label htmlFor="doc">Slip / challan no.</label><input id="doc" className="input" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="e.g. CH-2291" /></div>
          {held ? (
            <div className="banner block" style={{ alignItems: 'flex-start' }}>
              <Icon name="alert" />
              <div className="stack-sm">
                <span>V01 held: {fmt(held.qty)} is {(held.qty / held.typ).toFixed(0)}× a normal entry ({fmt(held.typ)}). Extra zero?</span>
                <div className="row"><button className="btn sm primary" onClick={() => saveEntry(Math.round(held.qty / 10))}>Post {fmt(Math.round(held.qty / 10))}</button><button className="btn sm" onClick={() => saveEntry(held.qty)}>It is correct</button><button className="btn sm ghost" onClick={() => setHeld(null)}>Cancel</button></div>
              </div>
            </div>
          ) : <button className="btn primary" disabled={!Number(qty)} onClick={() => saveEntry()}>Post entry</button>}
          <p className="xs muted">Try an extra zero (e.g. 32000 kg of steel) or reuse a slip number: the checks catch both.</p>
        </div>
      </div>
    </div>
  );
}
