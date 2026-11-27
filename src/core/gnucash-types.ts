/**
 * Frozen IPC payload types for GnuCash file access.
 *
 * Money is integer cents; dates are `YYYY-MM-DD` strings.
 */

/** GnuCash 2.6–5.x SQL books carry this `versions` table value for `Gnucash-Resave`. */
export const SUPPORTED_GNUCASH_RESAVE = 19920;

/**
 * Result of {@link gnucash_probe_book} (`gnucash_probe_book(path)`).
 *
 * A book is `ok` only when its `versions` table has key `Gnucash-Resave` with value
 * exactly {@link SUPPORTED_GNUCASH_RESAVE} (`19920`); any other value maps to
 * `unknown-schema` with the found value in `detail`. The `ok` variant's
 * `schemaVersion` is display-only (the `versions` table `Gnucash` key value); the
 * compatibility gate is `Gnucash-Resave` alone.
 */
export type GnucashBookProbe =
  | { status: "ok"; schemaVersion: number }
  | { status: "xml" }
  | { status: "unknown-schema"; detail: string }
  | { status: "missing" }
  | { status: "unreadable"; detail: string };

/** GnuCash account type as returned by the reader (piecash / GnuCash schema). */
export type GnucashAccountType =
  | "BANK"
  | "CASH"
  | "CREDIT"
  | "LIABILITY"
  | "INCOME"
  | "EXPENSE"
  | "EQUITY"
  | "ROOT";

/**
 * One GnuCash account row.
 *
 * Produced by {@link gnucash_list_accounts} (`gnucash_list_accounts(path)`).
 */
export interface GnucashAccount {
  guid: string;
  name: string;
  account_type: GnucashAccountType;
  parent_guid: string | null;
  placeholder: boolean;
  commodity_mnemonic: string;
  commodity_fraction: number;
  /** Colon-joined path, e.g. `Expenses:Utilities:Electric`. */
  full_path: string;
}

/** One split on a GnuCash transaction (integer cents at the IPC boundary). */
export interface GnucashSplit {
  split_guid: string;
  account_guid: string;
  memo: string;
  /** Integer cents — converted from rational at the Rust boundary. */
  value_cents: number;
}

/**
 * One GnuCash transaction.
 *
 * Listed by {@link gnucash_list_transactions}
 * (`gnucash_list_transactions(path, account_guids, from, to)`).
 */
export interface GnucashTransaction {
  txn_guid: string;
  /** ISO date `YYYY-MM-DD`. */
  post_date: string;
  description: string;
  splits: GnucashSplit[];
}

/** A transaction the reader cannot represent — surfaced, never dropped. */
export interface GnucashTransactionError {
  txn_guid: string;
  post_date: string | null;
  description: string | null;
  reason: string;
}

/**
 * Result of {@link gnucash_list_transactions}
 * (`gnucash_list_transactions(path, account_guids, from, to)`).
 */
export interface GnucashTransactionList {
  transactions: GnucashTransaction[];
  errors: GnucashTransactionError[];
}
