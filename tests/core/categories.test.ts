import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForeignKeyViolationError } from "../../src/core";
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

  it("surfaces a dangling parent_id as ForeignKeyViolationError", async () => {
    await expect(t.repos.categories.insert({ name: "Orphan", parent_id: 777 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
  });
});
