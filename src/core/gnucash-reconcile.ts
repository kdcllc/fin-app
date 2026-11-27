import type { Database } from "./db";
import type { Payment } from "./entities";
import type { GnucashTransaction, GnucashTransactionError, GnucashTransactionList } from "./gnucash-types";

export interface ReconcileOptions {
  /** Post-date tolerance in days; default 3 when omitted. */
  toleranceDays?: number;
}

export interface ReconcileMatchedPair {
  payment: Payment;
  transaction: GnucashTransaction;
}

export interface ReconcileResult {
  matched: ReconcileMatchedPair[];
  finAppOnly: Payment[];
  gnucashOnly: GnucashTransaction[];
  readerErrors: GnucashTransactionError[];
}

export interface ReconcileSummary {
  accountId: number;
  matchedCount: number;
  finAppOnlyCount: number;
  gnucashOnlyCount: number;
  matchedTotalCents: number;
  finAppOnlyTotalCents: number;
  gnucashOnlyTotalCents: number;
}

interface GnucashMatchRow {
  payment_id: number;
  txn_guid: string;
  status: "matched" | "unmatched";
}

const SELECT_MATCHES = "SELECT payment_id, txn_guid, status FROM gnucash_matches";
const UPSERT_MATCHED = `INSERT INTO gnucash_matches (payment_id, txn_guid, status)
  VALUES (?, ?, 'matched')
  ON CONFLICT (payment_id, txn_guid) DO UPDATE SET status = 'matched'`;
const UPSERT_UNMATCHED = `INSERT INTO gnucash_matches (payment_id, txn_guid, status)
  VALUES (?, ?, 'unmatched')
  ON CONFLICT (payment_id, txn_guid) DO UPDATE SET status = 'unmatched'`;
const DELETE_OVERRIDE =
  "DELETE FROM gnucash_matches WHERE payment_id = ? AND txn_guid = ?";

function pairKey(paymentId: number, txnGuid: string): string {
  return `${paymentId}:${txnGuid}`;
}

function calendarDayDistance(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.abs(Math.round((t2 - t1) / 86_400_000));
}

/** Account GUID present on every transaction — single-account reconcile scope. */
function inferReconciledAccountGuid(transactions: GnucashTransaction[]): string | null {
  if (transactions.length === 0) return null;

  const [first, ...rest] = transactions;
  for (const guid of new Set(first.splits.map((split) => split.account_guid))) {
    if (rest.every((txn) => txn.splits.some((split) => split.account_guid === guid))) {
      return guid;
    }
  }
  return null;
}

function relevantSplit(
  txn: GnucashTransaction,
  reconciledAccountGuid: string | null,
): GnucashTransaction["splits"][number] | undefined {
  if (!reconciledAccountGuid) return undefined;
  return txn.splits.find((split) => split.account_guid === reconciledAccountGuid);
}

function relevantSplitMagnitude(
  txn: GnucashTransaction,
  reconciledAccountGuid: string | null,
): number | null {
  const split = relevantSplit(txn, reconciledAccountGuid);
  return split ? Math.abs(split.value_cents) : null;
}

