import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForeignKeyViolationError } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

describe("recurring bills repository", () => {
  let t: TestDb;
  let payeeId: number;

  beforeEach(async () => {
    t = openTestDb();
    payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
  });
  afterEach(() => t.close());

  it("round-trips insert and list with exact integer cents", async () => {
    const power = await t.repos.recurringBills.insert({
      payee_id: payeeId,
      frequency: "monthly",
      expected_amount_cents: 12345,
      due_day: 15,
    });
    const variable = await t.repos.recurringBills.insert({
      payee_id: payeeId,
      frequency: "quarterly",
      due_day: 1,
    });

    expect(power).toEqual({
      id: power.id,
      payee_id: payeeId,
      frequency: "monthly",
      expected_amount_cents: 12345,
      due_day: 15,
      anchor_month: 1,
      anchor_phase: 1,
      active: true, // schema default
    });
    expect(variable.expected_amount_cents).toBeNull();
    expect(await t.repos.recurringBills.list()).toEqual([variable, power]); // by due_day
  });

  it("gets, updates (including active), and filters active-only", async () => {
    const bill = await t.repos.recurringBills.insert({
      payee_id: payeeId,
      frequency: "annual",
      expected_amount_cents: 99900,
      due_day: 31,
    });
    expect(await t.repos.recurringBills.get(bill.id)).toEqual(bill);

    const deactivated = await t.repos.recurringBills.update(bill.id, {
      active: false,
      expected_amount_cents: 100000,
    });
    expect(deactivated).toEqual({ ...bill, active: false, expected_amount_cents: 100000 });

    expect(await t.repos.recurringBills.list({ activeOnly: true })).toEqual([]);
    expect(await t.repos.recurringBills.list()).toEqual([deactivated]);
  });

  it("deletes", async () => {
    const bill = await t.repos.recurringBills.insert({
      payee_id: payeeId,
      frequency: "monthly",
      due_day: 5,
    });
    expect(await t.repos.recurringBills.delete(bill.id)).toBe(true);
    expect(await t.repos.recurringBills.get(bill.id)).toBeNull();
    expect(await t.repos.recurringBills.delete(bill.id)).toBe(false);
  });

  it("surfaces a dangling payee_id as ForeignKeyViolationError", async () => {
    await expect(
      t.repos.recurringBills.insert({ payee_id: 9999, frequency: "monthly", due_day: 1 }),
    ).rejects.toThrow(ForeignKeyViolationError);
  });
});
