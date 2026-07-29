import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  type ImportReviewRow,
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
});
