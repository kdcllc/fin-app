import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForeignKeyViolationError } from "../../src/core";
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
});
