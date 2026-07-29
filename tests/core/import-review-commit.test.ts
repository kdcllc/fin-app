import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  createRepositories,
  type Database,
  type ImportReviewRow,
  type Repositories,
  type SqlValue,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

describe("import review commit", () => {
  let t: TestDb;

  beforeEach(() => {
    t = openTestDb();
  });

  afterEach(() => {
    t.close();
  });

  async function tableCount(name: string): Promise<number> {
    const rows = await t.db.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`);
    return rows[0].count;
  }

  function makeRow(partial: Partial<ImportReviewRow> = {}): ImportReviewRow {
    return {
      id: "r1",
      payee_name: "Power Co",
      account_name: "Checking",
      account_kind: "checking",
      category_name: "utilities",
      date: "2026-01-08",
      amount_cents: 4858,
      source_sheet: "2026",
      source_row: 2,
      source_col: 2,
      occurrence_index: 1,
      memo: null,
      dedup: { kind: "new" },
      ...partial,
    };
  }

  function wrapWithFixedInsertId(
    db: Database,
    {
      insertId,
      onlyTable,
    }: {
      insertId: number;
      onlyTable?: string;
    },
  ): Database {
    return {
      async execute(sql: string, params: SqlValue[] = []) {
        const result = await db.execute(sql, params);
        if (/^\s*insert\s+into\s+/i.test(sql)) {
          if (!onlyTable || new RegExp(`^\\s*insert\\s+into\\s+${onlyTable}\\b`, "i").test(sql)) {
            return { ...result, lastInsertId: insertId };
          }
        }
        return result;
      },
      async select<T>(sql: string, params: SqlValue[] = []) {
        return db.select<T>(sql, params);
      },
      async transaction<T>(work: (tx: Database) => Promise<T>) {
        return db.transaction((txDb) => work(wrapWithFixedInsertId(txDb, { insertId, onlyTable })));
      },
    };
  }

  function makeReposWithFixedInsertId(
    baseDb: Database,
    options: {
      insertId: number;
      onlyTable?: string;
    },
  ): Repositories {
    return createRepositories(wrapWithFixedInsertId(baseDb, options));
  }

  it("requires explicit keep/skip decisions for potential duplicates", async () => {
    await expect(
      commitReviewedImport(t.repos, {
        source_file: "fixture.xlsx",
        content_hash: "hash-1",
        rows: [
          makeRow({
            dedup: {
              kind: "potential_duplicate",
              decision: null,
              match_count: 1,
            },
          }),
        ],
      }),
    ).rejects.toThrow(/requires keep\/skip duplicate decision/i);
  });

  it("does not write to DB during dedup annotation review", async () => {
    const payee = await t.repos.payees.insert({ name: "Power Co" });
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });

    await t.repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      category_id: null,
      date: "2026-01-08",
      amount_cents: 4858,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 2,
      source_col: 8,
      occurrence_index: 1,
    });

    const before = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      categories: await tableCount("categories"),
      payments: await tableCount("payments"),
      importLog: await tableCount("import_log"),
    };

    const rows = await annotateImportRowsWithDedup(t.repos, [makeRow()]);
    expect(rows[0].dedup.kind).toBe("potential_duplicate");

    expect(await tableCount("payees")).toBe(before.payees);
    expect(await tableCount("accounts")).toBe(before.accounts);
    expect(await tableCount("categories")).toBe(before.categories);
    expect(await tableCount("payments")).toBe(before.payments);
    expect(await tableCount("import_log")).toBe(before.importLog);
  });

  it("rolls back payees/accounts/categories/payments/import_log on injected failure", async () => {
    await expect(
      commitReviewedImport(t.repos, {
        source_file: "fixture.xlsx",
        content_hash: "hash-2",
        rows: [
          makeRow({ id: "r1", payee_name: "New Payee 1", account_name: "New Account 1" }),
          makeRow({
            id: "r2",
            payee_name: "New Payee 2",
            account_name: "New Account 2",
            source_row: 3,
          }),
        ],
        fail_after_insert_count: 1,
      }),
    ).rejects.toThrow(/injected failure/i);

    expect(await tableCount("payees")).toBe(0);
    expect(await tableCount("accounts")).toBe(0);
    expect(await tableCount("categories")).toBe(0);
    expect(await tableCount("payments")).toBe(0);
    expect(await tableCount("import_log")).toBe(0);
  });

  it("blocks commit when a row transitions from new to potential duplicate at commit time", async () => {
    const payee = await t.repos.payees.insert({ name: "Power Co" });
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });

    const [annotatedRow] = await annotateImportRowsWithDedup(t.repos, [makeRow()]);
    expect(annotatedRow.dedup.kind).toBe("new");

    await t.repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      category_id: null,
      date: "2026-01-08",
      amount_cents: 4858,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 2,
      source_col: 9,
      occurrence_index: 1,
    });

    await expect(
      commitReviewedImport(t.repos, {
        source_file: "fixture.xlsx",
        content_hash: "hash-stale-transition",
        rows: [annotatedRow],
      }),
    ).rejects.toThrow(/requires keep\/skip duplicate decision/i);

    expect(await tableCount("payments")).toBe(1);
    expect(await tableCount("import_log")).toBe(0);
  });

  it("recovers from fixed lastInsertId anomalies and preserves correct associations", async () => {
    const oldPayee = await t.repos.payees.insert({ name: "Old Payee" });
    const oldAccount = await t.repos.accounts.insert({ name: "Old Account", kind: "checking" });
    const oldCategory = await t.repos.categories.insert({ name: "old-category" });
    const oldLog = await t.repos.importLog.append({
      source_file: "old-source.xlsx",
      content_hash: "old-file-hash",
      row_count: 5,
    });

    await t.repos.payments.insert({
      payee_id: oldPayee.id,
      account_id: oldAccount.id,
      category_id: oldCategory.id,
      date: "2026-01-01",
      amount_cents: 111,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 2,
      source_col: 2,
      occurrence_index: 1,
    });

    const repos = makeReposWithFixedInsertId(t.db, { insertId: 1 });
    const result = await commitReviewedImport(repos, {
      source_file: "fixture.xlsx",
      content_hash: "bytes-hash-new",
      rows: [
        makeRow({
          id: "anomaly-row",
          payee_name: "Anomaly Payee",
          account_name: "Anomaly Account",
          category_name: "anomaly-category",
          amount_cents: 4858,
          source_row: 10,
          source_col: 4,
        }),
      ],
    });

    expect(result.inserted_count).toBe(1);
    expect(result.import_log_id).toBeGreaterThan(oldLog.id);

    const payees = await t.repos.payees.list({ includeArchived: true });
    const accounts = await t.repos.accounts.list({ includeArchived: true });
    const categories = await t.repos.categories.list();

    const newPayee = payees.find((p) => p.name === "Anomaly Payee");
    const newAccount = accounts.find((a) => a.name === "Anomaly Account");
    const newCategory = categories.find((c) => c.name === "anomaly-category");

    expect(newPayee).toBeTruthy();
    expect(newAccount).toBeTruthy();
    expect(newCategory).toBeTruthy();

    const payments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    const inserted = payments.find(
      (payment) => payment.source_row === 10 && payment.source_col === 4,
    );

    expect(inserted).toBeTruthy();
    expect(inserted?.payee_id).toBe(newPayee?.id);
    expect(inserted?.account_id).toBe(newAccount?.id);
    expect(inserted?.category_id).toBe(newCategory?.id ?? null);
  });

  it("rolls back atomically when insert metadata anomaly leads to ambiguous import_log fallback", async () => {
    const repos = makeReposWithFixedInsertId(t.db, { insertId: 1, onlyTable: "import_log" });

    await t.repos.importLog.append({
      source_file: "different.xlsx",
      content_hash: "different-hash",
      row_count: 99,
    });

    await t.repos.importLog.append({
      source_file: "fixture.xlsx",
      content_hash: "same-hash",
      row_count: 1,
    });
    await t.repos.importLog.append({
      source_file: "fixture.xlsx",
      content_hash: "same-hash",
      row_count: 1,
    });

    const before = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      categories: await tableCount("categories"),
      payments: await tableCount("payments"),
      importLog: await tableCount("import_log"),
    };

    await expect(
      commitReviewedImport(repos, {
        source_file: "fixture.xlsx",
        content_hash: "same-hash",
        rows: [
          makeRow({
            id: "rollback-row",
            payee_name: "Rollback Payee",
            account_name: "Rollback Account",
            category_name: "rollback-category",
          }),
        ],
      }),
    ).rejects.toThrow(/payload query is ambiguous/i);

    expect(await tableCount("payees")).toBe(before.payees);
    expect(await tableCount("accounts")).toBe(before.accounts);
    expect(await tableCount("categories")).toBe(before.categories);
    expect(await tableCount("payments")).toBe(before.payments);
    expect(await tableCount("import_log")).toBe(before.importLog);
  });
});
