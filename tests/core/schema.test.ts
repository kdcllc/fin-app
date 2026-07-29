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

    const importHashIndex = await t.db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_import_log_content_hash'",
    );
    expect(importHashIndex).toHaveLength(1);

    const xlsxIdentityIndex = await t.db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_payments_xlsx_identity'",
    );
    expect(xlsxIdentityIndex).toHaveLength(1);

    const paymentColumns = await t.db.select<{ name: string; type: string }>(
      "PRAGMA table_info(payments)",
    );
    expect(paymentColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source_sheet", type: "TEXT" }),
        expect.objectContaining({ name: "source_row", type: "INTEGER" }),
        expect.objectContaining({ name: "source_col", type: "INTEGER" }),
        expect.objectContaining({ name: "occurrence_index", type: "INTEGER" }),
      ]),
    );
  });

  it("enforces xlsx identity invariants and deterministic uniqueness", async () => {
    const accountId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
    const payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;

    await expect(
      t.db.execute(
        `INSERT INTO payments (
          payee_id, account_id, date, amount_cents, source, source_row, source_col, occurrence_index
        ) VALUES (?, ?, ?, ?, 'xlsx', ?, ?, ?)`,
        [payeeId, accountId, "2026-01-10", 4000, 8, 2, 1],
      ),
    ).rejects.toThrow();

    await expect(
      t.db.execute(
        `INSERT INTO payments (
          payee_id, account_id, date, amount_cents, source, source_sheet, source_row, source_col, occurrence_index
        ) VALUES (?, ?, ?, ?, 'xlsx', ?, ?, ?, ?)`,
        [payeeId, accountId, "2026-01-10", 4000, "2026", 8, 2, 0],
      ),
    ).rejects.toThrow();

    await t.db.execute(
      `INSERT INTO payments (
        payee_id, account_id, date, amount_cents, source, source_sheet, source_row, source_col, occurrence_index
      ) VALUES (?, ?, ?, ?, 'xlsx', ?, ?, ?, ?)`,
      [payeeId, accountId, "2026-01-10", 4000, "2026", 8, 2, 1],
    );

    await expect(
      t.db.execute(
        `INSERT INTO payments (
          payee_id, account_id, date, amount_cents, source, source_sheet, source_row, source_col, occurrence_index
        ) VALUES (?, ?, ?, ?, 'xlsx', ?, ?, ?, ?)`,
        [payeeId, accountId, "2026-01-10", 4000, "2026", 8, 2, 1],
      ),
    ).rejects.toThrow();

    await expect(
      t.db.execute(
        `INSERT INTO payments (
          payee_id, account_id, date, amount_cents, source, source_sheet, source_row, source_col, occurrence_index
        ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
        [payeeId, accountId, "2026-01-11", 4010, null, null, null, null],
      ),
    ).resolves.toBeDefined();
  });

  it("enforces foreign keys, like the app's sqlx connections", async () => {
    const [pragma] = await t.db.select<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(pragma.foreign_keys).toBe(1);
  });
});
