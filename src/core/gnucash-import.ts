import type { BatchStatement } from "./db";
import type { Database } from "./db";
import type { Account, Category, Payee, Payment } from "./entities";
import type { GnucashSplit, GnucashTransaction, GnucashTransactionError, GnucashTransactionList } from "./gnucash-types";
import type { Repositories } from "./index";
import { normalizePayeeLabel } from "./payee-normalization";

export interface GnucashImportOptions {
  /** Mapped GnuCash account GUIDs selected for import. */
  accountGuids?: string[];
}

export interface GnucashImportPlanNewRow {
  txnGuid: string;
  date: string;
  amount_cents: number;
  memo: string;
  accountId: number;
  categoryId: number;
  payeeId?: number;
  payeeCreateSuggestion?: string;
}

export interface GnucashImportPlanUnchangedRow {
  txnGuid: string;
  paymentId: number;
}

export interface GnucashImportFieldDiff {
  field: string;
  existing: string | number | null;
  incoming: string | number | null;
}

export interface GnucashImportPlanUpdatedRow {
  txnGuid: string;
  paymentId: number;
  diffs: GnucashImportFieldDiff[];
}

export interface GnucashImportPlanMergeCandidateRow {
  txnGuid: string;
  paymentId: number;
}

export interface GnucashImportPlanUnmappableRow {
  txnGuid: string;
  reason: string;
}

export interface GnucashImportPlanUnreadableRow {
  error: GnucashTransactionError;
}

export interface GnucashImportPlan {
  new: GnucashImportPlanNewRow[];
  unchanged: GnucashImportPlanUnchangedRow[];
  updated: GnucashImportPlanUpdatedRow[];
  mergeCandidates: GnucashImportPlanMergeCandidateRow[];
  unmappable: GnucashImportPlanUnmappableRow[];
  unreadable: GnucashImportPlanUnreadableRow[];
}

export interface GnucashImportApproval {
  approvedNewTxnGuids: string[];
  approvedUpdateTxnGuids: string[];
  approvedMergeTxnGuids: string[];
  /** Commit context — required at commit time. */
  list?: GnucashTransactionList;
  options?: GnucashImportOptions;
  /** Confirmed payee ids for new rows keyed by txn_guid. */
  confirmedPayeeIds?: Record<string, number>;
  /** Test hook: poison the batch after N payment writes. */
  fail_after_insert_count?: number;
}

export interface GnucashImportResult {
  inserted: number;
  merged: number;
  skipped: number;
}

interface MappedEntities {
  accountsByGnucashGuid: Map<string, Account>;
  categoriesByGnucashGuid: Map<string, Category>;
  payees: Payee[];
}

interface MappableTxn {
  txn: GnucashTransaction;
  fundingSplit: GnucashSplit;
  expenseSplit: GnucashSplit;
  accountId: number;
  categoryId: number;
  amount_cents: number;
  payeeId?: number;
  payeeCreateSuggestion?: string;
}

function payeeKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDaysApart(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const start = Date.UTC(ay, am - 1, ad);
  const end = Date.UTC(by, bm - 1, bd);
  return Math.abs(Math.round((end - start) / 86_400_000));
}

function dateWindow(list: GnucashTransactionList): { from: string; to: string } {
  const dates = list.transactions.map((txn) => txn.post_date);
  if (dates.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return { from: addCalendarDays(today, -3), to: addCalendarDays(today, 3) };
  }
  const sorted = [...dates].sort();
  return {
    from: addCalendarDays(sorted[0], -3),
    to: addCalendarDays(sorted[sorted.length - 1], 3),
  };
}

