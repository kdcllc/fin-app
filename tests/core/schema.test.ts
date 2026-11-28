import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type TestDb } from "../support/test-db";

async function names(t: TestDb, type: "table" | "index"): Promise<string[]> {
  return (
    await t.db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
  ).map((row) => row.name);
}

describe("test database schema (v9 ledger)", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("applies the real migration files, in order, ending at the ledger schema", async () => {
    const tables = await names(t, "table");
    expect(tables).toEqual(
      expect.arrayContaining([
        "accounts",
        "payees",
        "transactions",
        "splits",
        "legacy_category_map",
        "recurring_bills",
        "recurring_bill_suggestion_dismissals",
        "import_log",
      ]),
    );
    for (const dropped of ["payments", "categories", "payment_exports", "gnucash_matches"]) {
      expect(tables).not.toContain(dropped);
    }

    const indexes = await names(t, "index");
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_recurring_bills_payee_id", // migration 0002 — proves incremental application
        "idx_import_log_content_hash", // migration 0003
        "idx_recurring_suggestion_dismissals_payee", // migration 0005
        "idx_accounts_parent_id",
        "idx_accounts_type_archived_name",
        "idx_transactions_date",
        "idx_transactions_payee_id",
        "idx_splits_transaction_id",
        "idx_splits_account_id",
        "idx_transactions_xlsx_identity",
        "idx_transactions_xlsx_business",
      ]),
    );
    expect(indexes).not.toContain("idx_payments_xlsx_identity");

    const recurringColumns = await t.db.select<{ name: string; type: string }>(
      "PRAGMA table_info(recurring_bills)",
    );
    expect(recurringColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "anchor_month", type: "INTEGER" }),
        expect.objectContaining({ name: "anchor_phase", type: "INTEGER" }),
      ]),
    );
  });

  it("has the v9 accounts, transactions and splits columns", async () => {
    const cols = async (table: string) =>
      (await t.db.select<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
    expect(await cols("accounts")).toEqual([
      "id",
      "name",
      "type",
      "subtype",
      "parent_id",
      "placeholder",
      "system_role",
      "last4",
      "gnucash_guid",
      "archived",
    ]);
    expect(await cols("transactions")).toEqual([
      "id",
      "date",
      "payee_id",
      "memo",
      "source",
      "external_ref",
      "source_sheet",
      "source_row",
      "source_col",
      "occurrence_index",
      "import_account_id",
      "import_amount_cents",
      "created_at",
    ]);
    expect(await t.db.select("PRAGMA table_info(transactions)")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source_sheet", type: "TEXT" }),
        expect.objectContaining({ name: "source_row", type: "INTEGER" }),
        expect.objectContaining({ name: "source_col", type: "INTEGER" }),
        expect.objectContaining({ name: "occurrence_index", type: "INTEGER" }),
      ]),
    );
    expect(await cols("splits")).toEqual([
      "id",
      "transaction_id",
      "account_id",
      "amount_cents",
      "memo",
      "reconcile_state",
    ]);
  });

  it("seeds the five roots and the two system accounts on a fresh book", async () => {
    const rows = await t.db.select<{
      system_role: string;
      placeholder: number;
      parent_id: number | null;
    }>(
      "SELECT system_role, placeholder, parent_id FROM accounts WHERE system_role IS NOT NULL ORDER BY id",
    );
    expect(rows.map((r) => r.system_role)).toEqual([
      "root_asset",
      "root_liability",
      "root_income",
      "root_expense",
      "root_equity",
      "uncategorized",
      "opening_balances",
    ]);
    expect(rows.slice(0, 5).every((r) => r.placeholder === 1 && r.parent_id === null)).toBe(true);
    expect(rows.slice(5).every((r) => r.placeholder === 0 && r.parent_id !== null)).toBe(true);
  });

  it("enforces account CHECKs (type, subtype, root-only NULL parent)", async () => {
    const [root] = await t.db.select<{ id: number }>(
      "SELECT id FROM accounts WHERE system_role = 'root_asset'",
    );
    const insert = (type: string, subtype: string | null, parent: number | null) =>
      t.db.execute("INSERT INTO accounts (name, type, subtype, parent_id) VALUES ('X', ?, ?, ?)", [
        type,
        subtype,
        parent,
      ]);
    await expect(insert("BOGUS", null, root.id)).rejects.toThrow();
    await expect(insert("ASSET", "credit_card", root.id)).rejects.toThrow();
    await expect(insert("EXPENSE", "bank", root.id)).rejects.toThrow();
    await expect(insert("ASSET", "bank", null)).rejects.toThrow();
    await expect(insert("ASSET", "bank", root.id)).resolves.toBeDefined();
  });

  it("enforces xlsx identity invariants and deterministic uniqueness on transactions", async () => {
    const accountId = (
      await t.db.execute(
        "INSERT INTO accounts (name, type, subtype, parent_id) VALUES ('Checking', 'ASSET', 'bank', (SELECT id FROM accounts WHERE system_role = 'root_asset'))",
      )
    ).lastInsertId;
    const payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;

    const insertXlsx = (
      sheet: string | null,
      row: number | null,
      col: number | null,
      occ: number | null,
      importAccount: number | null = accountId,
      importAmount: number | null = 4000,
    ) =>
      t.db.execute(
        `INSERT INTO transactions (
          payee_id, date, source, source_sheet, source_row, source_col, occurrence_index,
          import_account_id, import_amount_cents
        ) VALUES (?, '2026-01-10', 'xlsx', ?, ?, ?, ?, ?, ?)`,
        [payeeId, sheet, row, col, occ, importAccount, importAmount],
      );

    await expect(insertXlsx(null, 8, 2, 1)).rejects.toThrow();
    await expect(insertXlsx("2026", 8, 2, 0)).rejects.toThrow();
    // NOT NULL snapshot is required for xlsx rows (NULLs are distinct in a unique index).
    await expect(insertXlsx("2026", 8, 2, 1, accountId, null)).rejects.toThrow();
    await expect(insertXlsx("2026", 8, 2, 1, null, 4000)).rejects.toThrow();
    await expect(insertXlsx("2026", 8, 2, 1)).resolves.toBeDefined();
    await expect(insertXlsx("2026", 8, 2, 1)).rejects.toThrow();

    await expect(
      t.db.execute(
        "INSERT INTO transactions (payee_id, date, source) VALUES (?, '2026-01-11', 'manual')",
        [payeeId],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a split referencing an unknown account with the FK error", async () => {
    const txId = (
      await t.db.execute("INSERT INTO transactions (date, source) VALUES ('2026-01-01', 'manual')")
    ).lastInsertId;
    await expect(
      t.db.execute(
        "INSERT INTO splits (transaction_id, account_id, amount_cents) VALUES (?, 99999, 100)",
        [txId],
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces foreign keys, like the app's sqlx connections", async () => {
    const [pragma] = await t.db.select<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(pragma.foreign_keys).toBe(1);
  });
});

describe("migration 0009 on a v8 book", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb({ upToVersion: 8 })));
  afterEach(() => t.close());

  async function exec(sql: string, params: (string | number | null)[] = []) {
    return (await t.db.execute(sql, params)).lastInsertId;
  }

  /** Seed a v8 book: nested categories, payees with defaults, mixed-source payments. */
  async function seedLegacy() {
    const checking = await exec(
      "INSERT INTO accounts (name, kind, last4) VALUES ('Checking', 'checking', '1111')",
    );
    const credit = await exec(
      "INSERT INTO accounts (name, kind, gnucash_guid, archived) VALUES ('Card', 'credit', 'guid-card', 1)",
    );
    const cash = await exec("INSERT INTO accounts (name, kind) VALUES ('Wallet', 'cash')");
    const utilities = await exec(
      "INSERT INTO categories (name, gnucash_guid) VALUES ('Utilities', 'guid-util')",
    );
    const electric = await exec("INSERT INTO categories (name, parent_id) VALUES ('Electric', ?)", [
      utilities,
    ]);
    const peak = await exec(
      "INSERT INTO categories (name, parent_id, archived) VALUES ('Peak', ?, 1)",
      [electric],
    );
    const food = await exec("INSERT INTO categories (name) VALUES ('Food')");
    const power = await exec(
      "INSERT INTO payees (name, default_category_id, default_account_id) VALUES ('Power Co', ?, ?)",
      [electric, checking],
    );
    const grocer = await exec("INSERT INTO payees (name) VALUES ('Grocer')");
    const ins = (cols: string, vals: (string | number | null)[]) =>
      exec(
        `INSERT INTO payments (${cols}, created_at) VALUES (${vals.map(() => "?").join(", ")}, '2026-01-01 08:00:00')`,
        vals,
      );
    const base = "payee_id, account_id, category_id, date, amount_cents, memo, source";
    const p1 = await ins(base + ", source_sheet, source_row, source_col, occurrence_index", [
      power,
      checking,
      peak,
      "2026-01-10",
      12345,
      "jan",
      "xlsx",
      "2026",
      8,
      2,
      1,
    ]);
    const p2 = await ins(base + ", external_ref", [
      grocer,
      credit,
      null,
      "2026-01-11",
      999,
      null,
      "gnucash",
      "txn-1",
    ]);
    const p3 = await ins(base, [grocer, cash, food, "2026-01-12", 0, "zero", "manual"]);
    const p4 = await ins(base, [power, checking, utilities, "2026-01-13", 100, null, "manual"]);
    return {
      checking,
      credit,
      cash,
      utilities,
      electric,
      peak,
      food,
      power,
      grocer,
      ids: [p1, p2, p3, p4],
    };
  }

  it("migrates every payment to one balanced two-split transaction, losing nothing", async () => {
    const seed = await seedLegacy();
    const oldPayments = await t.db.select<Record<string, number | string | null>>(
      "SELECT * FROM payments ORDER BY id",
    );
    const oldCategories = (
      await t.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM categories")
    )[0].n;
    const oldAccounts = await t.db.select<{
      id: number;
      name: string;
      last4: string | null;
      gnucash_guid: string | null;
      archived: number;
    }>("SELECT id, name, last4, gnucash_guid, archived FROM accounts ORDER BY id");

    t.applyRemainingMigrations();

    expect(await t.db.select("PRAGMA foreign_key_check")).toEqual([]);
    const [fk] = await t.db.select<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(fk.foreign_keys).toBe(1);

    // Row counts preserved.
    const [{ n: txCount }] = await t.db.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions",
    );
    const [{ n: splitCount }] = await t.db.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM splits",
    );
    expect(txCount).toBe(oldPayments.length);
    expect(splitCount).toBe(2 * oldPayments.length);
    const [{ n: mapped }] = await t.db.select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM accounts a JOIN legacy_category_map m ON m.account_id = a.id WHERE a.type = 'EXPENSE'`,
    );
    expect(mapped).toBe(oldCategories);
    const [{ total }] = await t.db.select<{ total: number }>(
      "SELECT SUM(amount_cents) AS total FROM splits",
    );
    expect(total).toBe(0);

    // Per-payment fidelity.
    for (const p of oldPayments) {
      const [tx] = await t.db.select<Record<string, number | string | null>>(
        "SELECT * FROM transactions WHERE id = ?",
        [p.id],
      );
      for (const col of [
        "date",
        "payee_id",
        "memo",
        "source",
        "external_ref",
        "source_sheet",
        "source_row",
        "source_col",
        "occurrence_index",
        "created_at",
      ]) {
        expect(tx[col], `${col} of payment ${p.id}`).toBe(p[col]);
      }
      expect(tx.import_account_id).toBe(p.source === "xlsx" ? p.account_id : null);
      expect(tx.import_amount_cents).toBe(p.source === "xlsx" ? p.amount_cents : null);

      const splits = await t.db.select<{
        account_id: number;
        amount_cents: number;
        reconcile_state: string;
      }>(
        "SELECT account_id, amount_cents, reconcile_state FROM splits WHERE transaction_id = ? ORDER BY id",
        [p.id],
      );
      expect(splits).toHaveLength(2);
      expect(splits.every((s) => s.reconcile_state === "n")).toBe(true);
      expect(splits[0].amount_cents).toBe(p.amount_cents);
      expect(splits[1]).toMatchObject({
        account_id: p.account_id,
        amount_cents: 0 - (p.amount_cents as number),
      });
      const [expenseAcct] = await t.db.select<{
        type: string;
        system_role: string | null;
        cat: number | null;
      }>(
        `SELECT a.type, a.system_role, m.category_id AS cat FROM accounts a
         LEFT JOIN legacy_category_map m ON m.account_id = a.id WHERE a.id = ?`,
        [splits[0].account_id],
      );
      expect(expenseAcct.type).toBe("EXPENSE");
      if (p.category_id === null) expect(expenseAcct.system_role).toBe("uncategorized");
      else expect(expenseAcct.cat).toBe(p.category_id);
    }

    // Funding accounts: ids and attributes preserved, mapped to type/subtype under roots.
    const accounts = await t.db.select<{
      id: number;
      name: string;
      type: string;
      subtype: string;
      last4: string | null;
      gnucash_guid: string | null;
      archived: number;
      parent_role: string;
    }>(
      `SELECT a.id, a.name, a.type, a.subtype, a.last4, a.gnucash_guid, a.archived, r.system_role AS parent_role
       FROM accounts a JOIN accounts r ON r.id = a.parent_id WHERE a.id IN (?, ?, ?) ORDER BY a.id`,
      [seed.checking, seed.credit, seed.cash],
    );
    expect(accounts).toEqual([
      expect.objectContaining({
        id: seed.checking,
        type: "ASSET",
        subtype: "bank",
        parent_role: "root_asset",
      }),
      expect.objectContaining({
        id: seed.credit,
        type: "LIABILITY",
        subtype: "credit_card",
        parent_role: "root_liability",
      }),
      expect.objectContaining({
        id: seed.cash,
        type: "ASSET",
        subtype: "cash",
        parent_role: "root_asset",
      }),
    ]);
    for (const old of oldAccounts) {
      const a = accounts.find((x) => x.id === old.id)!;
      expect([a.name, a.last4, a.gnucash_guid, a.archived]).toEqual([
        old.name,
        old.last4,
        old.gnucash_guid,
        old.archived,
      ]);
    }
  });

  it("maps nested categories at any depth, preserving name, guid and archived", async () => {
    const seed = await seedLegacy();
    t.applyRemainingMigrations();
    const rowFor = async (categoryId: number) =>
      (
        await t.db.select<{
          id: number;
          name: string;
          type: string;
          gnucash_guid: string | null;
          archived: number;
          parent_id: number;
          parent_role: string | null;
        }>(
          `SELECT a.id, a.name, a.type, a.gnucash_guid, a.archived, a.parent_id, p.system_role AS parent_role
         FROM legacy_category_map m JOIN accounts a ON a.id = m.account_id JOIN accounts p ON p.id = a.parent_id
         WHERE m.category_id = ?`,
          [categoryId],
        )
      )[0];
    const util = await rowFor(seed.utilities);
    const electric = await rowFor(seed.electric);
    const peak = await rowFor(seed.peak);
    const food = await rowFor(seed.food);
    expect(util).toMatchObject({
      name: "Utilities",
      type: "EXPENSE",
      gnucash_guid: "guid-util",
      archived: 0,
      parent_role: "root_expense",
    });
    expect(food.parent_role).toBe("root_expense");
    expect(electric.parent_id).toBe(util.id);
    expect(peak.parent_id).toBe(electric.id);
    expect(peak).toMatchObject({ name: "Peak", archived: 1 });
  });

  it("remaps payee default categories and keeps other payee columns", async () => {
    const seed = await seedLegacy();
    t.applyRemainingMigrations();
    const [power] = await t.db.select<{
      id: number;
      default_category_id: number;
      default_account_id: number;
    }>("SELECT id, default_category_id, default_account_id FROM payees WHERE id = ?", [seed.power]);
    const [mapped] = await t.db.select<{ account_id: number }>(
      "SELECT account_id FROM legacy_category_map WHERE category_id = ?",
      [seed.electric],
    );
    expect(power.default_category_id).toBe(mapped.account_id);
    expect(power.default_account_id).toBe(seed.checking);
    const [grocer] = await t.db.select<{ default_category_id: number | null }>(
      "SELECT default_category_id FROM payees WHERE id = ?",
      [seed.grocer],
    );
    expect(grocer.default_category_id).toBeNull();
  });

  it("creates the seven system accounts above every legacy account id", async () => {
    const seed = await seedLegacy();
    t.applyRemainingMigrations();
    const rows = await t.db.select<{
      id: number;
      system_role: string;
      type: string;
      placeholder: number;
    }>(
      "SELECT id, system_role, type, placeholder FROM accounts WHERE system_role IS NOT NULL ORDER BY id",
    );
    expect(rows).toHaveLength(7);
    expect(Math.min(...rows.map((r) => r.id))).toBeGreaterThan(
      Math.max(seed.checking, seed.credit, seed.cash),
    );
    expect(rows.find((r) => r.system_role === "uncategorized")).toMatchObject({
      type: "EXPENSE",
      placeholder: 0,
    });
    expect(rows.find((r) => r.system_role === "opening_balances")).toMatchObject({
      type: "EQUITY",
      placeholder: 0,
    });
  });

  it("deleting an unreferenced migrated category account removes its map row", async () => {
    const seed = await seedLegacy();
    t.applyRemainingMigrations();
    const [{ account_id }] = await t.db.select<{ account_id: number }>(
      "SELECT account_id FROM legacy_category_map WHERE category_id = ?",
      [seed.peak],
    );
    // Peak is a leaf, but payment 1 posts to it — delete an unreferenced one instead.
    const [{ account_id: foodAcct }] = await t.db.select<{ account_id: number }>(
      "SELECT account_id FROM legacy_category_map WHERE category_id = ?",
      [seed.food],
    );
    await t.db.execute("DELETE FROM splits WHERE account_id = ?", [foodAcct]);
    await t.db.execute("DELETE FROM payees WHERE default_category_id = ?", [foodAcct]);
    await t.db.execute("DELETE FROM accounts WHERE id = ?", [foodAcct]);
    expect(
      await t.db.select("SELECT 1 FROM legacy_category_map WHERE account_id = ?", [foodAcct]),
    ).toEqual([]);
    expect(
      await t.db.select("SELECT 1 FROM legacy_category_map WHERE account_id = ?", [account_id]),
    ).toHaveLength(1);
  });

  it("rejects an xlsx transaction with NULL import_amount_cents after migration", async () => {
    const seed = await seedLegacy();
    t.applyRemainingMigrations();
    await expect(
      t.db.execute(
        `INSERT INTO transactions (payee_id, date, source, source_sheet, source_row, source_col, occurrence_index, import_account_id, import_amount_cents)
         VALUES (?, '2026-02-01', 'xlsx', '2026', 1, 1, 1, ?, NULL)`,
        [seed.power, seed.checking],
      ),
    ).rejects.toThrow();
  });

  it("migrates an empty v8 book without error", async () => {
    t.applyRemainingMigrations();
    expect(await t.db.select("PRAGMA foreign_key_check")).toEqual([]);
    const [{ n }] = await t.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM accounts");
    expect(n).toBe(7);
  });
});
