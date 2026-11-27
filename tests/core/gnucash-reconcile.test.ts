import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Payment } from "../../src/core/entities";
import type { GnucashTransaction, GnucashTransactionError, GnucashTransactionList } from "../../src/core/gnucash-types";
import {
  clearOverride,
  reconcile,
  setManualMatch,
  setManualUnmatch,
  summarize,
} from "../../src/core/gnucash-reconcile";
import { openTestDb, type TestDb } from "../support/test-db";

const FUNDING_GUID = "gnucash-funding-acct";
const EXPENSE_GUID = "gnucash-expense-cat";

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeTxn(
  partial: Partial<GnucashTransaction> & Pick<GnucashTransaction, "txn_guid">,
): GnucashTransaction {
  const amount = partial.splits?.find((s) => s.account_guid === FUNDING_GUID)?.value_cents
    ? Math.abs(partial.splits.find((s) => s.account_guid === FUNDING_GUID)!.value_cents)
    : 4858;
  return {
    post_date: partial.post_date ?? "2024-01-01",
    description: partial.description ?? "Power Co",
    splits: partial.splits ?? [
      {
        split_guid: `${partial.txn_guid}-fund`,
        account_guid: FUNDING_GUID,
        memo: "",
        value_cents: -amount,
      },
      {
        split_guid: `${partial.txn_guid}-exp`,
        account_guid: EXPENSE_GUID,
        memo: "",
        value_cents: amount,
      },
    ],
    ...partial,
  };
}

