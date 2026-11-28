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

  it("lists EXPENSE categories only: never roots, system accounts or funding accounts", async () => {
    const category = await t.repos.categories.insert({ name: "Utilities" });
    await t.repos.accounts.insert({ name: "Checking", kind: "checking" });

    const listed = await t.repos.categories.list({ includeArchived: true });
    expect(listed.map((c) => c.id)).toEqual([category.id]);

    const root = (await t.repos.ledger.getSystemAccount("root_expense"))!;
    const uncategorized = (await t.repos.ledger.getSystemAccount("uncategorized"))!;
    const funding = (await t.repos.accounts.list())[0];
    for (const id of [root.id, uncategorized.id, funding.id]) {
      expect(await t.repos.categories.get(id)).toBeNull();
    }
    // A category directly under the expense root reports parent_id null.
    expect(category.parent_id).toBeNull();
  });

  it("rejects a parent that exists but is not an expense category, and cycles", async () => {
    const funding = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    await expect(
      t.repos.categories.insert({ name: "Bad", parent_id: funding.id }),
    ).rejects.toThrow(ValidationError);
    const uncategorized = (await t.repos.ledger.getSystemAccount("uncategorized"))!;
    await expect(
      t.repos.categories.insert({ name: "Bad2", parent_id: uncategorized.id }),
    ).rejects.toThrow(ValidationError);

    const a = await t.repos.categories.insert({ name: "A" });
    const b = await t.repos.categories.insert({ name: "B", parent_id: a.id });
    await expect(t.repos.categories.update(a.id, { parent_id: b.id })).rejects.toThrow(
      ValidationError,
    );
    const moved = await t.repos.categories.update(b.id, { parent_id: null });
    expect(moved?.parent_id).toBeNull();
  });

  it("blocks delete when a child category or payee default references it", async () => {
    const parent = await t.repos.categories.insert({ name: "Parent" });
    await t.repos.categories.insert({ name: "Child", parent_id: parent.id });
    await expect(t.repos.categories.delete(parent.id)).rejects.toThrow(EntityInUseError);

    const used = await t.repos.categories.insert({ name: "Used" });
    await t.repos.payees.insert({ name: "Payee", default_category_id: used.id });
    await expect(t.repos.categories.delete(used.id)).rejects.toThrow(EntityInUseError);
  });

  it("deletes an unused migrated category and removes its legacy_category_map row", async () => {
    const legacy = openTestDb({ upToVersion: 8 });
    try {
      await legacy.db.execute("INSERT INTO categories (name) VALUES ('Legacy Cat')");
      legacy.applyRemainingMigrations();
      const [mapped] = await legacy.db.select<{ category_id: number; account_id: number }>(
        "SELECT category_id, account_id FROM legacy_category_map",
      );
      const category = await legacy.repos.categories.get(mapped.account_id);
      expect(category?.name).toBe("Legacy Cat");

      expect(await legacy.repos.categories.delete(mapped.account_id)).toBe(true);
      expect(await legacy.repos.categories.get(mapped.account_id)).toBeNull();
      expect(
        await legacy.db.select("SELECT * FROM legacy_category_map WHERE category_id = ?", [
          mapped.category_id,
        ]),
      ).toEqual([]);
    } finally {
      legacy.close();
    }
  });
});
