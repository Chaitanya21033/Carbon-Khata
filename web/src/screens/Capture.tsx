import { useState } from 'react';
import { CURRENT_MONTH, REGISTERS, useStore } from '../state/store';
import { api } from '../api/client';
import { PhotoCapture, PhotosCard } from '../ui/Shopfloor';
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

interface MeterLatest { meter: string; value: number | null; unit: string; source: string; confidence: number; meterType: string; lastInterval?: { ts: string; kwh: number } | null }
interface BillFields { period: string; kwh?: number | null; kvah?: number | null; pf?: number | null; mdKva?: number | null; amountInr?: number | null; note?: string }

function Capture() {
  const { s, actions, notify } = useStore();
  // ---- smart meter ----
  const [mBusy, setMBusy] = useState(false);
  const [mRead, setMRead] = useState<MeterLatest | null>(null);
  const [mVal, setMVal] = useState('');
  const last = s.meterReadings.filter((m) => m.meter === 'Main incomer (HT)').slice(-1)[0];
  const pullMeter = async () => {
    setMBusy(true); setMRead(null);
    try { const r = await api<MeterLatest>('/meters/incomer/latest'); setMRead(r); setMVal(r.value != null ? String(Math.round(r.value)) : ''); }
    catch (e) { notify((e as Error).message); }
    setMBusy(false);
  };
  const v = Number(mVal);
  const backwards = !!last && v > 0 && v < last.value;
  const confirmMeter = () => {
    if (!(v > 0)) return notify('Enter the reading.');
    actions.addMeterReading({ meter: 'Main incomer (HT)', value: v, confidence: mRead?.confidence ?? 1, source: mRead && v === Math.round(mRead.value ?? -1) ? 'smart_meter_api' : 'manual' });
    if (backwards) notify('V11: lower than the last reading. Saved and flagged for review.');
    setMRead(null); setMVal('');
  };

  // ---- bill ----
  const [bBusy, setBBusy] = useState(false);
  const [bill, setBill] = useState<BillFields | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const onBill = async (f?: File) => {
    if (!f) return;
    setBBusy(true); setBill(null);
    try {
      const fd = new FormData(); fd.append('kind', 'bill'); fd.append('file', f);
      const doc = await api<{ id: string }>('/documents', { body: fd });
      setDocId(doc.id);
      setBill(await api<BillFields>(`/documents/${doc.id}/read`, { method: 'POST' }));
    } catch (e) { notify((e as Error).message); }
    setBBusy(false);
  };
  const postBill = () => {
    if (!bill) return;
    api('/bills', { body: { month: bill.period, kwh: bill.kwh, kvah: bill.kvah, pf: bill.pf, mdKva: bill.mdKva, amountInr: bill.amountInr, documentId: docId, source: 'bill+smart_meter' } })
      .then(() => { notify(`Bill for ${monthLabel(bill.period, 'en', false)} posted. Checks run on it now.`); actions.refresh(); setBill(null); setDocId(null); })
      .catch((e: Error) => notify(e.message));
  };
  const setB = (k: keyof BillFields, val: string) => setBill((b) => (b ? { ...b, [k]: k === 'period' ? val : val === '' ? null : Number(val) } : b));

  // ---- quick entry ----
  const regs = REGISTERS.filter((r) => ['DIESEL', 'LPG', 'CO2_GAS', 'HR_SHEET', 'PAINT', 'HYD_OIL', 'SCRAP_HR', 'SLUDGE'].includes(r.id));
  const [reg, setReg] = useState('DIESEL');
  const [qty, setQty] = useState('');
  const [doc, setDoc] = useState('');
  const saveEntry = () => {
    const r = actions.addEntry({ registerId: reg, month: CURRENT_MONTH, line: 'issued', qty: Number(qty), docRef: doc.trim() || undefined });
    if (!r.ok) return notify(r.msg);
    if (r.msg) notify(r.msg);
    setQty(''); setDoc('');
  };

  return (
    <div className="stack">
      <PageHead title="Capture" sub="Meter readings come from the plant's smart meters. Bills are uploaded and pre-filled from the meter feed, then confirmed by a person. Every entry passes the same checks as the live feed." />
      {s.offline && <div className="banner warn"><Icon name="alert" />Offline: entries are saved on this phone ({s.queue.length} waiting) and post once when you are back online.</div>}
      <div className="grid g3">
        <div className="card stack-sm">
          <div className="row-between"><h3>Smart meter</h3>{mRead && <Chip tone={mRead.source === 'smart_meter_api' ? 'ok' : 'info'}>{mRead.source === 'smart_meter_api' ? 'Head-end API' : 'Live meter feed'}</Chip>}</div>
          <p className="small muted">Main incomer (HT), DLMS smart meter. Pull the current cumulative register to record the daily reading.</p>
          <button className="btn" onClick={pullMeter} disabled={mBusy}><Icon name="refresh" size={16} />{mBusy ? 'Reading the meter…' : 'Pull reading from the meter'}</button>
          {mRead && (
            <>
              <div className="row-between small"><span>{mRead.meterType}</span><Chip tone="ok">confidence {Math.round(mRead.confidence * 100)}%</Chip></div>
              <input className="input num" style={{ fontSize: 24, fontWeight: 700 }} inputMode="numeric" value={mVal} onChange={(e) => setMVal(e.target.value.replace(/\D/g, ''))} aria-label="Reading" placeholder="Type the register" />
              {mRead.lastInterval && <p className="xs muted">Last 15-min interval: {fmt(mRead.lastInterval.kwh, 1)} kWh</p>}
              {backwards && <p className="xs" style={{ color: 'var(--danger)' }}>Lower than the last reading ({fmt(last!.value)}): it will be flagged V11.</p>}
              <button className="btn primary" onClick={confirmMeter}>Confirm reading</button>
            </>
          )}
          <p className="xs muted">Last recorded: {last ? `${fmt(last.value)} kWh` : '—'}</p>
        </div>

        <div className="card stack-sm">
          <h3>Photo evidence</h3>
          <p className="small muted">Meter display, slip, delivery or anything on the shop floor. Saved on the plant server and shown on the dashboard straight away.</p>
          <PhotoCapture />
        </div>

        <div className="card stack-sm">
          <div className="row-between"><h3>Electricity bill</h3>{bill && <Chip tone="info">Pre-filled from meter feed</Chip>}</div>
          <label className="camera" style={{ cursor: 'pointer', aspectRatio: '4 / 3' }}>
            <span className="stack-sm" style={{ alignItems: 'center' }}><Icon name="file" size={36} /><span className="small">{docId ? 'Bill uploaded' : 'Upload the bill (PDF or photo)'}</span></span>
            <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={(e) => onBill(e.target.files?.[0])} />
          </label>
          {bBusy && <div className="banner info"><Icon name="refresh" />Uploading and matching to the meter feed…</div>}
          {bill && (
            <>
              <div className="stack-sm" style={{ gap: 6 }}>
                {([['period', 'Billing month (YYYY-MM)'], ['kwh', 'Energy, kWh'], ['kvah', 'Apparent energy, kVAh'], ['pf', 'Power factor'], ['mdKva', 'Max demand, kVA'], ['amountInr', 'Amount, ₹ (type from the bill)']] as [keyof BillFields, string][]).map(([k, l]) => (
                  <label key={k} className="row-between small" style={{ flexWrap: 'nowrap', gap: 8 }}><span className="muted">{l}</span>
                    <input className="input num" style={{ width: 150, minHeight: 32 }} value={bill[k] == null ? '' : String(bill[k])} onChange={(e) => setB(k, e.target.value)} /></label>
                ))}
              </div>
              {bill.kwh && bill.kvah && bill.pf ? <p className="xs muted">kWh ÷ kVAh = {(bill.kwh / bill.kvah).toFixed(3)} vs printed PF {bill.pf} {Math.abs(bill.kwh / bill.kvah - bill.pf) > 0.03 ? '· V08 mismatch' : '· consistent'}</p> : null}
              {bill.note && <p className="xs muted">{bill.note}</p>}
              <button className="btn primary" disabled={!bill.kwh || !bill.amountInr} onClick={postBill}>Confirm and post</button>
            </>
          )}
        </div>

        <div className="card stack-sm">
          <h3>Register entry</h3>
          <div className="field"><label htmlFor="reg">Register</label><select id="reg" className="input" value={reg} onChange={(e) => setReg(e.target.value)}>{regs.map((r) => <option key={r.id} value={r.id}>{r.label} ({r.unit})</option>)}</select></div>
          <div className="field"><label htmlFor="q">Quantity issued</label><input id="q" className="input num" inputMode="decimal" style={{ fontSize: 20 }} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
          <div className="field"><label htmlFor="doc">Slip / challan no.</label><input id="doc" className="input" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="e.g. CH-2291" /></div>
          <PhotoCapture compact docRef={doc.trim() || undefined} />
          <button className="btn primary" disabled={!Number(qty)} onClick={saveEntry}>Post entry</button>
          <label className="row small"><input type="checkbox" checked={s.offline} onChange={(e) => actions.setOffline(e.target.checked)} />Work offline (queue on this phone)</label>
          <p className="xs muted">Try an extra zero (e.g. 32000 kg of steel) or reuse a slip number: the server holds both for review.</p>
        </div>
      </div>
      <PhotosCard limit={4} />
    </div>
  );
}
