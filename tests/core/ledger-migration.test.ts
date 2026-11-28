/**
 * Migration fidelity for 0009 (v8 payments model -> double-entry ledger).
 * A v8 book is seeded with RAW SQL (the v8 schema has no ledger facades), the
 * remaining migrations are applied, and every legacy row is traced into the
 * ledger. All names, payees, guids and last-4s are placeholders.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb, type TestDb } from "../support/test-db";

interface LegacyPayment {
  id: number;
  payee_id: number;
  account_id: number;
  category_id: number | null;
  date: string;
  amount_cents: number;
  memo: string | null;
  source: "manual" | "xlsx" | "gnucash";
  external_ref: string | null;
  source_sheet: string | null;
  source_row: number | null;
  source_col: number | null;
  occurrence_index: number | null;
  created_at: string;
}
interface LegacyAccount {
  id: number;
  name: string;
  kind: "checking" | "credit" | "cash";
  last4: string | null;
  gnucash_guid: string | null;
  archived: number;
}
interface LegacyCategory {
  id: number;
  name: string;
  parent_id: number | null;
  gnucash_guid: string | null;
  archived: number;
}
interface LegacyPayee {
  id: number;
  name: string;
  default_category_id: number | null;
  default_account_id: number | null;
  notes: string | null;
  archived: number;
}

let t: TestDb;
let legacyPayments: LegacyPayment[];
let legacyAccounts: LegacyAccount[];
let legacyCategories: LegacyCategory[];
let legacyPayees: LegacyPayee[];
let legacyRecurring: unknown[];
let legacyDismissals: unknown[];
let legacyImportLog: unknown[];
let legacyExportCount: number;
let legacyMatchCount: number;
let categoryMap: Map<number, number>;

async function seedV8(db: TestDb["db"]): Promise<void> {
  // Account ids are deliberately non-contiguous (gap before 7).
  const accounts: [number, string, string, string | null, string | null, number][] = [
    [1, "Checking A", "checking", "0001", "guid-acct-1", 0],
    [2, "Card A", "credit", "0002", null, 0],
    [3, "Cash A", "cash", null, "guid-acct-3", 0],
    [7, "Old Checking", "checking", "0007", null, 1],
  ];
  for (const a of accounts) {
    await db.execute(
      "INSERT INTO accounts (id, name, kind, last4, gnucash_guid, archived) VALUES (?, ?, ?, ?, ?, ?)",
      a,
    );
  }
  // Three-level nesting 1 > 2 > 3, an archived category (4), a root with a gap id (9).
  const categories: [number, string, number | null, string | null, number][] = [
    [1, "Housing", null, "guid-cat-1", 0],
    [2, "Utilities", 1, null, 0],
    [3, "Electric", 2, "guid-cat-3", 0],
    [4, "Hobbies", null, null, 1],
    [9, "Travel", null, "guid-cat-9", 0],
  ];
  for (const c of categories) {
    await db.execute(
      "INSERT INTO categories (id, name, parent_id, gnucash_guid, archived) VALUES (?, ?, ?, ?, ?)",
      c,
    );
  }
  const payees: [number, string, number | null, number | null, string | null, number][] = [
    [1, "Payee One", 3, 1, "placeholder note", 0],
    [2, "Payee Two", null, null, null, 0],
    [3, "Payee Three", 4, 7, null, 1],
  ];
  for (const p of payees) {
    await db.execute(
      "INSERT INTO payees (id, name, default_category_id, default_account_id, notes, archived) VALUES (?, ?, ?, ?, ?, ?)",
      p,
    );
  }

  type Row = [
    number,
    number,
    number,
    number | null,
    string,
    number,
    string | null,
    string,
    string | null,
    string | null,
    number | null,
    number | null,
    number | null,
    string,
  ];
  const payments: Row[] = [
    [
      1,
      1,
      1,
      3,
      "2024-01-15",
      12345,
      "memo one",
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2024-01-15 10:00:00",
    ],
    [
      2,
      2,
      2,
      2,
      "2024-02-29",
      0,
      null,
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2024-02-29 11:00:00",
    ],
    [
      3,
      2,
      3,
      null,
      "2024-03-01",
      999,
      "no category",
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2024-03-01 12:00:00",
    ],
    [
      4,
      1,
      1,
      3,
      "2024-03-05",
      -2500,
      "refund",
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2024-03-05 13:00:00",
    ],
    [5, 1, 1, 1, "2024-04-01", 5000, null, "xlsx", null, "2024", 5, 3, 1, "2024-04-02 09:00:00"],
    [6, 1, 1, 1, "2024-04-01", 5000, null, "xlsx", null, "2024", 6, 3, 2, "2024-04-02 09:00:01"],
    [
      7,
      3,
      7,
      4,
      "2024-05-10",
      777,
      "from book",
      "gnucash",
      "gc-ref-1",
      null,
      null,
      null,
      null,
      "2024-05-11 08:00:00",
    ],
    [
      8,
      2,
      2,
      null,
      "2024-05-12",
      4200,
      null,
      "gnucash",
      "gc-ref-2",
      null,
      null,
      null,
      null,
      "2024-05-12 08:30:00",
    ],
    [
      9,
      2,
      2,
      9,
      "2025-06-30",
      123456789,
      "large",
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2025-06-30 23:59:59",
    ],
  ];
  for (const p of payments) {
    await db.execute(
      `INSERT INTO payments (id, payee_id, account_id, category_id, date, amount_cents, memo, source,
         external_ref, source_sheet, source_row, source_col, occurrence_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p,
    );
  }
  await db.execute(
    "INSERT INTO payment_exports (payment_id, format) VALUES (1, 'qif'), (2, 'csv')",
  );
  await db.execute(
    "INSERT INTO gnucash_matches (payment_id, txn_guid, status) VALUES (7, 'guid-txn-7', 'matched')",
  );
  await db.execute(
    `INSERT INTO recurring_bills (id, payee_id, frequency, expected_amount_cents, due_day, active, anchor_month, anchor_phase)
     VALUES (1, 1, 'monthly', 12000, 15, 1, 1, 1), (2, 2, 'annual', NULL, 28, 0, 6, 2)`,
  );
  await db.execute(
    `INSERT INTO recurring_bill_suggestion_dismissals (signature, payee_id, frequency, due_day, expected_amount_cents, dismissed_at)
     VALUES ('sig-1', 1, 'monthly', 15, 12000, '2024-06-01 00:00:00')`,
  );
  await db.execute(
    "INSERT INTO import_log (id, source_file, content_hash, imported_at, row_count) VALUES (1, 'placeholder.xlsx', 'hash-1', '2024-04-02 09:00:00', 2)",
  );
}

async function one<T>(sql: string, params: (string | number)[] = []): Promise<T> {
  const rows = await t.db.select<T>(sql, params);
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeAll(async () => {
  t = openTestDb({ upToVersion: 8 });
  await seedV8(t.db);

  legacyPayments = await t.db.select<LegacyPayment>("SELECT * FROM payments ORDER BY id");
  legacyAccounts = await t.db.select<LegacyAccount>("SELECT * FROM accounts ORDER BY id");
  legacyCategories = await t.db.select<LegacyCategory>("SELECT * FROM categories ORDER BY id");
  legacyPayees = await t.db.select<LegacyPayee>("SELECT * FROM payees ORDER BY id");
  legacyRecurring = await t.db.select("SELECT * FROM recurring_bills ORDER BY id");
  legacyDismissals = await t.db.select(
    "SELECT * FROM recurring_bill_suggestion_dismissals ORDER BY signature",
  );
  legacyImportLog = await t.db.select("SELECT * FROM import_log ORDER BY id");
  legacyExportCount = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM payment_exports")).n;
  legacyMatchCount = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM gnucash_matches")).n;

  t.applyRemainingMigrations();

  categoryMap = new Map(
    (
      await t.db.select<{ category_id: number; account_id: number }>(
        "SELECT category_id, account_id FROM legacy_category_map",
      )
    ).map((r) => [r.category_id, r.account_id]),
  );
});

afterAll(() => t.close());

describe("v8 seed sanity (guards against a vacuous migration test)", () => {
  it("covers the required legacy shapes", () => {
    expect(legacyPayments.some((p) => p.amount_cents === 0)).toBe(true);
    expect(legacyPayments.some((p) => p.amount_cents < 0)).toBe(true);
    expect(legacyPayments.some((p) => p.category_id === null)).toBe(true);
    expect(legacyPayments.filter((p) => p.source === "xlsx").length).toBeGreaterThanOrEqual(2);
    expect(legacyPayments.filter((p) => p.source === "gnucash" && p.external_ref).length).toBe(2);
    expect(new Set(legacyAccounts.map((a) => a.kind))).toEqual(
      new Set(["checking", "credit", "cash"]),
    );
    expect(legacyCategories.some((c) => c.archived === 1)).toBe(true);
    expect(legacyCategories.some((c) => c.gnucash_guid !== null)).toBe(true);
    expect(legacyAccounts.some((a) => a.gnucash_guid !== null)).toBe(true);
    expect(legacyExportCount).toBeGreaterThan(0);
    expect(legacyMatchCount).toBeGreaterThan(0);
  });
});

describe("migration 0009 fidelity", () => {
  it("maps every legacy payment field-for-field through the payment facade", async () => {
    expect(legacyPayments).toHaveLength(9);
    for (const legacy of legacyPayments) {
      const migrated = await t.repos.payments.get(legacy.id);
      const expectedCategory =
        legacy.category_id === null ? null : (categoryMap.get(legacy.category_id) ?? "UNMAPPED");
      expect(migrated, `payment ${legacy.id}`).toEqual({
        ...legacy,
        category_id: expectedCategory,
      });
    }
    // The facade sees exactly the legacy rows, nothing extra.
    const all = await t.repos.payments.list({ from: "0000-01-01", to: "9999-12-31" });
    expect(all.map((p) => p.id).sort((a, b) => a - b)).toEqual(legacyPayments.map((p) => p.id));
  });

  it("stores each payment as one transaction with +expense / -funding splits", async () => {
    const uncategorized = await one<{ id: number }>(
      "SELECT id FROM accounts WHERE system_role = 'uncategorized'",
    );
    for (const legacy of legacyPayments) {
      const tx = await one<Record<string, unknown>>("SELECT * FROM transactions WHERE id = ?", [
        legacy.id,
      ]);
      const isXlsx = legacy.source === "xlsx";
      expect(tx).toEqual({
        id: legacy.id,
        date: legacy.date,
        payee_id: legacy.payee_id,
        memo: legacy.memo,
        source: legacy.source,
        external_ref: legacy.external_ref,
        source_sheet: legacy.source_sheet,
        source_row: legacy.source_row,
        source_col: legacy.source_col,
        occurrence_index: legacy.occurrence_index,
        import_account_id: isXlsx ? legacy.account_id : null,
        import_amount_cents: isXlsx ? legacy.amount_cents : null,
        created_at: legacy.created_at,
      });

      const splits = await t.db.select<{
        account_id: number;
        amount_cents: number;
        reconcile_state: string;
      }>(
        "SELECT account_id, amount_cents, reconcile_state FROM splits WHERE transaction_id = ? ORDER BY id",
        [legacy.id],
      );
      const expenseAccount =
        legacy.category_id === null
          ? uncategorized.id
          : (categoryMap.get(legacy.category_id) as number);
      expect(splits, `splits of payment ${legacy.id}`).toEqual([
        { account_id: expenseAccount, amount_cents: legacy.amount_cents, reconcile_state: "n" },
        {
          account_id: legacy.account_id,
          amount_cents: 0 - legacy.amount_cents,
          reconcile_state: "n",
        },
      ]);
    }
  });

  it("maps categories to EXPENSE accounts preserving name, parent, guid and archived", async () => {
    expect(categoryMap.size).toBe(legacyCategories.length);
    expect(new Set(categoryMap.values()).size).toBe(legacyCategories.length);
    const rootExpense = await one<{ id: number }>(
      "SELECT id FROM accounts WHERE system_role = 'root_expense'",
    );

    for (const cat of legacyCategories) {
      const accountId = categoryMap.get(cat.id) as number;
      const account = await one<Record<string, unknown>>("SELECT * FROM accounts WHERE id = ?", [
        accountId,
      ]);
      expect(account, `category ${cat.id}`).toMatchObject({
        name: cat.name,
        type: "EXPENSE",
        subtype: null,
        parent_id: cat.parent_id === null ? rootExpense.id : categoryMap.get(cat.parent_id),
        placeholder: 0,
        system_role: null,
        gnucash_guid: cat.gnucash_guid,
        archived: cat.archived,
      });
    }
    // Three-level chain is intact: Electric -> Utilities -> Housing -> Expenses root.
    const electric = await one<{ parent_id: number }>(
      "SELECT parent_id FROM accounts WHERE id = ?",
      [categoryMap.get(3) as number],
    );
    const utilities = await one<{ parent_id: number }>(
      "SELECT parent_id FROM accounts WHERE id = ?",
      [electric.parent_id],
    );
    expect(electric.parent_id).toBe(categoryMap.get(2));
    expect(utilities.parent_id).toBe(categoryMap.get(1));
  });

  it("preserves funding account ids and attributes, mapping kind to type/subtype", async () => {
    const kindMap = {
      checking: { type: "ASSET", subtype: "bank", root: "root_asset" },
      cash: { type: "ASSET", subtype: "cash", root: "root_asset" },
      credit: { type: "LIABILITY", subtype: "credit_card", root: "root_liability" },
    } as const;
    for (const legacy of legacyAccounts) {
      const expected = kindMap[legacy.kind];
      const root = await one<{ id: number }>("SELECT id FROM accounts WHERE system_role = ?", [
        expected.root,
      ]);
      const account = await one<Record<string, unknown>>("SELECT * FROM accounts WHERE id = ?", [
        legacy.id,
      ]);
      expect(account, `account ${legacy.id}`).toEqual({
        id: legacy.id,
        name: legacy.name,
        type: expected.type,
        subtype: expected.subtype,
        parent_id: root.id,
        placeholder: 0,
        system_role: null,
        last4: legacy.last4,
        gnucash_guid: legacy.gnucash_guid,
        archived: legacy.archived,
      });
    }
  });

  it("creates the five roots plus Uncategorized and Opening Balances above every legacy id", async () => {
    const maxLegacy = Math.max(...legacyAccounts.map((a) => a.id));
    const system = await t.db.select<{ id: number; system_role: string }>(
      "SELECT id, system_role FROM accounts WHERE system_role IS NOT NULL ORDER BY id",
    );
    expect(system.map((s) => s.system_role).sort()).toEqual([
      "opening_balances",
      "root_asset",
      "root_equity",
      "root_expense",
      "root_income",
      "root_liability",
      "uncategorized",
    ]);
    for (const s of system) expect(s.id).toBeGreaterThan(maxLegacy);
  });

  it("remaps payee default categories and leaves the other payee fields untouched", async () => {
    const migrated = await t.db.select<LegacyPayee>("SELECT * FROM payees ORDER BY id");
    expect(migrated).toEqual(
      legacyPayees.map((p) => ({
        ...p,
        default_category_id:
          p.default_category_id === null ? null : categoryMap.get(p.default_category_id),
      })),
    );
    // Guard: the remap is real (ids changed for non-null defaults).
    expect(migrated[0].default_category_id).not.toBe(3);
  });

  it("leaves recurring bills, dismissals and the import log untouched", async () => {
    expect(await t.db.select("SELECT * FROM recurring_bills ORDER BY id")).toEqual(legacyRecurring);
    expect(
      await t.db.select("SELECT * FROM recurring_bill_suggestion_dismissals ORDER BY signature"),
    ).toEqual(legacyDismissals);
    expect(await t.db.select("SELECT * FROM import_log ORDER BY id")).toEqual(legacyImportLog);
  });

  it("has exact table counts and drops the retired tables", async () => {
    const n = async (table: string) =>
      (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)).n;
    expect(await n("transactions")).toBe(legacyPayments.length);
    expect(await n("splits")).toBe(legacyPayments.length * 2);
    expect(await n("legacy_category_map")).toBe(legacyCategories.length);
    expect(await n("accounts")).toBe(legacyAccounts.length + legacyCategories.length + 7);
    expect(await n("payees")).toBe(legacyPayees.length);
    expect(await n("recurring_bills")).toBe(legacyRecurring.length);

    const tables = (
      await t.db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((r) => r.name);
    for (const dropped of ["payments", "categories", "payment_exports", "gnucash_matches"]) {
      expect(tables).not.toContain(dropped);
    }
  });

  it("keeps every transaction balanced, the grand total at 0 and foreign keys clean", async () => {
    const unbalanced = await t.db.select(
      "SELECT transaction_id, SUM(amount_cents) AS s FROM splits GROUP BY transaction_id HAVING s != 0",
    );
    expect(unbalanced).toEqual([]);
    const total = await one<{ s: number }>(
      "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM splits",
    );
    expect(total.s).toBe(0);
    expect(await t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });
});
