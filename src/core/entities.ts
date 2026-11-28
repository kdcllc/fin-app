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

export type AccountKind = "checking" | "credit" | "cash" | "savings" | "loan";
/** Where a transaction (or legacy payment) came from. */
export type TransactionSource = "manual" | "xlsx" | "gnucash";
export type PaymentSource = TransactionSource;
export type BillFrequency = "monthly" | "quarterly" | "annual";

export interface Account {
  id: number;
  name: string;
  kind: AccountKind;
  /** Ledger account type (facade over `accounts.type`). */
  type: AccountType;
  /** Ledger account subtype (facade over `accounts.subtype`). */
  subtype: AccountSubtype | null;
  /** Parent ledger account id (the root placeholder for funding accounts). */
  parent_id: number | null;
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

// ---------------------------------------------------------------------------
// Double-entry ledger (migration 0009). Split amounts are signed integer
// cents, debit-positive; every transaction's splits sum to exactly 0.
// ---------------------------------------------------------------------------

export type AccountType = "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY";
/** ASSET: bank|cash|savings; LIABILITY: credit_card|loan; other types have none. */
export type AccountSubtype = "bank" | "cash" | "savings" | "credit_card" | "loan";
export type AccountSystemRole =
  | "root_asset"
  | "root_liability"
  | "root_income"
  | "root_expense"
  | "root_equity"
  | "uncategorized"
  | "opening_balances";
/** `n` not reconciled, `c` cleared, `y` reconciled (reconciled splits are locked). */
export type ReconcileState = "n" | "c" | "y";

/** A row of the rebuilt `accounts` table. */
export interface LedgerAccount {
  id: number;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  /** NULL only for the five root accounts. */
  parent_id: number | null;
  /** Placeholder accounts (the roots) can never carry splits. */
  placeholder: boolean;
  system_role: AccountSystemRole | null;
  last4: string | null;
  gnucash_guid: string | null;
  archived: boolean;
}

export interface NewLedgerAccount {
  name: string;
  type: AccountType;
  /** Default `null`. */
  subtype?: AccountSubtype | null;
  /** Parent account id; its `type` must equal this account's `type`. */
  parent_id: number;
  /** Default `false`. */
  placeholder?: boolean;
  /** Default `null`. */
  last4?: string | null;
  /** Default `null`. */
  gnucash_guid?: string | null;
}

export type LedgerAccountPatch = Partial<Omit<NewLedgerAccount, "type">> & { archived?: boolean };

export interface Split {
  id: number;
  transaction_id: number;
  account_id: number;
  /** Signed integer cents, debit-positive — never a float. */
  amount_cents: number;
  memo: string | null;
  reconcile_state: ReconcileState;
}

export interface NewSplit {
  account_id: number;
  /** Signed integer cents, debit-positive — never a float. */
  amount_cents: number;
  /** Default `null`. */
  memo?: string | null;
  /** Default `"n"`. */
  reconcile_state?: ReconcileState;
}

export interface Transaction {
  id: number;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  payee_id: number | null;
  memo: string | null;
  source: TransactionSource;
  external_ref: string | null;
  source_sheet: string | null;
  source_row: number | null;
  source_col: number | null;
  occurrence_index: number | null;
  /** xlsx identity snapshot; non-NULL whenever `source = "xlsx"`. */
  import_account_id: number | null;
  /** xlsx identity snapshot in integer cents; non-NULL whenever `source = "xlsx"`. */
  import_amount_cents: number | null;
  /** Set by the DB default `datetime('now')`. */
  created_at: string;
  splits: Split[];
}

export interface NewTransaction {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Default `null`. */
  payee_id?: number | null;
  /** Default `null`. */
  memo?: string | null;
  /** Default `"manual"`. */
  source?: TransactionSource;
  /** Default `null`. */
  external_ref?: string | null;
  /** Required (non-null) when `source = "xlsx"`; default `null`. */
  source_sheet?: string | null;
  /** Required when `source = "xlsx"`; default `null`. */
  source_row?: number | null;
  /** Required when `source = "xlsx"`; default `null`. */
  source_col?: number | null;
  /** Required (>= 1) when `source = "xlsx"`; default `null`. */
  occurrence_index?: number | null;
  /** Required when `source = "xlsx"`; default `null`. */
  import_account_id?: number | null;
  /** Required when `source = "xlsx"`; integer cents; default `null`. */
  import_amount_cents?: number | null;
  /** Must sum to exactly 0 cents. */
  splits: NewSplit[];
}