async function loadMappedEntities(repos: Repositories): Promise<MappedEntities> {
  const [accounts, categories, payees] = await Promise.all([
    repos.accounts.list({ includeArchived: true }),
    repos.categories.list({ includeArchived: true }),
    repos.payees.list({ includeArchived: true }),
  ]);

  const accountsByGnucashGuid = new Map<string, Account>();
  for (const account of accounts) {
    if (account.gnucash_guid) {
      accountsByGnucashGuid.set(account.gnucash_guid, account);
    }
  }

  const categoriesByGnucashGuid = new Map<string, Category>();
  for (const category of categories) {
    if (category.gnucash_guid) {
      categoriesByGnucashGuid.set(category.gnucash_guid, category);
    }
  }

  return { accountsByGnucashGuid, categoriesByGnucashGuid, payees };
}

function resolvePayee(
  description: string,
  payees: Payee[],
): Pick<MappableTxn, "payeeId" | "payeeCreateSuggestion"> {
  const normalized = normalizePayeeLabel(description);
  const key = payeeKey(normalized.payee);
  for (const payee of payees) {
    if (payee.name === normalized.payee || payeeKey(payee.name) === key) {
      return { payeeId: payee.id };
    }
  }
  return { payeeCreateSuggestion: normalized.payee };
}

function selectedAccountGuids(options: GnucashImportOptions): Set<string> {
  return new Set(options.accountGuids ?? []);
}

function classifyUnmappable(
  txn: GnucashTransaction,
  entities: MappedEntities,
  accountGuids: Set<string>,
): string | null {
  const fundingSplits = txn.splits.filter((split) => accountGuids.has(split.account_guid));
  const mappedFunding = fundingSplits.find((split) => entities.accountsByGnucashGuid.has(split.account_guid));

  if (!mappedFunding) {
    return `unmapped funding account for transaction ${txn.txn_guid}`;
  }

  const expenseSplits = txn.splits.filter((split) => entities.categoriesByGnucashGuid.has(split.account_guid));

  if (expenseSplits.length === 0) {
    return `unmapped category/expense account for transaction ${txn.txn_guid}`;
  }

  if (expenseSplits.length > 1) {
    const details = expenseSplits
      .map((split) => `${split.account_guid} (${split.value_cents} cents)`)
      .join(", ");
    return `multiple mapped expense splits for transaction ${txn.txn_guid}: ${details}`;
  }

  return null;
}

function buildMappableTxn(
  txn: GnucashTransaction,
  entities: MappedEntities,
  accountGuids: Set<string>,
): MappableTxn | null {
  const reason = classifyUnmappable(txn, entities, accountGuids);
  if (reason) return null;

  const fundingSplit = txn.splits.find(
    (split) => accountGuids.has(split.account_guid) && entities.accountsByGnucashGuid.has(split.account_guid),
  )!;
  const expenseSplit = txn.splits.find((split) => entities.categoriesByGnucashGuid.has(split.account_guid))!;

  return {
    txn,
    fundingSplit,
    expenseSplit,
    accountId: entities.accountsByGnucashGuid.get(fundingSplit.account_guid)!.id,
    categoryId: entities.categoriesByGnucashGuid.get(expenseSplit.account_guid)!.id,
    amount_cents: expenseSplit.value_cents,
    ...resolvePayee(txn.description, entities.payees),
  };
}

function gnucashPaymentByGuid(payments: Payment[]): Map<string, Payment> {
  const byGuid = new Map<string, Payment>();
  for (const payment of payments) {
    if (payment.source === "gnucash" && payment.external_ref) {
      byGuid.set(payment.external_ref, payment);
    }
  }
  return byGuid;
}

function buildDiffs(existing: Payment, mapped: MappableTxn): GnucashImportFieldDiff[] {
  const diffs: GnucashImportFieldDiff[] = [];
  if (existing.date !== mapped.txn.post_date) {
    diffs.push({ field: "date", existing: existing.date, incoming: mapped.txn.post_date });
  }
  if (existing.amount_cents !== mapped.amount_cents) {
    diffs.push({ field: "amount_cents", existing: existing.amount_cents, incoming: mapped.amount_cents });
  }
  const incomingMemo = mapped.txn.description;
  if ((existing.memo ?? null) !== incomingMemo) {
    diffs.push({ field: "memo", existing: existing.memo, incoming: incomingMemo });
  }
  return diffs;
}

