import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityInUseError, ForeignKeyViolationError, PayeeMergeError, ValidationError } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

describe("payees repository", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("round-trips insert and list with defaults", async () => {
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const category = await t.repos.categories.insert({ name: "Utilities" });

    const power = await t.repos.payees.insert({
      name: "Power Co",
      default_category_id: category.id,
      default_account_id: account.id,
      notes: "autopay on the 15th",
    });
    const bare = await t.repos.payees.insert({ name: "Barber" });

    expect(power).toEqual({
      id: power.id,
      name: "Power Co",
      default_category_id: category.id,
      default_account_id: account.id,
      notes: "autopay on the 15th",
      archived: false,
    });
    expect(bare.default_category_id).toBeNull();
    expect(await t.repos.payees.list()).toEqual([bare, power]); // by name
  });

  it("updates only the patched fields", async () => {
    const payee = await t.repos.payees.insert({ name: "Water Co" });
    const updated = await t.repos.payees.update(payee.id, { notes: "quarterly" });
    expect(updated).toEqual({ ...payee, notes: "quarterly" });
  });

  it("validates required payee name on insert and update", async () => {
    await expect(t.repos.payees.insert({ name: "   " })).rejects.toThrow(ValidationError);

    const payee = await t.repos.payees.insert({ name: "Phone" });
    await expect(t.repos.payees.update(payee.id, { name: "" })).rejects.toThrow(ValidationError);
  });

  it("archive hides from default list but keeps the row reachable", async () => {
    const payee = await t.repos.payees.insert({ name: "Old Gym" });
    expect(await t.repos.payees.archive(payee.id)).toBe(true);

    expect(await t.repos.payees.list()).toEqual([]);
    expect(await t.repos.payees.list({ includeArchived: true })).toEqual([
      { ...payee, archived: true },
    ]);
    expect(await t.repos.payees.get(payee.id)).toEqual({ ...payee, archived: true });
  });

  it("surfaces dangling default ids as ForeignKeyViolationError", async () => {
    await expect(
      t.repos.payees.insert({ name: "Ghost", default_category_id: 555 }),
    ).rejects.toThrow(ForeignKeyViolationError);
    await expect(t.repos.payees.insert({ name: "Ghost", default_account_id: 555 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
  });

  it("blocks delete when payments reference the payee and allows archive path", async () => {
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const payee = await t.repos.payees.insert({ name: "Power Co" });

    await t.repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      date: "2026-02-01",
      amount_cents: 4500,
      source: "manual",
    });

    await expect(t.repos.payees.delete(payee.id)).rejects.toThrow(EntityInUseError);
    expect(await t.repos.payees.archive(payee.id)).toBe(true);
  });

  it("deletes an unreferenced payee", async () => {
    const payee = await t.repos.payees.insert({ name: "One-time Vendor" });
    expect(await t.repos.payees.delete(payee.id)).toBe(true);
    expect(await t.repos.payees.get(payee.id)).toBeNull();
    expect(await t.repos.payees.delete(payee.id)).toBe(false);
  });

  it("merges payees by reassigning payments and archiving the source payee", async () => {
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const source = await t.repos.payees.insert({ name: "City Water" });
    const survivor = await t.repos.payees.insert({ name: "City Utilities" });

    const payment = await t.repos.payments.insert({
      payee_id: source.id,
      account_id: account.id,
      date: "2026-03-02",
      amount_cents: 4800,
      source: "manual",
    });

    const merge = await t.repos.payees.merge(survivor.id, source.id);
    expect(merge.reassignedPayments).toBe(1);

    const moved = await t.repos.payments.get(payment.id);
    expect(moved?.payee_id).toBe(survivor.id);
    expect((await t.repos.payees.get(source.id))?.archived).toBe(true);
    expect((await t.repos.payees.list()).map((row) => row.id)).toEqual([survivor.id]);
  });

  it("returns typed merge failures for invalid merge requests", async () => {
    const payee = await t.repos.payees.insert({ name: "Power" });
    await expect(t.repos.payees.merge(payee.id, payee.id)).rejects.toThrow(PayeeMergeError);
    await expect(t.repos.payees.merge(payee.id, 9999)).rejects.toThrow(PayeeMergeError);
  });
});
