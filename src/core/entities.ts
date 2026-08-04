/**
 * Entity types — field-for-field mirrors of migration
 * `src-tauri/migrations/0001_schema_v1.sql`.
 *
 * Conventions:
 * - Money is ALWAYS integer cents (`*_cents: number`) — never floats.
 * - Dates/timestamps are ISO-8601 TEXT as stored (`YYYY-MM-DD`, `datetime('now')`).
 * - SQLite 0/1 flag columns (`archived`, `active`) surface as `boolean`;
 *   repositories convert at the row boundary.
 * - Nullable columns are `| null`. `New*` input types omit `id` and
 *   DB-defaulted columns; optional fields default to NULL.
 */

export type AccountKind = "checking" | "credit" | "cash";
export type PaymentSource = "manual" | "xlsx" | "gnucash";
export type BillFrequency = "monthly" | "quarterly" | "annual";

export interface Account {
  id: number;
  name: string;
  kind: AccountKind;
  last4: string | null;
  gnucash_guid: string | null;
  archived: boolean;
}

export interface NewAccount {
  name: string;
  kind: AccountKind;
  last4?: string | null;
  gnucash_guid?: string | null;
}

export type AccountPatch = Partial<NewAccount>;

export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  gnucash_guid: string | null;
  archived: boolean;
}

export interface NewCategory {
  name: string;
  parent_id?: number | null;
  gnucash_guid?: string | null;
}

export type CategoryPatch = Partial<NewCategory>;

export interface Payee {
  id: number;
  name: string;
  default_category_id: number | null;
  default_account_id: number | null;
  notes: string | null;
  archived: boolean;
}

export interface NewPayee {
  name: string;
  default_category_id?: number | null;
  default_account_id?: number | null;
  notes?: string | null;
}

export type PayeePatch = Partial<NewPayee>;

export interface Payment {
  id: number;
  payee_id: number;
  account_id: number;
  category_id: number | null;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Integer cents — never a float. */
  amount_cents: number;
  memo: string | null;
  source: PaymentSource;
  external_ref: string | null;
  source_sheet: string | null;
  source_row: number | null;
  source_col: number | null;
  occurrence_index: number | null;
  /** Set by the DB default `datetime('now')`. */
  created_at: string;
}

interface NewPaymentBase {
  payee_id: number;
  account_id: number;
  category_id?: number | null;
  date: string;
  amount_cents: number;
  memo?: string | null;
  external_ref?: string | null;
}

export interface NewXlsxPayment extends NewPaymentBase {
  source: "xlsx";
  source_sheet: string;
  source_row: number;
  source_col: number;
  occurrence_index: number;
}

export interface NewNonXlsxPayment extends NewPaymentBase {
  source: Exclude<PaymentSource, "xlsx">;
  source_sheet?: null;
  source_row?: null;
  source_col?: null;
  occurrence_index?: null;
}

export type NewPayment = NewXlsxPayment | NewNonXlsxPayment;

export type PaymentPatch = Partial<NewPayment>;

export interface RecurringBill {
  id: number;
  payee_id: number;
  frequency: BillFrequency;
  /** Integer cents, or null when the amount varies. */
  expected_amount_cents: number | null;
  /** Day of month, 1–31 (CHECK-enforced). */
  due_day: number;
  /** Month anchor, 1–12 (annual schedule month and quarterly month-family source). */
  anchor_month: number;
  /** Quarterly anchor phase, 1–3 where 1=Jan/Apr/Jul/Oct, 2=Feb/May/Aug/Nov, 3=Mar/Jun/Sep/Dec. */
  anchor_phase: number;
  active: boolean;
}

export interface NewRecurringBill {
  payee_id: number;
  frequency: BillFrequency;
  expected_amount_cents?: number | null;
  due_day: number;
  anchor_month?: number;
  anchor_phase?: number;
}

export type RecurringBillPatch = Partial<NewRecurringBill> & { active?: boolean };

export interface ImportLogEntry {
  id: number;
  source_file: string;
  content_hash: string;
  /** Set by the DB default `datetime('now')`. */
  imported_at: string;
  row_count: number;
}

export interface NewImportLogEntry {
  source_file: string;
  content_hash: string;
  row_count: number;
}

/**
 * Business-key tuple for xlsx import dedup: two xlsx payments with the same
 * tuple are duplicates of some kind (exact when source coordinates also
 * match, potential otherwise).
 */
export interface XlsxBusinessKey {
  payee_id: number;
  account_id: number;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Integer cents — never a float. */
  amount_cents: number;
}