function findMergeCandidate(
  mapped: MappableTxn,
  payments: Payment[],
  gnucashByGuid: Map<string, Payment>,
): Payment | null {
  if (gnucashByGuid.has(mapped.txn.txn_guid)) return null;

  for (const payment of payments) {
    if (payment.source !== "manual") continue;
    if (payment.account_id !== mapped.accountId) continue;
    if (payment.amount_cents !== mapped.amount_cents) continue;
    if (calendarDaysApart(payment.date, mapped.txn.post_date) > 3) continue;
    return payment;
  }
  return null;
}

export async function planGnucashImport(
  repos: Repositories,
  list: GnucashTransactionList,
  options: GnucashImportOptions,
): Promise<GnucashImportPlan> {
  const plan: GnucashImportPlan = {
    new: [],
    unchanged: [],
    updated: [],
    mergeCandidates: [],
    unmappable: [],
    unreadable: list.errors.map((error) => ({ error })),
  };

  const entities = await loadMappedEntities(repos);
  const accountGuids = selectedAccountGuids(options);
  const window = dateWindow(list);
  const payments = await repos.payments.list(window);
  const gnucashByGuid = gnucashPaymentByGuid(payments);

  for (const txn of list.transactions) {
    const unmappableReason = classifyUnmappable(txn, entities, accountGuids);
    if (unmappableReason) {
      plan.unmappable.push({ txnGuid: txn.txn_guid, reason: unmappableReason });
      continue;
    }

    const mapped = buildMappableTxn(txn, entities, accountGuids)!;
    const existing = gnucashByGuid.get(txn.txn_guid);

    if (existing) {
      const diffs = buildDiffs(existing, mapped);
      if (diffs.length === 0) {
        plan.unchanged.push({ txnGuid: txn.txn_guid, paymentId: existing.id });
      } else {
        plan.updated.push({ txnGuid: txn.txn_guid, paymentId: existing.id, diffs });
      }
      continue;
    }

    const mergeCandidate = findMergeCandidate(mapped, payments, gnucashByGuid);
    if (mergeCandidate) {
      plan.mergeCandidates.push({ txnGuid: txn.txn_guid, paymentId: mergeCandidate.id });
      continue;
    }

    plan.new.push({
      txnGuid: txn.txn_guid,
      date: txn.post_date,
      amount_cents: mapped.amount_cents,
      memo: txn.description,
      accountId: mapped.accountId,
      categoryId: mapped.categoryId,
      payeeId: mapped.payeeId,
      payeeCreateSuggestion: mapped.payeeCreateSuggestion,
    });
  }

  return plan;
}

function assertCommitContext(approved: GnucashImportApproval): {
  list: GnucashTransactionList;
  options: GnucashImportOptions;
} {
  if (!approved.list) {
    throw new Error("commitGnucashImport requires approval.list");
  }
  if (!approved.options) {
    throw new Error("commitGnucashImport requires approval.options");
  }
  return { list: approved.list, options: approved.options };
}

