import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForeignKeyViolationError } from "../../src/core";
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
});