describe("reconcile", () => {
  let t: TestDb;
  let accountId: number;
  let payeeId: number;
  let categoryId: number;

  beforeEach(async () => {
    t = openTestDb();
    accountId = (
      await t.repos.accounts.insert({
        name: "Checking",
        kind: "checking",
        gnucash_guid: FUNDING_GUID,
      })
    ).id;
    categoryId = (
      await t.repos.categories.insert({
        name: "Utilities",
        gnucash_guid: EXPENSE_GUID,
      })
    ).id;
    payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
  });

  afterEach(() => t.close());

  async function insertPayment(
    overrides: Partial<Payment> & Pick<Payment, "date" | "amount_cents">,
  ): Promise<Payment> {
    return t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      source: overrides.source ?? "manual",
      external_ref: overrides.external_ref ?? null,
      memo: overrides.memo ?? null,
      date: overrides.date,
      amount_cents: overrides.amount_cents,
    });
  }

  function emptyList(): GnucashTransactionList {
    return { transactions: [], errors: [] };
  }

  function paymentIds(result: Awaited<ReturnType<typeof reconcile>>): number[] {
    const matched = result.matched.map((pair) => pair.payment.id);
    const finOnly = result.finAppOnly.map((p) => p.id);
    return [...matched, ...finOnly];
  }

  function txnGuids(result: Awaited<ReturnType<typeof reconcile>>): string[] {
    const matched = result.matched.map((pair) => pair.transaction.txn_guid);
    const gcOnly = result.gnucashOnly.map((txn) => txn.txn_guid);
    return [...matched, ...gcOnly];
  }

  it("places fin-app-only payment when no GnuCash transactions exist", async () => {
    const payment = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const result = await reconcile(t.db, [payment], emptyList(), {});

    expect(result.finAppOnly).toHaveLength(1);
    expect(result.finAppOnly[0].id).toBe(payment.id);
    expect(result.matched).toHaveLength(0);
    expect(result.gnucashOnly).toHaveLength(0);
  });

  it("places gnucash-only transaction when no payments exist", async () => {
    const txn = makeTxn({ txn_guid: "txn-alone" });
    const result = await reconcile(t.db, [], { transactions: [txn], errors: [] }, {});

    expect(result.gnucashOnly).toHaveLength(1);
    expect(result.gnucashOnly[0].txn_guid).toBe("txn-alone");
    expect(result.matched).toHaveLength(0);
    expect(result.finAppOnly).toHaveLength(0);
  });

  it("auto-matches on magnitude equality with two-split txn (4858 matches, 4859 does not)", async () => {
    const txn = makeTxn({ txn_guid: "txn-two-split", post_date: "2024-01-01" });
    const matching = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const mismatch = await insertPayment({ date: "2024-01-01", amount_cents: 4859 });

    const matchResult = await reconcile(
      t.db,
      [matching],
      { transactions: [txn], errors: [] },
      {},
    );
    expect(matchResult.matched).toHaveLength(1);
    expect(matchResult.matched[0].payment.id).toBe(matching.id);
    expect(matchResult.matched[0].transaction.txn_guid).toBe("txn-two-split");

    const mismatchResult = await reconcile(
      t.db,
      [mismatch],
      { transactions: [txn], errors: [] },
      {},
    );
    expect(mismatchResult.matched).toHaveLength(0);
    expect(mismatchResult.finAppOnly).toHaveLength(1);
    expect(mismatchResult.gnucashOnly).toHaveLength(1);
  });

  it("auto-matches at default ±3-day tolerance and rejects ±4 days", async () => {
    const txn = makeTxn({ txn_guid: "txn-tol", post_date: "2024-01-04" });
    const atPlus3 = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const atMinus3 = await insertPayment({ date: addDays("2024-01-04", -3), amount_cents: 4858 });
    const atPlus4 = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });

    const txnMinus = makeTxn({ txn_guid: "txn-tol-minus", post_date: "2024-01-04" });
    const txnPlus = makeTxn({ txn_guid: "txn-tol-plus", post_date: "2024-01-01" });

    const plus3Result = await reconcile(
      t.db,
      [atPlus3],
      { transactions: [txn], errors: [] },
      {},
    );
    expect(plus3Result.matched).toHaveLength(1);

    const minus3Result = await reconcile(
      t.db,
      [atMinus3],
      { transactions: [txnMinus], errors: [] },
      {},
    );
    expect(minus3Result.matched).toHaveLength(1);

    const plus4Txn = makeTxn({ txn_guid: "txn-tol-fail", post_date: "2024-01-05" });
    const plus4Result = await reconcile(
      t.db,
      [atPlus4],
      { transactions: [plus4Txn], errors: [] },
      {},
    );
    expect(plus4Result.matched).toHaveLength(0);
    expect(plus4Result.finAppOnly).toHaveLength(1);
    expect(plus4Result.gnucashOnly).toHaveLength(1);
  });

  it("honors custom toleranceDays boundaries", async () => {
    const txn = makeTxn({ txn_guid: "txn-custom", post_date: "2024-01-02" });
    const payment = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });

    const zeroTol = await reconcile(
      t.db,
      [payment],
      { transactions: [txn], errors: [] },
      { toleranceDays: 0 },
    );
    expect(zeroTol.matched).toHaveLength(0);

    const oneTol = await reconcile(
      t.db,
      [payment],
      { transactions: [txn], errors: [] },
      { toleranceDays: 1 },
    );
    expect(oneTol.matched).toHaveLength(1);

    const wideTxn = makeTxn({ txn_guid: "txn-wide", post_date: "2024-01-08" });
    const widePayment = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const sevenTol = await reconcile(
      t.db,
      [widePayment],
      { transactions: [wideTxn], errors: [] },
      { toleranceDays: 7 },
    );
    expect(sevenTol.matched).toHaveLength(1);

    const eightTolFail = await reconcile(
      t.db,
      [widePayment],
      { transactions: [wideTxn], errors: [] },
      { toleranceDays: 6 },
    );
    expect(eightTolFail.matched).toHaveLength(0);
  });

  it("trivially matches payment.external_ref to txn_guid regardless of amount or date", async () => {
    const txn = makeTxn({ txn_guid: "txn-imported", post_date: "2024-06-01" });
    const payment = await insertPayment({
      date: "2024-01-01",
      amount_cents: 9999,
      source: "gnucash",
      external_ref: "txn-imported",
    });

    const result = await reconcile(t.db, [payment], { transactions: [txn], errors: [] }, {});

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].payment.id).toBe(payment.id);
    expect(result.matched[0].transaction.txn_guid).toBe("txn-imported");
  });

  it("applies manual matched override even when amount and date disagree", async () => {
    const txn = makeTxn({ txn_guid: "txn-manual", post_date: "2024-06-01" });
    const payment = await insertPayment({ date: "2024-01-01", amount_cents: 9999 });

    await setManualMatch(t.db, payment.id, "txn-manual");
    const result = await reconcile(t.db, [payment], { transactions: [txn], errors: [] }, {});

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].payment.id).toBe(payment.id);
    expect(result.matched[0].transaction.txn_guid).toBe("txn-manual");
  });

  it("vetoes auto-match and trivial ref when manual unmatched is set", async () => {
    const txn = makeTxn({ txn_guid: "txn-veto", post_date: "2024-01-01" });
    const autoPayment = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    await setManualUnmatch(t.db, autoPayment.id, "txn-veto");

    const autoResult = await reconcile(
      t.db,
      [autoPayment],
      { transactions: [txn], errors: [] },
      {},
    );
    expect(autoResult.matched).toHaveLength(0);
    expect(autoResult.finAppOnly).toHaveLength(1);
    expect(autoResult.gnucashOnly).toHaveLength(1);

    const refTxn = makeTxn({ txn_guid: "txn-ref-veto", post_date: "2024-01-01" });
    const refPayment = await insertPayment({
      date: "2024-01-01",
      amount_cents: 4858,
      source: "gnucash",
      external_ref: "txn-ref-veto",
    });
    await setManualUnmatch(t.db, refPayment.id, "txn-ref-veto");

    const refResult = await reconcile(
      t.db,
      [refPayment],
      { transactions: [refTxn], errors: [] },
      {},
    );
    expect(refResult.matched).toHaveLength(0);
    expect(refResult.finAppOnly).toHaveLength(1);
    expect(refResult.gnucashOnly).toHaveLength(1);
  });

  it("persists manual match across re-import reconcile cycles", async () => {
    const txn = makeTxn({ txn_guid: "txn-persist", post_date: "2024-06-01" });
    const payment = await insertPayment({
      date: "2024-01-01",
      amount_cents: 9999,
      source: "gnucash",
      external_ref: "txn-persist",
    });

    await setManualMatch(t.db, payment.id, "txn-persist");

    const first = await reconcile(t.db, [payment], { transactions: [txn], errors: [] }, {});
    expect(first.matched).toHaveLength(1);

    const second = await reconcile(t.db, [payment], { transactions: [txn], errors: [] }, {});
    expect(second.matched).toHaveLength(1);
    expect(second.matched[0].payment.id).toBe(payment.id);
  });

  it("upserts manual match and unmatch on the unique pair", async () => {
    const payment = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });

    await setManualMatch(t.db, payment.id, "txn-upsert");
    await setManualMatch(t.db, payment.id, "txn-upsert");

    let rows = await t.db.select<{ status: string }>(
      "SELECT status FROM gnucash_matches WHERE payment_id = ? AND txn_guid = ?",
      [payment.id, "txn-upsert"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("matched");

    await setManualUnmatch(t.db, payment.id, "txn-upsert");
    rows = await t.db.select<{ status: string }>(
      "SELECT status FROM gnucash_matches WHERE payment_id = ? AND txn_guid = ?",
      [payment.id, "txn-upsert"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unmatched");

    await clearOverride(t.db, payment.id, "txn-upsert");
    rows = await t.db.select<{ status: string }>(
      "SELECT status FROM gnucash_matches WHERE payment_id = ? AND txn_guid = ?",
      [payment.id, "txn-upsert"],
    );
    expect(rows).toHaveLength(0);
  });

  it("clearOverride on a missing pair is a no-op", async () => {
    await expect(clearOverride(t.db, 999, "missing-txn")).resolves.toBeUndefined();
  });

  it("resolves txn-side ambiguity by closest date then lowest txn_guid", async () => {
    const payment = await insertPayment({ date: "2024-01-05", amount_cents: 4858 });
    const txnA = makeTxn({ txn_guid: "aaa-txn", post_date: "2024-01-05" });
    const txnB = makeTxn({ txn_guid: "bbb-txn", post_date: "2024-01-05" });
    const list = { transactions: [txnB, txnA], errors: [] };

    const first = await reconcile(t.db, [payment], list, {});
    const second = await reconcile(t.db, [payment], list, {});

    expect(first.matched).toHaveLength(1);
    expect(first.matched[0].transaction.txn_guid).toBe("aaa-txn");
    expect(second.matched[0].transaction.txn_guid).toBe("aaa-txn");
    expect(first.gnucashOnly).toHaveLength(1);
    expect(first.gnucashOnly[0].txn_guid).toBe("bbb-txn");
  });

  it("resolves payment-side ambiguity by closest date then lowest payment id", async () => {
    const txn = makeTxn({ txn_guid: "txn-ambig-pay", post_date: "2024-01-05" });
    const payLow = await insertPayment({ date: "2024-01-05", amount_cents: 4858 });
    const payHigh = await insertPayment({ date: "2024-01-05", amount_cents: 4858 });
    const payments = payHigh.id > payLow.id ? [payHigh, payLow] : [payLow, payHigh];
    const lowId = Math.min(payLow.id, payHigh.id);

    const first = await reconcile(t.db, payments, { transactions: [txn], errors: [] }, {});
    const second = await reconcile(t.db, payments, { transactions: [txn], errors: [] }, {});

    expect(first.matched).toHaveLength(1);
    expect(first.matched[0].payment.id).toBe(lowId);
    expect(second.matched[0].payment.id).toBe(lowId);
    expect(first.finAppOnly).toHaveLength(1);
  });

  it("matches at most one partner per payment and per transaction", async () => {
    const pay1 = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const pay2 = await insertPayment({ date: "2024-01-02", amount_cents: 4858 });
    const txn1 = makeTxn({ txn_guid: "txn-1", post_date: "2024-01-01" });
    const txn2 = makeTxn({ txn_guid: "txn-2", post_date: "2024-01-02" });

    const result = await reconcile(
      t.db,
      [pay1, pay2],
      { transactions: [txn1, txn2], errors: [] },
      {},
    );

    expect(result.matched).toHaveLength(2);
    const matchedPayIds = result.matched.map((p) => p.payment.id);
    const matchedTxnGuids = result.matched.map((p) => p.transaction.txn_guid);
    expect(new Set(matchedPayIds).size).toBe(2);
    expect(new Set(matchedTxnGuids).size).toBe(2);
  });

  it("partitions every payment and transaction into exactly one bucket", async () => {
    const pay1 = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const pay2 = await insertPayment({ date: "2024-01-02", amount_cents: 100 });
    const txn1 = makeTxn({ txn_guid: "txn-part-1", post_date: "2024-01-01" });
    const txn2 = makeTxn({ txn_guid: "txn-part-2", post_date: "2024-01-03" });

    const result = await reconcile(
      t.db,
      [pay1, pay2],
      { transactions: [txn1, txn2], errors: [] },
      {},
    );

    expect(new Set(paymentIds(result))).toEqual(new Set([pay1.id, pay2.id]));
    expect(new Set(txnGuids(result))).toEqual(new Set(["txn-part-1", "txn-part-2"]));
    expect(
      result.matched.some((p) => p.payment.id === pay1.id) &&
        !result.matched.some((p) => p.payment.id === pay2.id),
    ).toBe(true);
  });

  it("carries reader errors through unchanged and never matches them", async () => {
    const errors: GnucashTransactionError[] = [
      {
        txn_guid: "err-1",
        post_date: "2024-01-01",
        description: "bad",
        reason: "parse failure",
      },
    ];
    const payment = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const txn = makeTxn({ txn_guid: "txn-ok" });

    const result = await reconcile(
      t.db,
      [payment],
      { transactions: [txn], errors },
      {},
    );

    expect(result.readerErrors).toEqual(errors);
    expect(result.readerErrors).not.toBe(errors);
    expect(result.matched).toHaveLength(1);
    for (const bucket of [result.finAppOnly, result.gnucashOnly, result.matched]) {
      for (const item of bucket) {
        if ("txn_guid" in item && !("splits" in item)) {
          expect(item.txn_guid).not.toBe("err-1");
        }
      }
    }
  });
});