function buildCommitStatements(
  plan: GnucashImportPlan,
  approved: GnucashImportApproval,
  mappedByGuid: Map<string, MappableTxn>,
): { statements: BatchStatement[]; inserted: number; merged: number; skipped: number } {
  const approvedNew = new Set(approved.approvedNewTxnGuids);
  const approvedUpdate = new Set(approved.approvedUpdateTxnGuids);
  const approvedMerge = new Set(approved.approvedMergeTxnGuids);
  const confirmedPayees = approved.confirmedPayeeIds ?? {};

  const statements: BatchStatement[] = [];
  let inserted = 0;
  let merged = 0;
  let skipped = 0;
  let paymentWriteCount = 0;

  for (const row of plan.new) {
    if (!approvedNew.has(row.txnGuid)) {
      skipped += 1;
      continue;
    }

    const payeeId = row.payeeId ?? confirmedPayees[row.txnGuid];
    if (!payeeId) {
      skipped += 1;
      continue;
    }

    statements.push({
      sql: `INSERT INTO payments (
              payee_id,
              account_id,
              category_id,
              date,
              amount_cents,
              memo,
              source,
              external_ref,
              source_sheet,
              source_row,
              source_col,
              occurrence_index
            )
            VALUES (?, ?, ?, ?, ?, ?, 'gnucash', ?, NULL, NULL, NULL, NULL)`,
      params: [
        payeeId,
        row.accountId,
        row.categoryId,
        row.date,
        row.amount_cents,
        row.memo,
        row.txnGuid,
      ],
    });
    inserted += 1;
    paymentWriteCount += 1;

    if (
      approved.fail_after_insert_count !== undefined &&
      paymentWriteCount === approved.fail_after_insert_count
    ) {
      statements.push({
        sql: 'INSERT INTO "injected failure after gnucash payment write" DEFAULT VALUES',
        params: [],
      });
    }
  }

  for (const row of plan.mergeCandidates) {
    if (!approvedMerge.has(row.txnGuid)) {
      skipped += 1;
      continue;
    }

    statements.push({
      sql: "UPDATE payments SET source = 'gnucash', external_ref = ? WHERE id = ?",
      params: [row.txnGuid, row.paymentId],
    });
    merged += 1;
    paymentWriteCount += 1;

    if (
      approved.fail_after_insert_count !== undefined &&
      paymentWriteCount === approved.fail_after_insert_count
    ) {
      statements.push({
        sql: 'INSERT INTO "injected failure after gnucash payment write" DEFAULT VALUES',
        params: [],
      });
    }
  }

  for (const row of plan.updated) {
    if (!approvedUpdate.has(row.txnGuid)) {
      skipped += 1;
      continue;
    }

    const mapped = mappedByGuid.get(row.txnGuid);
    if (!mapped) {
      skipped += 1;
      continue;
    }

    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    for (const diff of row.diffs) {
      if (diff.field === "date") {
        fields.push("date = ?");
        params.push(mapped.txn.post_date);
      } else if (diff.field === "amount_cents") {
        fields.push("amount_cents = ?");
        params.push(mapped.amount_cents);
      } else if (diff.field === "memo") {
        fields.push("memo = ?");
        params.push(mapped.txn.description);
      }
    }

    if (fields.length === 0) {
      skipped += 1;
      continue;
    }

    statements.push({
      sql: `UPDATE payments SET ${fields.join(", ")} WHERE id = ?`,
      params: [...params, row.paymentId],
    });
    paymentWriteCount += 1;

    if (
      approved.fail_after_insert_count !== undefined &&
      paymentWriteCount === approved.fail_after_insert_count
    ) {
      statements.push({
        sql: 'INSERT INTO "injected failure after gnucash payment write" DEFAULT VALUES',
        params: [],
      });
    }
  }

  return { statements, inserted, merged, skipped };
}

export async function commitGnucashImport(
  db: Database,
  repos: Repositories,
  approved: GnucashImportApproval,
): Promise<GnucashImportResult> {
  void db;
  const { list, options } = assertCommitContext(approved);
  const plan = await planGnucashImport(repos, list, options);

  const entities = await loadMappedEntities(repos);
  const accountGuids = selectedAccountGuids(options);
  const mappedByGuid = new Map<string, MappableTxn>();
  for (const txn of list.transactions) {
    const mapped = buildMappableTxn(txn, entities, accountGuids);
    if (mapped) mappedByGuid.set(txn.txn_guid, mapped);
  }

  const { statements, inserted, merged, skipped } = buildCommitStatements(plan, approved, mappedByGuid);

  if (statements.length > 0) {
    await repos.batch(statements);
  }

  return { inserted, merged, skipped };
}
