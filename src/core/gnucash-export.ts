import type { Database, SqlValue } from "./db";
import type { Account, AccountKind, Category, Payee, Payment } from "./entities";
import type { GnucashAccount } from "./gnucash-types";

export interface ExportFilters {
  /** Inclusive ISO date window (`YYYY-MM-DD`). */
  fromDate: string;
  toDate: string;
  /** When false (default), exclude payments with prior export rows. */
  includeExported: boolean;
}

export interface ExportHistoryEntry {
  format: "qif" | "csv";
  exportedAt: string;
}

export interface ExportablePayment extends Payment {
  exportHistory: ExportHistoryEntry[];
}

export interface ExportBlocker {
  paymentId: number;
  reason: string;
}

export interface ExportValidation {
  blockers: ExportBlocker[];
}

export interface ExportBuildInput {
  payments: Payment[];
  accounts: Account[];
  categories: Category[];
  gnucashAccounts: GnucashAccount[];
  payees: Payee[];
}

const PAYMENT_COLUMNS =
  "id, payee_id, account_id, category_id, date, amount_cents, memo, source, external_ref, source_sheet, source_row, source_col, occurrence_index, created_at";

interface ExportHistoryRow {
  payment_id: number;
  format: "qif" | "csv";
  exported_at: string;
}

