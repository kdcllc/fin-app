import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityInUseError, ForeignKeyViolationError, ValidationError } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

describe("categories repository", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("round-trips insert and list, including parent links", async () => {
    const utilities = await t.repos.categories.insert({ name: "Utilities" });
    const power = await t.repos.categories.insert({ name: "Power", parent_id: utilities.id });

    expect(utilities).toEqual({
      id: utilities.id,
      name: "Utilities",
      parent_id: null,
      gnucash_guid: null,
      archived: false,
    });
    expect(power.parent_id).toBe(utilities.id);
    expect(await t.repos.categories.list()).toEqual([power, utilities]); // by name
  });

  it("gets and updates by id", async () => {
    const created = await t.repos.categories.insert({ name: "Grocries" });
    const updated = await t.repos.categories.update(created.id, { name: "Groceries" });
    expect(updated).toEqual({ ...created, name: "Groceries" });
    expect(await t.repos.categories.get(9999)).toBeNull();
  });

  it("validates category name and parent relationships", async () => {
    await expect(t.repos.categories.insert({ name: "   " })).rejects.toThrow(ValidationError);

    const category = await t.repos.categories.insert({ name: "Root" });
    await expect(t.repos.categories.update(category.id, { name: "" })).rejects.toThrow(
      ValidationError,
    );
    await expect(t.repos.categories.update(category.id, { parent_id: category.id })).rejects.toThrow(
      ValidationError,
    );
  });

  it("archive hides from default list but keeps the row reachable", async () => {
    const category = await t.repos.categories.insert({ name: "Old Category" });
    expect(await t.repos.categories.archive(category.id)).toBe(true);

    expect(await t.repos.categories.list()).toEqual([]);
    expect(await t.repos.categories.list({ includeArchived: true })).toEqual([
      { ...category, archived: true },
    ]);
    expect(await t.repos.categories.get(category.id)).toEqual({ ...category, archived: true });
  });

  it("surfaces a dangling parent_id as ForeignKeyViolationError", async () => {
    await expect(t.repos.categories.insert({ name: "Orphan", parent_id: 777 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
  });

  it("blocks delete when payments reference the category and allows archive path", async () => {
    const payee = await t.repos.payees.insert({ name: "Power Co" });
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const category = await t.repos.categories.insert({ name: "Utilities" });

    await t.repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      category_id: category.id,
      date: "2026-03-12",
      amount_cents: 5500,
      source: "manual",
    });

    await expect(t.repos.categories.delete(category.id)).rejects.toThrow(EntityInUseError);
    expect(await t.repos.categories.archive(category.id)).toBe(true);
  });

  it("deletes an unreferenced category", async () => {
    const category = await t.repos.categories.insert({ name: "Temp" });
    expect(await t.repos.categories.delete(category.id)).toBe(true);
    expect(await t.repos.categories.get(category.id)).toBeNull();
    expect(await t.repos.categories.delete(category.id)).toBe(false);
  });
});
