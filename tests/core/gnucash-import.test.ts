import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GnucashTransaction, GnucashTransactionList } from "../../src/core/gnucash-types";
import {
  commitGnucashImport,
  planGnucashImport,
  type GnucashImportApproval,
  type GnucashImportOptions,
} from "../../src/core/gnucash-import";
import { postTransaction } from "../../src/core";
import { normalizePayeeLabel } from "../../src/core/payee-normalization";
import { openTestDb, type TestDb } from "../support/test-db";

const FUNDING_GUID = "gnucash-funding-acct";
const EXPENSE_GUID = "gnucash-expense-cat";
const EXPENSE_GUID_2 = "gnucash-expense-cat-2";

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeTxn(partial: Partial<GnucashTransaction> & Pick<GnucashTransaction, "txn_guid">): GnucashTransaction {
  const postDate = partial.post_date ?? "2026-03-15";
  const amount = partial.splits?.find((s) => s.value_cents > 0)?.value_cents ?? 4858;
  return {
    post_date: postDate,
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

function defaultOptions(): GnucashImportOptions {
  return { accountGuids: [FUNDING_GUID] };
}

describe("planGnucashImport", () => {
  let t: TestDb;
  let accountId: number;
  let categoryId: number;
  let payeeId: number;

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

  async function tableCount(name: string): Promise<number> {
    const rows = await t.db.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`);
    return rows[0].count;
  }

  it("classifies every transaction into exactly one bucket with no silent drops", async () => {
    const txns = [
      makeTxn({ txn_guid: "txn-new" }),
      makeTxn({ txn_guid: "txn-unmapped", splits: [{ split_guid: "s1", account_guid: "unknown-fund", memo: "", value_cents: -100 }, { split_guid: "s2", account_guid: EXPENSE_GUID, memo: "", value_cents: 100 }] }),
      makeTxn({ txn_guid: "txn-multi-expense", splits: [
        { split_guid: "s1", account_guid: FUNDING_GUID, memo: "", value_cents: -500 },
        { split_guid: "s2", account_guid: EXPENSE_GUID, memo: "", value_cents: 300 },
        { split_guid: "s3", account_guid: EXPENSE_GUID_2, memo: "", value_cents: 200 },
      ] }),
    ];

    await t.repos.categories.insert({ name: "Other", gnucash_guid: EXPENSE_GUID_2 });

    const list: GnucashTransactionList = {
      transactions: txns,
      errors: [{ txn_guid: "err-1", post_date: null, description: null, reason: "bad txn" }],
    };

    const plan = await planGnucashImport(t.repos, list, defaultOptions());

    const txnGuids = new Set(txns.map((txn) => txn.txn_guid));
    const bucketGuids = [
      ...plan.new.map((row) => row.txnGuid),
      ...plan.unchanged.map((row) => row.txnGuid),
      ...plan.updated.map((row) => row.txnGuid),
      ...plan.mergeCandidates.map((row) => row.txnGuid),
      ...plan.unmappable.map((row) => row.txnGuid),
    ];

    expect(new Set(bucketGuids).size).toBe(bucketGuids.length);
    expect(new Set(bucketGuids)).toEqual(txnGuids);
    expect(plan.unreadable).toHaveLength(1);
    expect(plan.unreadable[0].error).toEqual(list.errors[0]);
  });

  describe("new bucket", () => {
    it("proposes payment fields from mapped funding and expense splits", async () => {
      const txn = makeTxn({ txn_guid: "txn-new-fields", description: "Power Co", post_date: "2026-04-01" });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());

      expect(plan.new).toHaveLength(1);
      expect(plan.new[0]).toMatchObject({
        txnGuid: "txn-new-fields",
        date: "2026-04-01",
        amount_cents: 4858,
        memo: "Power Co",
        accountId,
        categoryId,
        payeeId,
      });
    });

    it("uses expense split value_cents without abs on funding split", async () => {
      const txn = makeTxn({
        txn_guid: "txn-signed",
        splits: [
          { split_guid: "f", account_guid: FUNDING_GUID, memo: "", value_cents: -1067391 },
          { split_guid: "e", account_guid: EXPENSE_GUID, memo: "", value_cents: 1067391 },
        ],
      });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.new[0].amount_cents).toBe(1067391);
    });
  });

  describe("unchanged bucket", () => {
    it("detects matching gnucash-linked payment", async () => {
      const txn = makeTxn({ txn_guid: "txn-same" });
      await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: txn.post_date,
        amount_cents: 4858,
        memo: txn.description,
        source: "gnucash",
        external_ref: txn.txn_guid,
      });

      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.new).toHaveLength(0);
      expect(plan.updated).toHaveLength(0);
      expect(plan.unchanged).toHaveLength(1);
      expect(plan.unchanged[0].txnGuid).toBe(txn.txn_guid);
    });
  });

  describe("updated bucket", () => {
    it("flags field-level diffs when gnucash payment differs", async () => {
      const txn = makeTxn({ txn_guid: "txn-changed", post_date: "2026-05-01", description: "New memo" });
      const payment = await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: "2026-04-30",
        amount_cents: 4858,
        memo: "Old memo",
        source: "gnucash",
        external_ref: txn.txn_guid,
      });

      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.updated).toHaveLength(1);
      expect(plan.updated[0]).toMatchObject({ txnGuid: txn.txn_guid, paymentId: payment.id });
      expect(plan.updated[0].diffs).toEqual(
        expect.arrayContaining([
          { field: "date", existing: "2026-04-30", incoming: "2026-05-01" },
          { field: "memo", existing: "Old memo", incoming: "New memo" },
        ]),
      );
    });

    it("does not apply updates without approval", async () => {
      const txn = makeTxn({ txn_guid: "txn-no-auto-update", description: "Changed" });
      const payment = await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: txn.post_date,
        amount_cents: 4858,
        memo: "Original",
        source: "gnucash",
        external_ref: txn.txn_guid,
      });

      const list = { transactions: [txn], errors: [] };
      const plan = await planGnucashImport(t.repos, list, defaultOptions());
      const result = await commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: [],
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
        list,
        options: defaultOptions(),
      });

      const after = await t.repos.payments.get(payment.id);
      expect(after?.memo).toBe("Original");
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.inserted).toBe(0);
      expect(result.merged).toBe(0);
    });
  });

  describe("merge-candidate bucket", () => {
    it("matches manual payments within ±3 calendar days", async () => {
      const postDate = "2026-06-10";
      const txn = makeTxn({ txn_guid: "txn-merge", post_date: postDate, description: "Vendor" });

      const inWindow = await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: addDays(postDate, 3),
        amount_cents: 4858,
        source: "manual",
      });
      await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: addDays(postDate, 4),
        amount_cents: 4858,
        source: "manual",
      });

      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.mergeCandidates).toEqual([{ txnGuid: txn.txn_guid, paymentId: inWindow.id }]);
    });

    it("prefers GUID match over merge candidate", async () => {
      const txn = makeTxn({ txn_guid: "txn-guid-wins" });
      await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: txn.post_date,
        amount_cents: 4858,
        memo: txn.description,
        source: "gnucash",
        external_ref: txn.txn_guid,
      });
      await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: txn.post_date,
        amount_cents: 4858,
        source: "manual",
      });

      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.unchanged).toHaveLength(1);
      expect(plan.mergeCandidates).toHaveLength(0);
    });

    it("does not auto-merge without approval", async () => {
      const txn = makeTxn({ txn_guid: "txn-no-auto-merge" });
      const manual = await t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: txn.post_date,
        amount_cents: 4858,
        source: "manual",
      });

      const list = { transactions: [txn], errors: [] };
      await planGnucashImport(t.repos, list, defaultOptions());
      await commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: [],
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
        list,
        options: defaultOptions(),
      });

      const after = await t.repos.payments.get(manual.id);
      expect(after?.source).toBe("manual");
      expect(after?.external_ref).toBeNull();
    });
  });

  describe("unmappable bucket", () => {
    it("surfaces unmapped funding account", async () => {
      const txn = makeTxn({
        txn_guid: "txn-no-funding",
        splits: [
          { split_guid: "s1", account_guid: "missing-fund", memo: "", value_cents: -100 },
          { split_guid: "s2", account_guid: EXPENSE_GUID, memo: "", value_cents: 100 },
        ],
      });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.unmappable[0].reason).toMatch(/unmapped funding/i);
    });

    it("surfaces unmapped expense category", async () => {
      const txn = makeTxn({
        txn_guid: "txn-no-category",
        splits: [
          { split_guid: "s1", account_guid: FUNDING_GUID, memo: "", value_cents: -100 },
          { split_guid: "s2", account_guid: "missing-expense", memo: "", value_cents: 100 },
        ],
      });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.unmappable[0].reason).toMatch(/unmapped.*category|expense/i);
    });

    it("lists each mapped expense split when multiple exist", async () => {
      await t.repos.categories.insert({ name: "Other", gnucash_guid: EXPENSE_GUID_2 });
      const txn = makeTxn({
        txn_guid: "txn-multi",
        splits: [
          { split_guid: "s1", account_guid: FUNDING_GUID, memo: "", value_cents: -500 },
          { split_guid: "s2", account_guid: EXPENSE_GUID, memo: "", value_cents: 300 },
          { split_guid: "s3", account_guid: EXPENSE_GUID_2, memo: "", value_cents: 200 },
        ],
      });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.unmappable[0].reason).toContain(EXPENSE_GUID);
      expect(plan.unmappable[0].reason).toContain(EXPENSE_GUID_2);
      expect(plan.unmappable[0].reason).toContain("300");
      expect(plan.unmappable[0].reason).toContain("200");
    });

    it("ignores unmappable GUIDs at commit time", async () => {
      const txn = makeTxn({
        txn_guid: "txn-unmappable-commit",
        splits: [
          { split_guid: "s1", account_guid: "missing", memo: "", value_cents: -100 },
          { split_guid: "s2", account_guid: EXPENSE_GUID, memo: "", value_cents: 100 },
        ],
      });
      const before = await tableCount("transactions");
      const list = { transactions: [txn], errors: [] };
      await commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: [txn.txn_guid],
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
        list,
        options: defaultOptions(),
        confirmedPayeeIds: { [txn.txn_guid]: payeeId },
      });
      expect(await tableCount("transactions")).toBe(before);
    });
  });

  describe("unreadable bucket", () => {
    it("passes reader errors through unchanged", async () => {
      const errors = [
        {
          txn_guid: "bad-txn",
          post_date: "2026-01-01",
          description: "Broken",
          reason: "missing splits",
        },
      ];
      const plan = await planGnucashImport(t.repos, { transactions: [], errors }, defaultOptions());
      expect(plan.unreadable[0].error).toEqual(errors[0]);
    });

    it("does not commit unreadable entries", async () => {
      const before = await tableCount("transactions");
      const list: GnucashTransactionList = {
        transactions: [],
        errors: [{ txn_guid: "bad", post_date: null, description: null, reason: "nope" }],
      };
      await commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: ["bad"],
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
        list,
        options: defaultOptions(),
      });
      expect(await tableCount("transactions")).toBe(before);
    });
  });

  describe("payee resolution", () => {
    it("matches existing payee via normalization", async () => {
      const description = "pay @ Vendor w/ 1234";
      const normalized = normalizePayeeLabel(description).payee;
      const vendor = await t.repos.payees.insert({ name: normalized });

      const txn = makeTxn({ txn_guid: "txn-payee-match", description });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.new[0].payeeId).toBe(vendor.id);
      expect(plan.new[0].payeeCreateSuggestion).toBeUndefined();
    });

    it("suggests payee creation without inserting during plan", async () => {
      const before = await tableCount("payees");
      const txn = makeTxn({ txn_guid: "txn-new-payee", description: "pay @ New Vendor w/ 9999" });
      const plan = await planGnucashImport(t.repos, { transactions: [txn], errors: [] }, defaultOptions());
      expect(plan.new[0].payeeCreateSuggestion).toBe("New Vendor");
      expect(plan.new[0].payeeId).toBeUndefined();
      expect(await tableCount("payees")).toBe(before);
    });

    it("does not auto-create payees on commit", async () => {
      const txn = makeTxn({ txn_guid: "txn-no-payee-create", description: "pay @ Brand New w/ 1" });
      const list = { transactions: [txn], errors: [] };
      const before = await tableCount("payees");
      await commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: [txn.txn_guid],
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
        list,
        options: defaultOptions(),
      });
      expect(await tableCount("payees")).toBe(before);
      expect(await tableCount("transactions")).toBe(0);
    });
  });
});

describe("commitGnucashImport", () => {
  let t: TestDb;
  let accountId: number;
  let categoryId: number;
  let payeeId: number;

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

  async function tableCount(name: string): Promise<number> {
    const rows = await t.db.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`);
    return rows[0].count;
  }

  /** Splits of one transaction as `[account_id, amount_cents]`, ordered by split id. */
  async function splitsOf(transactionId: number): Promise<Array<[number, number]>> {
    const rows = await t.db.select<{ account_id: number; amount_cents: number }>(
      "SELECT account_id, amount_cents FROM splits WHERE transaction_id = ? ORDER BY id",
      [transactionId],
    );
    return rows.map((row) => [row.account_id, row.amount_cents]);
  }

  it("requires list context on approval", async () => {
    await expect(
      commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: [],
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
      }),
    ).rejects.toThrow(/list/i);
  });

  it("inserts approved gnucash payments with external_ref", async () => {
    const txn = makeTxn({ txn_guid: "txn-commit-new" });
    const list = { transactions: [txn], errors: [] };
    const result = await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [txn.txn_guid],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txn.txn_guid]: payeeId },
    });

    expect(result.inserted).toBe(1);
    const [payment] = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(payment).toMatchObject({
      source: "gnucash",
      external_ref: txn.txn_guid,
      amount_cents: 4858,
      date: txn.post_date,
      memo: txn.description,
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
    });
    // Balanced two-split shape: expense +amount, funding -amount.
    expect(await splitsOf(payment.id)).toEqual([
      [categoryId, 4858],
      [accountId, -4858],
    ]);
  });

  it("links approved manual payments on merge", async () => {
    const txn = makeTxn({ txn_guid: "txn-commit-merge" });
    const manual = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: txn.post_date,
      amount_cents: 4858,
      source: "manual",
    });
    const list = { transactions: [txn], errors: [] };

    const result = await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [txn.txn_guid],
      list,
      options: defaultOptions(),
    });

    expect(result.merged).toBe(1);
    const after = await t.repos.payments.get(manual.id);
    expect(after?.source).toBe("gnucash");
    expect(after?.external_ref).toBe(txn.txn_guid);
  });

  it("applies approved field updates", async () => {
    const txn = makeTxn({ txn_guid: "txn-commit-update", post_date: "2026-03-15", description: "Updated memo" });
    txn.splits = [
      { split_guid: "f", account_guid: FUNDING_GUID, memo: "", value_cents: -9999 },
      { split_guid: "e", account_guid: EXPENSE_GUID, memo: "", value_cents: 9999 },
    ];
    const payment = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-14",
      amount_cents: 4858,
      memo: "Old",
      source: "gnucash",
      external_ref: txn.txn_guid,
    });
    const list = { transactions: [txn], errors: [] };

    await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [],
      approvedUpdateTxnGuids: [txn.txn_guid],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
    });

    const after = await t.repos.payments.get(payment.id);
    expect(after?.amount_cents).toBe(9999);
    expect(after?.memo).toBe("Updated memo");
    // Both splits follow the amount update and the transaction still balances.
    expect(await splitsOf(payment.id)).toEqual([
      [categoryId, 9999],
      [accountId, -9999],
    ]);
  });

  it("lists a GUID whose transaction was edited out of payment shape as unchanged and re-commits nothing", async () => {
    const txn = makeTxn({ txn_guid: "txn-edited-then-reimported" });
    const list = { transactions: [txn], errors: [] };
    const approval = {
      approvedNewTxnGuids: [txn.txn_guid],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txn.txn_guid]: payeeId },
    };
    await commitGnucashImport(t.db, t.repos, approval);
    const [imported] = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });

    // Edit into three splits: no longer payment-shaped, still source gnucash.
    await t.db.execute("UPDATE splits SET amount_cents = 3000 WHERE transaction_id = ? AND amount_cents = 4858", [imported.id]);
    await t.db.execute("INSERT INTO splits (transaction_id, account_id, amount_cents) VALUES (?, ?, 1858)", [imported.id, categoryId]);
    expect((await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" })).length).toBe(0);

    const plan = await planGnucashImport(t.repos, list, defaultOptions());
    expect(plan.unchanged).toEqual([{ txnGuid: txn.txn_guid, paymentId: imported.id }]);
    expect(plan.new).toEqual([]);
    expect(plan.mergeCandidates).toEqual([]);

    const txnsBefore = await tableCount("transactions");
    const splitsBefore = await tableCount("splits");
    await expect(commitGnucashImport(t.db, t.repos, approval)).resolves.toMatchObject({
      inserted: 0,
      merged: 0,
    });
    expect(await tableCount("transactions")).toBe(txnsBefore);
    expect(await tableCount("splits")).toBe(splitsBefore);
  });

  it("plans a re-dated (out of window) GnuCash payment as updated, never new or merge, and does not duplicate it", async () => {
    const txn = makeTxn({ txn_guid: "txn-redated", post_date: "2026-03-15" });
    const list = { transactions: [txn], errors: [] };
    const approval = {
      approvedNewTxnGuids: [txn.txn_guid],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txn.txn_guid]: payeeId },
    };
    await commitGnucashImport(t.db, t.repos, approval);
    const [imported] = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    // Re-date far outside the plan's +/-3 day window around 2026-03-15.
    await t.repos.payments.update(imported.id, { date: "2026-09-01" });

    const plan = await planGnucashImport(t.repos, list, defaultOptions());
    expect(plan.new).toEqual([]);
    expect(plan.mergeCandidates).toEqual([]);
    expect(plan.updated).toEqual([
      {
        txnGuid: txn.txn_guid,
        paymentId: imported.id,
        diffs: [{ field: "date", existing: "2026-09-01", incoming: "2026-03-15" }],
      },
    ]);

    await commitGnucashImport(t.db, t.repos, approval);
    const refs = await t.db.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM transactions WHERE external_ref = ?",
      [txn.txn_guid],
    );
    expect(refs[0].count).toBe(1);
  });

  describe("multi-match tie-break (payment-shaped wins, then lowest id)", () => {
    const GUID = "txn-two-matches";

    async function post(shaped: boolean, date: string): Promise<number> {
      const splits = shaped
        ? [
            { account_id: categoryId, amount_cents: 4858 },
            { account_id: accountId, amount_cents: -4858 },
          ]
        : [
            { account_id: categoryId, amount_cents: 3000 },
            { account_id: categoryId, amount_cents: 1858 },
            { account_id: accountId, amount_cents: -4858 },
          ];
      const stored = await postTransaction(t.repos.ledger, {
        date,
        payee_id: payeeId,
        memo: "Power Co",
        source: "gnucash",
        external_ref: GUID,
        splits,
      });
      return stored.id;
    }

    it("prefers the lower-id payment-shaped transaction over a higher-id edited one", async () => {
      const lower = await post(true, "2026-03-14");
      const higher = await post(false, "2026-03-15");
      expect(higher).toBeGreaterThan(lower);
      const plan = await planGnucashImport(
        t.repos,
        { transactions: [makeTxn({ txn_guid: GUID, post_date: "2026-03-15" })], errors: [] },
        defaultOptions(),
      );
      expect(plan.unchanged).toEqual([]);
      expect(plan.new).toEqual([]);
      expect(plan.mergeCandidates).toEqual([]);
      expect(plan.updated).toEqual([
        {
          txnGuid: GUID,
          paymentId: lower,
          diffs: [{ field: "date", existing: "2026-03-14", incoming: "2026-03-15" }],
        },
      ]);
    });

    it("prefers a higher-id payment-shaped transaction over a lower-id edited one", async () => {
      const lower = await post(false, "2026-03-15");
      const higher = await post(true, "2026-03-14");
      expect(higher).toBeGreaterThan(lower);
      const plan = await planGnucashImport(
        t.repos,
        { transactions: [makeTxn({ txn_guid: GUID, post_date: "2026-03-15" })], errors: [] },
        defaultOptions(),
      );
      expect(plan.unchanged).toEqual([]);
      expect(plan.new).toEqual([]);
      expect(plan.mergeCandidates).toEqual([]);
      expect(plan.updated).toEqual([
        {
          txnGuid: GUID,
          paymentId: higher,
          diffs: [{ field: "date", existing: "2026-03-14", incoming: "2026-03-15" }],
        },
      ]);
    });
  });

  it("reconciles skipped counts for partial approval", async () => {
    const txnNew = makeTxn({ txn_guid: "txn-partial-new" });
    const txnSkip = makeTxn({ txn_guid: "txn-partial-skip", post_date: "2026-07-01" });
    const list = { transactions: [txnNew, txnSkip], errors: [] };
    const plan = await planGnucashImport(t.repos, list, defaultOptions());

    const result = await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [txnNew.txn_guid],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txnNew.txn_guid]: payeeId },
    });

    expect(result.inserted + result.merged + result.skipped).toBe(
      plan.new.length + plan.updated.length + plan.mergeCandidates.length,
    );
  });

  it("uses exactly one batch call for multi-row commit", async () => {
    const txns = [
      makeTxn({ txn_guid: "txn-batch-1", post_date: "2026-08-01" }),
      makeTxn({ txn_guid: "txn-batch-2", post_date: "2026-08-02" }),
    ];
    const list = { transactions: txns, errors: [] };
    const before = t.calls.length;

    await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: txns.map((txn) => txn.txn_guid),
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: Object.fromEntries(txns.map((txn) => [txn.txn_guid, payeeId])),
    });

    const during = t.calls.slice(before);
    expect(during.filter((call) => call.kind === "batch")).toHaveLength(1);
  });

  it("rolls back all writes when a batch statement fails", async () => {
    const txns = [
      makeTxn({ txn_guid: "txn-rollback-1" }),
      makeTxn({ txn_guid: "txn-rollback-2", post_date: "2026-09-02" }),
    ];
    const list = { transactions: txns, errors: [] };
    const before = await tableCount("transactions");

    await expect(
      commitGnucashImport(t.db, t.repos, {
        approvedNewTxnGuids: txns.map((txn) => txn.txn_guid),
        approvedUpdateTxnGuids: [],
        approvedMergeTxnGuids: [],
        list,
        options: defaultOptions(),
        confirmedPayeeIds: Object.fromEntries(txns.map((txn) => [txn.txn_guid, payeeId])),
        fail_after_insert_count: 1,
      }),
    ).rejects.toThrow(/batch statement|injected failure/i);

    expect(await tableCount("transactions")).toBe(before);
  });

  it("re-import is a no-op after successful commit", async () => {
    const txn = makeTxn({ txn_guid: "txn-reimport" });
    const list = { transactions: [txn], errors: [] };
    const approval = {
      approvedNewTxnGuids: [txn.txn_guid],
      approvedUpdateTxnGuids: [] as string[],
      approvedMergeTxnGuids: [] as string[],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txn.txn_guid]: payeeId },
    };

    await commitGnucashImport(t.db, t.repos, approval);
    const secondPlan = await planGnucashImport(t.repos, list, defaultOptions());
    expect(secondPlan.new).toHaveLength(0);
    expect(secondPlan.updated).toHaveLength(0);
    expect(secondPlan.mergeCandidates).toHaveLength(0);
    expect(secondPlan.unchanged).toHaveLength(1);

    const before = await tableCount("transactions");
    const secondCommit = await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
    });
    expect(secondCommit.inserted).toBe(0);
    expect(secondCommit.merged).toBe(0);
    expect(await tableCount("transactions")).toBe(before);
  });

  it("round-trips $10,673.91 exactly", async () => {
    const txn = makeTxn({
      txn_guid: "txn-large",
      splits: [
        { split_guid: "f", account_guid: FUNDING_GUID, memo: "", value_cents: -1067391 },
        { split_guid: "e", account_guid: EXPENSE_GUID, memo: "", value_cents: 1067391 },
      ],
    });
    const list = { transactions: [txn], errors: [] };
    await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [txn.txn_guid],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txn.txn_guid]: payeeId },
    });
    const [payment] = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(payment.amount_cents).toBe(1067391);
  });

  it("round-trips $0.01 exactly", async () => {
    const txn = makeTxn({
      txn_guid: "txn-penny",
      splits: [
        { split_guid: "f", account_guid: FUNDING_GUID, memo: "", value_cents: -1 },
        { split_guid: "e", account_guid: EXPENSE_GUID, memo: "", value_cents: 1 },
      ],
    });
    const list = { transactions: [txn], errors: [] };
    await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [txn.txn_guid],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list,
      options: defaultOptions(),
      confirmedPayeeIds: { [txn.txn_guid]: payeeId },
    });
    const [payment] = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(payment.amount_cents).toBe(1);
  });
});
