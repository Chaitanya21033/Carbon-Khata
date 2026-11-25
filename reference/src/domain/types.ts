export type Month = string; // 'YYYY-MM'

export type LineType = 'opening' | 'received' | 'issued' | 'closing' | 'adjustment' | 'reading';

export type Category =
  | 'fuel' | 'gas' | 'material' | 'consumable' | 'chemical' | 'water' | 'scrap' | 'waste'
  | 'production' | 'utility';

export interface Register {
  id: string;
  code: string;            // register type code, e.g. HYD_OIL
  label: string;
  labelHi?: string;
  unit: string;
  category: Category;
  /** full = opening/received/issued/closing kept; issue_only = only issues recorded; reading = single value per month */
  mode: 'full' | 'issue_only' | 'reading';
  required?: boolean;      // needed for month close (production, bill)
  conversion?: { unitLabel: string; factor: number }; // e.g. cylinder → 30 kg
  factorCode?: string;     // emission factor applied to consumption
}

export interface LedgerEntry {
  id: string;
  registerId: string;
  month: Month;
  line: LineType;
  qty: number;
  status: 'posted' | 'reversed';
  reversesId?: string;     // set on a reversal entry
  correctsId?: string;     // set on the replacement entry
  reason?: string;
  docRef?: string;
  by: string;
  at: string;              // ISO time
  source: 'import' | 'app' | 'bill' | 'meter';
  idempotencyKey?: string;
}

export interface EmissionFactor {
  code: string;
  activity: string;
  scope: 1 | 2 | 3;
  unit: string;
  kgco2e_per_unit: number;
  source: string;
  version: number;
  valid_from: string;
  valid_to: string | null;
  status: string;
}

export type Severity = 'block' | 'warn' | 'info';

export interface Issue {
  id: string;              // stable: rule|register|month|line
  rule: string;
  severity: Severity;
  blocksClose: boolean;
  registerId?: string;
  month: Month;
  line?: LineType;
  field: string;
  message: string;
  messageHi: string;
  expected?: number;
  actual?: number;
  series?: { month: Month; value: number }[];
}

export interface IssueState { status: 'open' | 'accepted' | 'dismissed'; note?: string; by?: string; at?: string }

export type CloseStatus = 'open' | 'in_review' | 'closed' | 'reopened';
export interface MonthClose { month: Month; status: CloseStatus; submittedBy?: string; approvedBy?: string; reopenedCount: number; history: { action: string; by: string; at: string; note?: string }[] }

export interface MeasureAssessment {
  code: string;
  name: string;
  nameHi: string;
  kwhPerYr: number;
  extraInrPerYr: number;   // e.g. demand-charge cut
  capexInr: number;
  co2Counted: boolean;     // APFC: cost-only
  status: 'suggested' | 'accepted' | 'in_progress' | 'done' | 'verified' | 'rejected';
  note: string;
}

export interface AuditEvent { id: string; at: string; actor: string; role: string; action: string; entity: string; detail: string }