describe("summarize", () => {
  let t: TestDb;
  let accountId: number;
  let payeeId: number;
  let categoryId: number;

  beforeEach(async () => {
    t = openTestDb();
    accountId = (
      await t.repos.accounts.insert({
        name: "Checking",
        kind: "checking",
        gnucash_guid: FUNDING_GUID,
      })
    ).id;
    categoryId = (
      await t.repos.categories.insert({
        name: "Utilities",
        gnucash_guid: EXPENSE_GUID,
      })
    ).id;
    payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
  });

  afterEach(() => t.close());

  async function insertPayment(
    overrides: Partial<Payment> & Pick<Payment, "date" | "amount_cents">,
  ): Promise<Payment> {
    return t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      source: "manual",
      date: overrides.date,
      amount_cents: overrides.amount_cents,
    });
  }

  it("returns per-account counts and integer-cent totals including abs gnucash-only rule", async () => {
    const matchedPay = await insertPayment({ date: "2024-01-01", amount_cents: 4858 });
    const finOnlyPay = await insertPayment({ date: "2024-01-02", amount_cents: 2000 });
    const matchedTxn = makeTxn({ txn_guid: "txn-sum-m", post_date: "2024-01-01" });
    const gcOnlyTxn = makeTxn({
      txn_guid: "txn-sum-g",
      post_date: "2024-01-03",
      splits: [
        {
          split_guid: "g-fund",
          account_guid: FUNDING_GUID,
          memo: "",
          value_cents: -4858,
        },
        {
          split_guid: "g-exp",
          account_guid: EXPENSE_GUID,
          memo: "",
          value_cents: 4858,
        },
      ],
    });

    const reconcileResult = await reconcile(
      t.db,
      [matchedPay, finOnlyPay],
      { transactions: [matchedTxn, gcOnlyTxn], errors: [] },
      {},
    );

    const summaries = summarize(reconcileResult);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].accountId).toBe(accountId);
    expect(summaries[0].matchedCount).toBe(reconcileResult.matched.length);
    expect(summaries[0].finAppOnlyCount).toBe(reconcileResult.finAppOnly.length);
    expect(summaries[0].gnucashOnlyCount).toBe(reconcileResult.gnucashOnly.length);
    expect(summaries[0].matchedTotalCents).toBe(4858);
    expect(summaries[0].finAppOnlyTotalCents).toBe(2000);
    expect(summaries[0].gnucashOnlyTotalCents).toBe(4858);
  });
});
