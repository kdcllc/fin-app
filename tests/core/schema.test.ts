import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type TestDb } from "../support/test-db";

describe("test database schema", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("applies the real migration files, in order", async () => {
    const names = (
      await t.db.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "accounts",
        "categories",
        "payees",
        "payments",
        "recurring_bills",
        "import_log",
      ]),
    );

    // Index created by migration 0002 — proves incremental application.
    const indexes = await t.db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_recurring_bills_payee_id'",
    );
    expect(indexes).toHaveLength(1);
  });

  it("enforces foreign keys, like the app's sqlx connections", async () => {
    const [pragma] = await t.db.select<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(pragma.foreign_keys).toBe(1);
  });
});
