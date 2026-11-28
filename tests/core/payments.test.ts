import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ForeignKeyViolationError,
  ValidationError,
  createTransfer,
  postTransaction,
  getBillPayGridForYear,
  buildQuickAddDraft,
  createManualPayment,
  updateManualPayment,
  deletePayment,
} from "../../src/core";
import type { Payment } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

describe("payments repository", () => {
  let t: TestDb;
  let accountId: number;
  let payeeId: number;
  let categoryId: number;

  beforeEach(async () => {
    t = openTestDb();
    accountId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
    payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
    categoryId = (await t.repos.categories.insert({ name: "Utilities" })).id;
  });
  afterEach(() => t.close());

  function pay(date: string, amount_cents: number, extra: Partial<Payment> = {}) {
    return t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date,
      amount_cents,
      source: "manual",
      ...extra,
    });
  }

  it("round-trips insert with exact integer cents", async () => {
    // 4005 cents = $40.05 — a value that would wobble as a float (40.05 * 100 = 4004.99…).
    const payment = await pay("2026-02-15", 4005, { memo: "Feb bill" });

    expect(payment).toEqual({
      id: payment.id,
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-15",
      amount_cents: 4005,
      memo: "Feb bill",
      source: "manual",
      external_ref: null,
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
    expect(Number.isInteger(payment.amount_cents)).toBe(true);

    const [listed] = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(listed.amount_cents).toBe(4005);
  });

  it("filters by inclusive date window", async () => {
    const jan = await pay("2026-01-31", 1000);
    const febFirst = await pay("2026-02-01", 2000);
    const febLast = await pay("2026-02-28", 3000);
    const mar = await pay("2026-03-01", 4000);

    const february = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(february.map((p) => p.id)).toEqual([febFirst.id, febLast.id]); // bounds inclusive

    const all = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(all.map((p) => p.id)).toEqual([jan.id, febFirst.id, febLast.id, mar.id]);
    expect(all.reduce((sum, p) => sum + p.amount_cents, 0)).toBe(10000); // exact cents
  });

  it("filters by payee, account, and category", async () => {
    const otherPayee = await t.repos.payees.insert({ name: "Water Co" });
    const otherAccount = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });

    const mine = await pay("2026-02-10", 1500);
    await pay("2026-02-11", 2500, { payee_id: otherPayee.id, category_id: null });
    await pay("2026-02-12", 3500, { account_id: otherAccount.id });

    const window = { from: "2026-02-01", to: "2026-02-28" };
    expect(await t.repos.payments.list({ ...window, payeeId })).toHaveLength(2);
    expect(await t.repos.payments.list({ ...window, accountId: otherAccount.id })).toHaveLength(1);
    expect(
      (await t.repos.payments.list({ ...window, payeeId, accountId, categoryId })).map((p) => p.id),
    ).toEqual([mine.id]);
  });

  it("updates and deletes", async () => {
    const payment = await pay("2026-02-15", 4005);
    const updated = await t.repos.payments.update(payment.id, {
      amount_cents: 4105,
      memo: "corrected",
    });
    expect(updated).toEqual({ ...payment, amount_cents: 4105, memo: "corrected" });

    expect(await t.repos.payments.delete(payment.id)).toBe(true);
    expect(await t.repos.payments.get(payment.id)).toBeNull();
    expect(await t.repos.payments.delete(payment.id)).toBe(false);
  });

  it("keeps history intact when the payee is archived", async () => {
    const payment = await pay("2026-02-15", 4005);
    await t.repos.payees.archive(payeeId);

    const listed = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(listed.map((p) => p.id)).toEqual([payment.id]);
    expect((await t.repos.payees.get(payeeId))?.archived).toBe(true);
  });

  it("surfaces dangling foreign keys as ForeignKeyViolationError", async () => {
    await expect(pay("2026-02-15", 1000, { payee_id: 9999 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
    await expect(pay("2026-02-15", 1000, { account_id: 9999 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
  });

  it("fetches all xlsx payments matching any business-key tuple in one query pass", async () => {
    const collision = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-15",
      amount_cents: 4058,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 12,
      source_col: 2,
      occurrence_index: 1,
    });
    const exact = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 20,
      source_col: 4,
      occurrence_index: 1,
    });
    // Same business fields but manual source — must NOT participate in xlsx dedup.
    await pay("2026-02-15", 4058);

    const before = t.calls.length;
    const matches = await t.repos.payments.listXlsxByBusinessKeys([
      { payee_id: payeeId, account_id: accountId, date: "2026-02-15", amount_cents: 4058 },
      { payee_id: payeeId, account_id: accountId, date: "2026-03-01", amount_cents: 5000 },
      // Duplicate tuple and a miss — dedup'd and harmless.
      { payee_id: payeeId, account_id: accountId, date: "2026-03-01", amount_cents: 5000 },
      { payee_id: payeeId, account_id: accountId, date: "2026-12-31", amount_cents: 1 },
    ]);

    expect(matches.map((p) => p.id)).toEqual([collision.id, exact.id]);
    expect(t.calls.slice(before).filter((call) => call.kind === "select")).toHaveLength(1);
  });

  it("chunks large business-key lists and returns an empty result for no keys", async () => {
    const seeded = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-06-15",
      amount_cents: 7777,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 30,
      source_col: 7,
      occurrence_index: 1,
    });

    // 250 unique keys; only the last one matches the seeded payment.
    const keys = Array.from({ length: 249 }, (_, index) => ({
      payee_id: payeeId,
      account_id: accountId,
      date: "2026-06-01",
      amount_cents: 100000 + index,
    }));
    keys.push({ payee_id: payeeId, account_id: accountId, date: "2026-06-15", amount_cents: 7777 });

    const before = t.calls.length;
    const matches = await t.repos.payments.listXlsxByBusinessKeys(keys);
    expect(matches.map((p) => p.id)).toEqual([seeded.id]);
    expect(t.calls.slice(before).filter((call) => call.kind === "select")).toHaveLength(3);

    const beforeEmpty = t.calls.length;
    expect(await t.repos.payments.listXlsxByBusinessKeys([])).toEqual([]);
    expect(t.calls.slice(beforeEmpty)).toHaveLength(0);
  });

  it("rejects invalid xlsx writes before hitting sqlite", async () => {
    await expect(
      t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: "2026-03-01",
        amount_cents: 5000,
        source: "xlsx",
        source_sheet: "2026",
        source_row: 20,
        source_col: 4,
        occurrence_index: 0,
      }),
    ).rejects.toThrow("occurrence_index must be >= 1");

    const seeded = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 20,
      source_col: 4,
      occurrence_index: 1,
    });

    await expect(t.repos.payments.update(seeded.id, { source_col: null })).rejects.toThrow(
      "requires source coordinates",
    );
  });

  it("builds a quick-add draft with today date and payee defaults", async () => {
    const defaultAccount = await t.repos.accounts.insert({ name: "Card", kind: "credit" });
    const defaultCategory = await t.repos.categories.insert({ name: "Bills" });
    const defaultedPayee = await t.repos.payees.insert({
      name: "Internet Co",
      default_account_id: defaultAccount.id,
      default_category_id: defaultCategory.id,
    });

    const draft = await buildQuickAddDraft(
      t.repos,
      defaultedPayee.id,
      new Date("2026-04-12T08:30:00Z"),
    );

    expect(draft.payee_id).toBe(defaultedPayee.id);
    expect(draft.account_id).toBe(defaultAccount.id);
    expect(draft.category_id).toBe(defaultCategory.id);
    expect(draft.date).toBe("2026-04-12");
    expect(draft.amount_cents).toBeNull();
    expect(draft.memo).toBe("");
  });

  it("persists payment overrides without mutating payee defaults", async () => {
    const defaultedPayee = await t.repos.payees.insert({
      name: "Water Co",
      default_account_id: accountId,
      default_category_id: categoryId,
    });
    const overrideAccount = await t.repos.accounts.insert({ name: "Rewards Card", kind: "credit" });
    const overrideCategory = await t.repos.categories.insert({ name: "Household" });

    const created = await createManualPayment(t.repos, {
      payee_id: defaultedPayee.id,
      account_id: overrideAccount.id,
      category_id: overrideCategory.id,
      date: "2026-04-13",
      amount_cents: 12345,
      memo: "override defaults",
    });

    expect(created.account_id).toBe(overrideAccount.id);
    expect(created.category_id).toBe(overrideCategory.id);

    const payeeAfter = await t.repos.payees.get(defaultedPayee.id);
    expect(payeeAfter?.default_account_id).toBe(accountId);
    expect(payeeAfter?.default_category_id).toBe(categoryId);
  });

  it("validates payee/date/amount and edit-delete flow through core payment entry API", async () => {
    await expect(
      createManualPayment(t.repos, {
        payee_id: 0,
        account_id: accountId,
        category_id: categoryId,
        date: "2026-04-13",
        amount_cents: 1000,
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      createManualPayment(t.repos, {
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: "2026/04/13",
        amount_cents: 1000,
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      createManualPayment(t.repos, {
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: "2026-04-13",
        amount_cents: 10.25,
      }),
    ).rejects.toThrow(ValidationError);

    const created = await createManualPayment(t.repos, {
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-04-13",
      amount_cents: 2500,
      memo: "before edit",
    });

    const updated = await updateManualPayment(t.repos, created.id, {
      payee_id: payeeId,
      account_id: accountId,
      category_id: null,
      date: "2026-04-14",
      amount_cents: 2600,
      memo: "after edit",
    });
    expect(updated).not.toBeNull();
    expect(updated?.date).toBe("2026-04-14");
    expect(updated?.amount_cents).toBe(2600);
    expect(updated?.category_id).toBeNull();

    expect(await deletePayment(t.repos, created.id)).toBe(true);
    expect(await deletePayment(t.repos, created.id)).toBe(false);
  });

  it("builds deterministic payee x month placement with row and column totals", async () => {
    const waterPayee = await t.repos.payees.insert({ name: "Water Co" });
    const emptyPayee = await t.repos.payees.insert({ name: "Trash Co" });

    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-01-10",
      amount_cents: 4005,
      memo: "jan one",
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-01-22",
      amount_cents: 1000,
      memo: "jan two",
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-05",
      amount_cents: 2500,
      memo: "feb",
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: waterPayee.id,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-14",
      amount_cents: 5000,
      memo: "water",
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: waterPayee.id,
      account_id: accountId,
      category_id: categoryId,
      date: "2025-12-31",
      amount_cents: 777,
      memo: "outside year",
      source: "manual",
    });

    const grid = await getBillPayGridForYear(t.repos, 2026);

    expect(grid.year).toBe(2026);
    expect(grid.rows.map((row) => row.payee_name)).toEqual(["Power Co", "Trash Co", "Water Co"]);

    const powerRow = grid.rows.find((row) => row.payee_id === payeeId);
    expect(powerRow).toBeTruthy();
    expect(powerRow?.row_total_cents).toBe(7505);
    expect(powerRow?.cells[0].payments.map((payment) => payment.date)).toEqual([
      "2026-01-10",
      "2026-01-22",
    ]);
    expect(powerRow?.cells[1].payments.map((payment) => payment.amount_cents)).toEqual([2500]);

    const emptyRow = grid.rows.find((row) => row.payee_id === emptyPayee.id);
    expect(emptyRow).toBeTruthy();
    expect(emptyRow?.row_total_cents).toBe(0);
    expect(
      emptyRow?.cells.every((cell) => cell.total_cents === 0 && cell.payments.length === 0),
    ).toBe(true);

    const waterRow = grid.rows.find((row) => row.payee_id === waterPayee.id);
    expect(waterRow).toBeTruthy();
    expect(waterRow?.row_total_cents).toBe(5000);
    expect(waterRow?.cells[1].payments.map((payment) => payment.date)).toEqual(["2026-02-14"]);

    expect(grid.month_totals[0].total_cents).toBe(5005);
    expect(grid.month_totals[1].total_cents).toBe(7500);
    expect(grid.month_totals.slice(2).every((month) => month.total_cents === 0)).toBe(true);
    expect(grid.grand_total_cents).toBe(12505);
  });

  it("keeps archived payees in the grid when they have in-year history", async () => {
    const archived = await t.repos.payees.insert({ name: "Archived Payee" });
    await t.repos.payments.insert({
      payee_id: archived.id,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 999,
      source: "manual",
    });
    await t.repos.payees.archive(archived.id);

    const grid = await getBillPayGridForYear(t.repos, 2026);
    const row = grid.rows.find((candidate) => candidate.payee_id === archived.id);

    expect(row).toBeTruthy();
    expect(row?.payee_archived).toBe(true);
    expect(row?.row_total_cents).toBe(999);
    expect(row?.cells[2].payments).toHaveLength(1);
  });

  it("stores a payment as a balanced two-split transaction and maps null category to uncategorized", async () => {
    const payment = await pay("2026-02-15", 4005, { category_id: null });
    expect(payment.category_id).toBeNull();

    const stored = await t.repos.ledger.getTransaction(payment.id);
    const uncategorized = (await t.repos.ledger.getSystemAccount("uncategorized"))!;
    expect(stored?.splits.map((s) => [s.account_id, s.amount_cents])).toEqual([
      [uncategorized.id, 4005],
      [accountId, -4005],
    ]);
    expect(stored?.splits.reduce((sum, s) => sum + s.amount_cents, 0)).toBe(0);

    const withCategory = await pay("2026-02-16", 100);
    const storedCat = await t.repos.ledger.getTransaction(withCategory.id);
    expect(storedCat?.splits.map((s) => [s.account_id, s.amount_cents])).toEqual([
      [categoryId, 100],
      [accountId, -100],
    ]);
  });

  it("never lists or gets multi-split transactions, transfers or payee-less transactions", async () => {
    const payment = await pay("2026-02-15", 1000);
    const other = await t.repos.accounts.insert({ name: "Savings", kind: "savings" });
    const transfer = await createTransfer(t.repos.ledger, {
      date: "2026-02-15",
      fromAccountId: accountId,
      toAccountId: other.id,
      amount_cents: 500,
      payee_id: payeeId,
    });
    const category2 = await t.repos.categories.insert({ name: "Other Cat" });
    const multi = await postTransaction(t.repos.ledger, {
      date: "2026-02-15",
      payee_id: payeeId,
      splits: [
        { account_id: categoryId, amount_cents: 600 },
        { account_id: category2.id, amount_cents: 400 },
        { account_id: accountId, amount_cents: -1000 },
      ],
    });
    const noPayee = await postTransaction(t.repos.ledger, {
      date: "2026-02-15",
      splits: [
        { account_id: categoryId, amount_cents: 50 },
        { account_id: accountId, amount_cents: -50 },
      ],
    });

    const listed = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(listed.map((p) => p.id)).toEqual([payment.id]);
    for (const hidden of [transfer.id, multi.id, noPayee.id]) {
      expect(await t.repos.payments.get(hidden)).toBeNull();
      expect(await t.repos.payments.update(hidden, { amount_cents: 1 })).toBeNull();
      expect(await t.repos.payments.delete(hidden)).toBe(false);
      expect(await t.repos.ledger.getTransaction(hidden)).not.toBeNull();
    }
  });

  it("filters by category through the EXPENSE split account", async () => {
    const other = await t.repos.categories.insert({ name: "Other Cat" });
    const mine = await pay("2026-02-10", 1500);
    await pay("2026-02-11", 2500, { category_id: other.id });
    const window = { from: "2026-02-01", to: "2026-02-28" };
    expect((await t.repos.payments.list({ ...window, categoryId })).map((p) => p.id)).toEqual([
      mine.id,
    ]);
  });

  it("rejects wrong-kind accounts and categories with ValidationError", async () => {
    await expect(pay("2026-02-15", 1000, { account_id: categoryId })).rejects.toThrow(
      ValidationError,
    );
    await expect(pay("2026-02-15", 1000, { category_id: accountId })).rejects.toThrow(
      ValidationError,
    );
    await expect(pay("2026-02-15", 1000, { category_id: 9999 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
  });

  it("keeps xlsx import snapshot in sync on update and rolls back failed updates", async () => {
    const seeded = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 20,
      source_col: 4,
      occurrence_index: 1,
    });
    const other = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });
    await t.repos.payments.update(seeded.id, { amount_cents: 5100, account_id: other.id });

    const [snapshot] = await t.db.select<{
      import_account_id: number;
      import_amount_cents: number;
    }>("SELECT import_account_id, import_amount_cents FROM transactions WHERE id = ?", [seeded.id]);
    expect(snapshot).toEqual({ import_account_id: other.id, import_amount_cents: 5100 });

    const keyed = await t.repos.payments.listXlsxByBusinessKeys([
      { payee_id: payeeId, account_id: other.id, date: "2026-03-01", amount_cents: 5100 },
    ]);
    expect(keyed.map((p) => p.id)).toEqual([seeded.id]);

    await expect(
      t.repos.payments.update(seeded.id, { payee_id: 9999, amount_cents: 1 }),
    ).rejects.toThrow(ForeignKeyViolationError);
    expect((await t.repos.payments.get(seeded.id))?.amount_cents).toBe(5100);
  });

  it("clears provenance and the import snapshot when an xlsx payment becomes manual", async () => {
    const seeded = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 3,
      source_col: 4,
      occurrence_index: 1,
    });
    await t.repos.payments.update(seeded.id, {
      source: "manual",
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
    });
    const [row] = await t.db.select<Record<string, unknown>>(
      "SELECT source, source_sheet, source_row, source_col, occurrence_index, import_account_id, import_amount_cents FROM transactions WHERE id = ?",
      [seeded.id],
    );
    expect(row).toEqual({
      source: "manual",
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
      import_account_id: null,
      import_amount_cents: null,
    });
  });

  it("treats present-but-undefined patch keys as absent", async () => {
    const xlsx = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      memo: "keep me",
      source: "xlsx",
      external_ref: "ref-9",
      source_sheet: "2026",
      source_row: 3,
      source_col: 4,
      occurrence_index: 1,
    });
    const after = await t.repos.payments.update(xlsx.id, {
      memo: undefined,
      external_ref: undefined,
      source_sheet: undefined,
    });
    expect(after).toEqual(xlsx);
    expect(await t.repos.payments.get(xlsx.id)).toEqual(xlsx);

    const manual = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-02",
      amount_cents: 100,
      memo: "manual memo",
    });
    const kept = await t.repos.payments.update(manual.id, { memo: undefined });
    expect(kept?.memo).toBe("manual memo");
  });

  it("round-trips a zero-amount payment", async () => {
    const zero = await pay("2026-02-15", 0);
    expect(zero.amount_cents).toBe(0);
    expect((await t.repos.payments.get(zero.id))?.id).toBe(zero.id);
  });
});