function formatCentsDecimal(amountCents: number): string {
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100);
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${sign}${dollars}.${cents}`;
}

/** Bill-pay outflows are stored positive; export negates to QIF/CSV money-out sign. */
function formatExportAmount(amountCents: number): string {
  return formatCentsDecimal(-amountCents);
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvLine(fields: string[]): string {
  return fields.map(escapeCsvField).join(",");
}

function isoToQifDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function qifTypeForKind(kind: AccountKind): string {
  switch (kind) {
    case "checking":
      return "Bank";
    case "cash":
      return "Cash";
    case "credit":
      return "CCard";
  }
}

function accountById(accounts: Account[]): Map<number, Account> {
  return new Map(accounts.map((a) => [a.id, a]));
}

function categoryById(categories: Category[]): Map<number, Category> {
  return new Map(categories.map((c) => [c.id, c]));
}

function payeeById(payees: Payee[]): Map<number, Payee> {
  return new Map(payees.map((p) => [p.id, p]));
}

function gnucashByGuid(gnucashAccounts: GnucashAccount[]): Map<string, GnucashAccount> {
  return new Map(gnucashAccounts.map((a) => [a.guid, a]));
}

function resolveAccountPath(
  account: Account,
  gnucashLookup: Map<string, GnucashAccount>,
): string {
  if (account.gnucash_guid === null) {
    throw new Error(`export: funding account ${account.id} is not mapped to GnuCash`);
  }
  const gnucash = gnucashLookup.get(account.gnucash_guid);
  if (gnucash === undefined) {
    throw new Error(
      `export: GnuCash account ${account.gnucash_guid} not found for funding account ${account.id}`,
    );
  }
  return gnucash.full_path;
}

function resolveCategoryPath(
  category: Category,
  gnucashLookup: Map<string, GnucashAccount>,
): string {
  if (category.gnucash_guid === null) {
    throw new Error(`export: category ${category.id} is not mapped to GnuCash`);
  }
  const gnucash = gnucashLookup.get(category.gnucash_guid);
  if (gnucash === undefined) {
    throw new Error(
      `export: GnuCash account ${category.gnucash_guid} not found for category ${category.id}`,
    );
  }
  return gnucash.full_path;
}

interface SortedExportRow {
  payment: Payment;
  accountPath: string;
  categoryPath: string;
  payeeName: string;
  account: Account;
}

function buildSortedRows(input: ExportBuildInput): SortedExportRow[] {
  const accounts = accountById(input.accounts);
  const categories = categoryById(input.categories);
  const payees = payeeById(input.payees);
  const gnucashLookup = gnucashByGuid(input.gnucashAccounts);

  const rows: SortedExportRow[] = input.payments.map((payment) => {
    const account = accounts.get(payment.account_id);
    if (account === undefined) {
      throw new Error(`export: unknown funding account ${payment.account_id}`);
    }
    if (payment.category_id === null) {
      throw new Error(`export: payment ${payment.id} has no category`);
    }
    const category = categories.get(payment.category_id);
    if (category === undefined) {
      throw new Error(`export: unknown category ${payment.category_id}`);
    }
    const payee = payees.get(payment.payee_id);
    if (payee === undefined) {
      throw new Error(`export: unknown payee ${payment.payee_id}`);
    }

    return {
      payment,
      accountPath: resolveAccountPath(account, gnucashLookup),
      categoryPath: resolveCategoryPath(category, gnucashLookup),
      payeeName: payee.name,
      account,
    };
  });

  rows.sort((a, b) => {
    const pathCmp = a.accountPath.localeCompare(b.accountPath);
    if (pathCmp !== 0) return pathCmp;
    const dateCmp = a.payment.date.localeCompare(b.payment.date);
    if (dateCmp !== 0) return dateCmp;
    return a.payment.id - b.payment.id;
  });

  return rows;
}

export async function listExportablePayments(
  db: Database,
  filters: ExportFilters,
): Promise<ExportablePayment[]> {
  const clauses = ["p.date >= ?", "p.date <= ?"];
  const params: SqlValue[] = [filters.fromDate, filters.toDate];

  if (!filters.includeExported) {
    clauses.push(
      "NOT EXISTS (SELECT 1 FROM payment_exports pe WHERE pe.payment_id = p.id)",
    );
  }

  const payments = await db.select<Payment>(
    `SELECT ${PAYMENT_COLUMNS.replace(/(^|,\s)([a-z_]+)/g, "$1p.$2")} FROM payments p WHERE ${clauses.join(" AND ")} ORDER BY p.date, p.id`,
    params,
  );

  if (payments.length === 0) {
    return [];
  }

  const ids = payments.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(", ");
  const historyRows = await db.select<ExportHistoryRow>(
    `SELECT payment_id, format, exported_at FROM payment_exports WHERE payment_id IN (${placeholders}) ORDER BY exported_at ASC, id ASC`,
    ids,
  );

  const historyByPayment = new Map<number, ExportHistoryEntry[]>();
  for (const row of historyRows) {
    const entry: ExportHistoryEntry = { format: row.format, exportedAt: row.exported_at };
    const existing = historyByPayment.get(row.payment_id);
    if (existing === undefined) {
      historyByPayment.set(row.payment_id, [entry]);
    } else {
      existing.push(entry);
    }
  }

  return payments.map((payment) => ({
    ...payment,
    exportHistory: historyByPayment.get(payment.id) ?? [],
  }));
}

export function validateForExport(
  payments: Payment[],
  accounts: Account[],
  categories: Category[],
): ExportValidation {
  const accountLookup = accountById(accounts);
  const categoryLookup = categoryById(categories);
  const blockers: ExportBlocker[] = [];

  for (const payment of payments) {
    const account = accountLookup.get(payment.account_id);
    if (account === undefined || account.gnucash_guid === null) {
      blockers.push({
        paymentId: payment.id,
        reason: `Payment ${payment.id}: funding account is not mapped to GnuCash`,
      });
    }

    if (payment.category_id === null) {
      blockers.push({
        paymentId: payment.id,
        reason: `Payment ${payment.id}: category is missing`,
      });
    } else {
      const category = categoryLookup.get(payment.category_id);
      if (category === undefined || category.gnucash_guid === null) {
        blockers.push({
          paymentId: payment.id,
          reason: `Payment ${payment.id}: category is not mapped to GnuCash`,
        });
      }
    }
  }

  return { blockers };
}

export function buildQif(input: ExportBuildInput): string {
  const rows = buildSortedRows(input);
  const lines: string[] = [];
  let currentAccountPath: string | null = null;

  for (const row of rows) {
    if (row.accountPath !== currentAccountPath) {
      if (currentAccountPath !== null) {
        lines.push("");
      }
      currentAccountPath = row.accountPath;
      lines.push("!Account");
      lines.push(row.accountPath);
      lines.push(`!Type:${qifTypeForKind(row.account.kind)}`);
    }

    lines.push(`D${isoToQifDate(row.payment.date)}`);
    lines.push(`T${formatExportAmount(row.payment.amount_cents)}`);
    lines.push(`P${row.payeeName}`);
    lines.push(`L${row.categoryPath}`);
    if (row.payment.memo !== null && row.payment.memo.length > 0) {
      lines.push(`M${row.payment.memo}`);
    }
    lines.push("^");
  }

  return lines.join("\n");
}

export function buildCsv(input: ExportBuildInput): string {
  const rows = buildSortedRows(input);
  const lines = ["date,account,description,category,amount"];

  for (const row of rows) {
    lines.push(
      csvLine([
        row.payment.date,
        row.accountPath,
        row.payeeName,
        row.categoryPath,
        formatExportAmount(row.payment.amount_cents),
      ]),
    );
  }

  return lines.join("\n");
}

export async function recordExport(
  db: Database,
  paymentIds: number[],
  format: "qif" | "csv",
): Promise<void> {
  if (paymentIds.length === 0) {
    return;
  }

  await db.batch(
    paymentIds.map((paymentId) => ({
      sql: "INSERT INTO payment_exports (payment_id, format) VALUES (?, ?)",
      params: [paymentId, format],
    })),
  );
}