export async function reconcile(
  db: Database,
  payments: Payment[],
  list: GnucashTransactionList,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const toleranceDays = options.toleranceDays ?? 3;
  const readerErrors = [...list.errors];

  const overrideRows = await db.select<GnucashMatchRow>(SELECT_MATCHES);
  const manualMatched = overrideRows.filter((row) => row.status === "matched");
  const manualUnmatched = new Set(
    overrideRows.filter((row) => row.status === "unmatched").map((row) => pairKey(row.payment_id, row.txn_guid)),
  );

  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const txnByGuid = new Map(list.transactions.map((txn) => [txn.txn_guid, txn]));
  const reconciledAccountGuid = inferReconciledAccountGuid(list.transactions);

  const matchedPaymentIds = new Set<number>();
  const matchedTxnGuids = new Set<string>();
  const matched: ReconcileMatchedPair[] = [];

  const isVetoed = (paymentId: number, txnGuid: string): boolean =>
    manualUnmatched.has(pairKey(paymentId, txnGuid));

  const tryMatch = (payment: Payment, txn: GnucashTransaction): void => {
    if (matchedPaymentIds.has(payment.id) || matchedTxnGuids.has(txn.txn_guid)) return;
    if (isVetoed(payment.id, txn.txn_guid)) return;
    matched.push({ payment, transaction: txn });
    matchedPaymentIds.add(payment.id);
    matchedTxnGuids.add(txn.txn_guid);
  };

  const sortedManualMatched = [...manualMatched].sort((a, b) =>
    a.payment_id !== b.payment_id ? a.payment_id - b.payment_id : a.txn_guid.localeCompare(b.txn_guid),
  );
  for (const row of sortedManualMatched) {
    const payment = paymentById.get(row.payment_id);
    const txn = txnByGuid.get(row.txn_guid);
    if (payment && txn) {
      tryMatch(payment, txn);
    }
  }

  const sortedPayments = [...payments].sort((a, b) => a.id - b.id);
  for (const payment of sortedPayments) {
    if (!payment.external_ref || matchedPaymentIds.has(payment.id)) continue;
    const txn = txnByGuid.get(payment.external_ref);
    if (txn) {
      tryMatch(payment, txn);
    }
  }

  interface AutoCandidate {
    payment: Payment;
    txn: GnucashTransaction;
    dateDist: number;
  }

  const autoCandidates: AutoCandidate[] = [];
  for (const payment of payments) {
    if (matchedPaymentIds.has(payment.id)) continue;
    for (const txn of list.transactions) {
      if (matchedTxnGuids.has(txn.txn_guid)) continue;
      if (isVetoed(payment.id, txn.txn_guid)) continue;

      const magnitude = relevantSplitMagnitude(txn, reconciledAccountGuid);
      if (magnitude === null || payment.amount_cents !== magnitude) continue;

      const dateDist = calendarDayDistance(payment.date, txn.post_date);
      if (dateDist > toleranceDays) continue;

      autoCandidates.push({ payment, txn, dateDist });
    }
  }

  autoCandidates.sort((a, b) => {
    if (a.dateDist !== b.dateDist) return a.dateDist - b.dateDist;
    if (a.payment.id !== b.payment.id) return a.payment.id - b.payment.id;
    return a.txn.txn_guid.localeCompare(b.txn.txn_guid);
  });

  for (const candidate of autoCandidates) {
    tryMatch(candidate.payment, candidate.txn);
  }

  const finAppOnly = payments.filter((payment) => !matchedPaymentIds.has(payment.id));
  const gnucashOnly = list.transactions.filter((txn) => !matchedTxnGuids.has(txn.txn_guid));

  return { matched, finAppOnly, gnucashOnly, readerErrors };
}

export async function setManualMatch(
  db: Database,
  paymentId: number,
  txnGuid: string,
): Promise<void> {
  await db.execute(UPSERT_MATCHED, [paymentId, txnGuid]);
}

export async function setManualUnmatch(
  db: Database,
  paymentId: number,
  txnGuid: string,
): Promise<void> {
  await db.execute(UPSERT_UNMATCHED, [paymentId, txnGuid]);
}

export async function clearOverride(
  db: Database,
  paymentId: number,
  txnGuid: string,
): Promise<void> {
  await db.execute(DELETE_OVERRIDE, [paymentId, txnGuid]);
}

export function summarize(result: ReconcileResult): ReconcileSummary[] {
  const accountIds = new Set<number>();
  for (const pair of result.matched) {
    accountIds.add(pair.payment.account_id);
  }
  for (const payment of result.finAppOnly) {
    accountIds.add(payment.account_id);
  }

  const allTxns = [
    ...result.matched.map((pair) => pair.transaction),
    ...result.gnucashOnly,
  ];
  const reconciledAccountGuid = inferReconciledAccountGuid(allTxns);

  const summaries: ReconcileSummary[] = [];
  for (const accountId of [...accountIds].sort((a, b) => a - b)) {
    const matchedPairs = result.matched.filter((pair) => pair.payment.account_id === accountId);
    const finAppOnly = result.finAppOnly.filter((payment) => payment.account_id === accountId);

    summaries.push({
      accountId,
      matchedCount: matchedPairs.length,
      finAppOnlyCount: finAppOnly.length,
      gnucashOnlyCount: result.gnucashOnly.length,
      matchedTotalCents: matchedPairs.reduce((sum, pair) => sum + pair.payment.amount_cents, 0),
      finAppOnlyTotalCents: finAppOnly.reduce((sum, payment) => sum + payment.amount_cents, 0),
      gnucashOnlyTotalCents: result.gnucashOnly.reduce((sum, txn) => {
        const magnitude = relevantSplitMagnitude(txn, reconciledAccountGuid);
        return sum + (magnitude ?? 0);
      }, 0),
    });
  }

  return summaries;
}
