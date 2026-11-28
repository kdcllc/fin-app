import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  type ImportCommitProgress,
  type ImportReviewRow,
  updateTransaction,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

/** `categories` are the non-system EXPENSE accounts (usable as a `FROM` clause). */
const CATEGORY_ACCOUNTS = "accounts WHERE type = 'EXPENSE' AND system_role IS NULL";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/excel");

type XlsxImportFixture = {
  source_file: string;
  candidates: Array<{
    date: string;
    amount_cents: number;
    source_sheet: string;
    source_row: number;
    source_col: number;
    occurrence_index: number;
  }>;
};

function loadXlsxImportFixture(fileName: string): { hash: string; fixture: XlsxImportFixture } {
  const bytes = readFileSync(resolve(FIXTURES_DIR, fileName));
  const fixture = JSON.parse(bytes.toString("utf8")) as XlsxImportFixture;
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { hash, fixture };
}

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

  function fixtureRows(fixture: XlsxImportFixture): ImportReviewRow[] {
    return fixture.candidates.map((candidate, index) => ({
      id: `fixture-${index}`,
      payee_name: "Power Co",
      account_name: "Checking",
      account_kind: "checking" as const,
      category_name: "utilities",
      date: candidate.date,
      amount_cents: candidate.amount_cents,
      source_sheet: candidate.source_sheet,
      source_row: candidate.source_row,
      source_col: candidate.source_col,
      occurrence_index: candidate.occurrence_index,
      memo: null,
      dedup: { kind: "new" as const },
    }));
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
      categories: await tableCount(CATEGORY_ACCOUNTS),
      payments: await tableCount("transactions"),
      importLog: await tableCount("import_log"),
    };

    const rows = await annotateImportRowsWithDedup(t.repos, [makeRow()]);
    expect(rows[0].dedup.kind).toBe("potential_duplicate");

    expect(await tableCount("payees")).toBe(before.payees);
    expect(await tableCount("accounts")).toBe(before.accounts);
    expect(await tableCount(CATEGORY_ACCOUNTS)).toBe(before.categories);
    expect(await tableCount("transactions")).toBe(before.payments);
    expect(await tableCount("import_log")).toBe(before.importLog);
  });

  it("annotates exact duplicates when business key and source coordinates both match", async () => {
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
      source_col: 2,
      occurrence_index: 1,
    });

    const rows = await annotateImportRowsWithDedup(t.repos, [makeRow()]);
    expect(rows[0].dedup).toEqual({ kind: "exact_duplicate" });
  });

  it("issues a bounded number of dedup annotation queries independent of row count", async () => {
    await t.repos.payees.insert({ name: "Power Co" });
    await t.repos.accounts.insert({ name: "Checking", kind: "checking" });

    async function selectCountFor(rows: ImportReviewRow[]): Promise<number> {
      const before = t.calls.length;
      await annotateImportRowsWithDedup(t.repos, rows);
      return t.calls.slice(before).filter((call) => call.kind === "select").length;
    }

    const singleRowSelects = await selectCountFor([makeRow()]);

    const manyRows = Array.from({ length: 60 }, (_, index) =>
      makeRow({
        id: `bulk-${index}`,
        date: `2026-03-${String((index % 28) + 1).padStart(2, "0")}`,
        amount_cents: 1000 + index,
        source_col: 2 + index,
      }),
    );
    const manyRowSelects = await selectCountFor(manyRows);

    expect(manyRowSelects).toBe(singleRowSelects);
    expect(manyRowSelects).toBeLessThanOrEqual(5);
  });

  it("issues exactly one batch call per commit with no execute calls escaping it", async () => {
    const before = t.calls.length;

    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-one-batch",
      rows: [
        makeRow({ id: "r1" }),
        makeRow({ id: "r2", date: "2026-02-09", amount_cents: 4899, source_col: 3 }),
      ],
    });

    const during = t.calls.slice(before);
    expect(during.filter((call) => call.kind === "batch")).toHaveLength(1);
    expect(during.filter((call) => call.kind === "execute")).toHaveLength(0);

    expect(await tableCount("transactions")).toBe(2);
    expect(await tableCount("splits")).toBe(4);
    expect(await tableCount("import_log")).toBe(1);
  });

  it("rolls back payees/accounts/categories/payments/import_log on injected failure", async () => {
    // `accounts` starts with the seeded roots/system accounts: compare to the baseline.
    const baseline = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      transactions: await tableCount("transactions"),
      splits: await tableCount("splits"),
      importLog: await tableCount("import_log"),
    };

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

    expect(await tableCount("payees")).toBe(baseline.payees);
    expect(await tableCount("accounts")).toBe(baseline.accounts);
    expect(await tableCount(CATEGORY_ACCOUNTS)).toBe(0);
    expect(await tableCount("transactions")).toBe(baseline.transactions);
    expect(await tableCount("splits")).toBe(baseline.splits);
    expect(await tableCount("import_log")).toBe(baseline.importLog);
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

    expect(await tableCount("transactions")).toBe(1);
    expect(await tableCount("import_log")).toBe(0);
  });

  it("re-imports identical fixture content with zero new payments and zero new entity rows", async () => {
    const base = loadXlsxImportFixture("base.json");

    const first = await commitReviewedImport(t.repos, {
      source_file: base.fixture.source_file,
      content_hash: base.hash,
      rows: await annotateImportRowsWithDedup(t.repos, fixtureRows(base.fixture)),
    });
    expect(first.inserted_count).toBe(2);
    expect(
      first.inserted_count + first.skipped_exact_duplicates + first.skipped_potential_duplicates,
    ).toBe(base.fixture.candidates.length);

    const entityCountsAfterFirst = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      categories: await tableCount(CATEGORY_ACCOUNTS),
    };

    const second = await commitReviewedImport(t.repos, {
      source_file: base.fixture.source_file,
      content_hash: base.hash,
      rows: await annotateImportRowsWithDedup(t.repos, fixtureRows(base.fixture)),
    });
    expect(second.inserted_count).toBe(0);
    expect(second.skipped_exact_duplicates).toBe(2);
    expect(
      second.inserted_count + second.skipped_exact_duplicates + second.skipped_potential_duplicates,
    ).toBe(base.fixture.candidates.length);

    // Entity idempotency at the table level: no new payees/accounts/categories.
    expect(await tableCount("payees")).toBe(entityCountsAfterFirst.payees);
    expect(await tableCount("accounts")).toBe(entityCountsAfterFirst.accounts);
    expect(await tableCount(CATEGORY_ACCOUNTS)).toBe(entityCountsAfterFirst.categories);

    expect(await tableCount("transactions")).toBe(2);
    expect(await tableCount("import_log")).toBe(2);
  });

  it("proposes and inserts exactly one payment for the one-new-cell fixture variant", async () => {
    const base = loadXlsxImportFixture("base.json");
    await commitReviewedImport(t.repos, {
      source_file: base.fixture.source_file,
      content_hash: base.hash,
      rows: await annotateImportRowsWithDedup(t.repos, fixtureRows(base.fixture)),
    });

    const extended = loadXlsxImportFixture("one-cell-extended.json");
    const annotated = await annotateImportRowsWithDedup(t.repos, fixtureRows(extended.fixture));
    expect(annotated.filter((row) => row.dedup.kind === "new")).toHaveLength(1);

    const result = await commitReviewedImport(t.repos, {
      source_file: extended.fixture.source_file,
      content_hash: extended.hash,
      rows: annotated,
    });
    expect(result.inserted_count).toBe(1);
    expect(result.skipped_exact_duplicates).toBe(2);
    expect(await tableCount("transactions")).toBe(3);
  });

  it("reconciles inserted + skipped counts with the input row count", async () => {
    const payee = await t.repos.payees.insert({ name: "Power Co" });
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });

    // Seeds: an exact-coordinate match for row B, business-key-only matches for rows C and D.
    for (const seed of [
      { date: "2026-04-01", amount_cents: 1111, source_col: 2 },
      { date: "2026-04-02", amount_cents: 2222, source_col: 8 },
      { date: "2026-04-03", amount_cents: 3333, source_col: 9 },
    ]) {
      await t.repos.payments.insert({
        payee_id: payee.id,
        account_id: account.id,
        category_id: null,
        date: seed.date,
        amount_cents: seed.amount_cents,
        source: "xlsx",
        source_sheet: "2026",
        source_row: 5,
        source_col: seed.source_col,
        occurrence_index: 1,
      });
    }

    const rows: ImportReviewRow[] = [
      makeRow({ id: "a-new", date: "2026-04-10", amount_cents: 9999, source_row: 9 }),
      makeRow({ id: "b-exact", date: "2026-04-01", amount_cents: 1111, source_row: 5 }),
      makeRow({
        id: "c-potential-skip",
        date: "2026-04-02",
        amount_cents: 2222,
        source_row: 5,
        source_col: 3,
        dedup: { kind: "potential_duplicate", decision: "skip", match_count: 1 },
      }),
      makeRow({
        id: "d-potential-keep",
        date: "2026-04-03",
        amount_cents: 3333,
        source_row: 5,
        source_col: 4,
        dedup: { kind: "potential_duplicate", decision: "keep", match_count: 1 },
      }),
    ];

    const result = await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-reconciliation",
      rows,
    });

    expect(result.inserted_count).toBe(2);
    expect(result.skipped_exact_duplicates).toBe(1);
    expect(result.skipped_potential_duplicates).toBe(1);
    expect(
      result.inserted_count + result.skipped_exact_duplicates + result.skipped_potential_duplicates,
    ).toBe(rows.length);

    expect(await tableCount("transactions")).toBe(3 + result.inserted_count);
    const log = await t.repos.importLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].id).toBe(result.import_log_id);
    expect(log[0].row_count).toBe(rows.length);
  });

  it("creates each new entity once and resolves payment ids for it inside the batch", async () => {
    const rows: ImportReviewRow[] = [
      makeRow({
        id: "w1",
        payee_name: "Water & Sewer Co",
        account_name: "Visa Card",
        account_kind: "credit",
        category_name: "Utilities: Water",
        date: "2026-05-01",
        amount_cents: 1500,
        source_row: 3,
      }),
      makeRow({
        id: "w2",
        // Same entities, differently cased/padded — must NOT create duplicates.
        payee_name: "  water & sewer co ",
        account_name: "visa card",
        account_kind: "credit",
        category_name: "utilities: water",
        date: "2026-05-02",
        amount_cents: 1600,
        source_row: 3,
        source_col: 3,
      }),
    ];

    const result = await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-new-entities",
      rows,
    });
    expect(result.inserted_count).toBe(2);

    const payees = await t.repos.payees.list();
    const accounts = await t.repos.accounts.list();
    const categories = await t.repos.categories.list();
    expect(payees.map((row) => row.name)).toEqual(["Water & Sewer Co"]);
    expect(accounts.map((row) => row.name)).toEqual(["Visa Card"]);
    expect(accounts[0].kind).toBe("credit");
    expect(categories.map((row) => row.name)).toEqual(["Utilities: Water"]);

    const payments = await t.repos.payments.list({ from: "2026-05-01", to: "2026-05-31" });
    expect(payments).toHaveLength(2);
    for (const payment of payments) {
      expect(payment.payee_id).toBe(payees[0].id);
      expect(payment.account_id).toBe(accounts[0].id);
      expect(payment.category_id).toBe(categories[0].id);
    }
  });

  it("reuses an archived category instead of creating a duplicate row", async () => {
    const archived = await t.repos.categories.insert({ name: "utilities" });
    await t.repos.categories.archive(archived.id);

    const result = await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-archived-category",
      rows: [makeRow()],
    });
    expect(result.inserted_count).toBe(1);

    expect(await tableCount(CATEGORY_ACCOUNTS)).toBe(1);
    const [payment] = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(payment.category_id).toBe(archived.id);
  });

  it("writes a balanced expense/funding split pair for every imported transaction", async () => {
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-balanced",
      rows: [
        makeRow({ id: "b1" }),
        makeRow({ id: "b2", date: "2026-02-09", amount_cents: 4899, source_col: 3 }),
      ],
    });

    const sums = await t.db.select<{ transaction_id: number; total: number; n: number }>(
      `SELECT transaction_id, SUM(amount_cents) AS total, COUNT(*) AS n
       FROM splits GROUP BY transaction_id ORDER BY transaction_id`,
    );
    expect(sums).toHaveLength(2);
    expect(sums.every((row) => row.total === 0 && row.n === 2)).toBe(true);

    const payments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(payments).toHaveLength(2);
    for (const payment of payments) {
      const splits = await t.db.select<{ account_id: number; amount_cents: number }>(
        "SELECT account_id, amount_cents FROM splits WHERE transaction_id = ? ORDER BY id",
        [payment.id],
      );
      expect(splits).toEqual([
        { account_id: payment.category_id, amount_cents: payment.amount_cents },
        { account_id: payment.account_id, amount_cents: -payment.amount_cents },
      ]);
    }
  });

  it("never resolves a category name to a funding account or vice versa", async () => {
    const funding = await t.repos.accounts.insert({ name: "Shared", kind: "checking" });
    const category = await t.repos.categories.insert({ name: "Shared" });

    // Category named like an existing funding account.
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-same-name-1",
      rows: [makeRow({ id: "s1", account_name: "Checking", category_name: "Shared" })],
    });
    // Funding account named like an existing category.
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-same-name-2",
      rows: [
        makeRow({
          id: "s2",
          account_name: "Shared",
          category_name: null,
          date: "2026-02-02",
          source_row: 3,
        }),
      ],
    });

    const payments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    const first = payments.find((payment) => payment.date === "2026-01-08")!;
    const second = payments.find((payment) => payment.date === "2026-02-02")!;
    expect(first.category_id).toBe(category.id);
    expect(first.account_id).not.toBe(funding.id);
    expect(second.account_id).toBe(funding.id);
    expect(second.category_id).toBeNull();
    // No duplicate "Shared" account of either type was created.
    expect(await tableCount("accounts WHERE name = 'Shared'")).toBe(2);
  });

  it("keeps a new category and a new funding account with the same name apart inside one batch", async () => {
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-twin",
      rows: [
        makeRow({ id: "t1", account_name: "Twin", category_name: "Twin" }),
        // Category created BEFORE the same-named funding account (and the
        // reverse) so an unrestricted lowest-id lookup would pick the wrong one.
        makeRow({ id: "t2", account_name: "Other", category_name: "Twin2", source_row: 3 }),
        makeRow({ id: "t3", account_name: "Twin2", category_name: null, source_row: 4 }),
      ],
    });

    const payments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    const accounts = await t.repos.accounts.list();
    const categories = await t.repos.categories.list();
    const accountId = (name: string) => accounts.find((row) => row.name === name)!.id;
    const categoryId = (name: string) => categories.find((row) => row.name === name)!.id;
    expect(accounts.map((row) => row.name).sort()).toEqual(["Other", "Twin", "Twin2"]);
    expect(categories.map((row) => row.name).sort()).toEqual(["Twin", "Twin2"]);
    expect(payments.map((p) => [p.account_id, p.category_id])).toEqual([
      [accountId("Twin"), categoryId("Twin")],
      [accountId("Other"), categoryId("Twin2")],
      [accountId("Twin2"), null],
    ]);
  });

  it("creates pending funding accounts with the right type, subtype and parent", async () => {
    const kinds = [
      ["checking", "ASSET", "bank", "root_asset"],
      ["cash", "ASSET", "cash", "root_asset"],
      ["credit", "LIABILITY", "credit_card", "root_liability"],
      ["savings", "ASSET", "savings", "root_asset"],
      ["loan", "LIABILITY", "loan", "root_liability"],
    ] as const;

    const rows = kinds.map(([kind], index) =>
      makeRow({
        id: `k${index}`,
        account_name: `Acct ${kind}`,
        account_kind: kind,
        category_name: null,
        source_row: 10 + index,
      }),
    );
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-kinds",
      rows,
    });

    for (const [kind, type, subtype, rootRole] of kinds) {
      const [row] = await t.db.select<{
        type: string;
        subtype: string | null;
        placeholder: number;
        parent_role: string | null;
      }>(
        `SELECT a.type AS type, a.subtype AS subtype, a.placeholder AS placeholder, p.system_role AS parent_role
         FROM accounts a JOIN accounts p ON p.id = a.parent_id
         WHERE a.name = ?`,
        [`Acct ${kind}`],
      );
      expect(row).toEqual({ type, subtype, placeholder: 0, parent_role: rootRole });
    }
  });

  it("creates a pending category as an EXPENSE account under the expense root", async () => {
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-new-category",
      rows: [makeRow()],
    });
    const [row] = await t.db.select<{ type: string; parent_role: string | null }>(
      `SELECT a.type AS type, p.system_role AS parent_role
       FROM accounts a JOIN accounts p ON p.id = a.parent_id WHERE a.name = 'utilities'`,
    );
    expect(row).toEqual({ type: "EXPENSE", parent_role: "root_expense" });
  });

  it("commits a $0.00 cell as a zero-amount transaction with two zero splits", async () => {
    const result = await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-zero",
      rows: [makeRow({ amount_cents: 0 })],
    });
    expect(result.inserted_count).toBe(1);

    const rows = await t.db.select<{ amount_cents: number; kind: string }>(
      `SELECT s.amount_cents AS amount_cents, typeof(s.amount_cents) AS kind
       FROM splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.source = 'xlsx'`,
    );
    expect(rows).toEqual([
      { amount_cents: 0, kind: "integer" },
      { amount_cents: 0, kind: "integer" },
    ]);
    const [txn] = await t.db.select<{ import_amount_cents: number }>(
      "SELECT import_amount_cents FROM transactions",
    );
    expect(txn.import_amount_cents).toBe(0);
  });

  it("treats a cell whose transaction was edited into several splits as an exact duplicate", async () => {
    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-b23-1",
      rows: [makeRow()],
    });
    // Edit the imported transaction into three splits through the ledger: it
    // is no longer payment-shaped but keeps its xlsx identity snapshot.
    const [txn] = await t.db.select<{ id: number; payee_id: number; account_id: number }>(
      "SELECT id, payee_id, import_account_id AS account_id FROM transactions",
    );
    const [{ account_id: expenseId }] = await t.db.select<{ account_id: number }>(
      `SELECT s.account_id AS account_id FROM splits s
       JOIN accounts a ON a.id = s.account_id AND a.type = 'EXPENSE'
       WHERE s.transaction_id = ?`,
      [txn.id],
    );
    await updateTransaction(t.repos.ledger, txn.id, {
      date: "2026-01-08",
      payee_id: txn.payee_id,
      splits: [
        { account_id: expenseId, amount_cents: 3000 },
        { account_id: expenseId, amount_cents: 1858 },
        { account_id: txn.account_id, amount_cents: -4858 },
      ],
    });

    const before = {
      transactions: await tableCount("transactions"),
      splits: await tableCount("splits"),
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      importLog: await tableCount("import_log"),
    };
    const annotated = await annotateImportRowsWithDedup(t.repos, [makeRow({ id: "again" })]);
    expect(annotated[0].dedup).toEqual({ kind: "exact_duplicate" });

    const result = await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-b23-2",
      rows: annotated,
    });
    expect(result.inserted_count).toBe(0);
    expect(result.skipped_exact_duplicates).toBe(1);
    expect(await tableCount("transactions")).toBe(before.transactions);
    expect(await tableCount("splits")).toBe(before.splits);
    expect(await tableCount("payees")).toBe(before.payees);
    expect(await tableCount("accounts")).toBe(before.accounts);
    expect(await tableCount("import_log")).toBe(before.importLog + 1);
  });

  it("fails loudly with the original error as cause when two rows in one commit share a cell identity", async () => {
    const before = {
      transactions: await tableCount("transactions"),
      splits: await tableCount("splits"),
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      importLog: await tableCount("import_log"),
    };
    let caught: unknown;
    try {
      await commitReviewedImport(t.repos, {
        source_file: "fixture.xlsx",
        content_hash: "hash-b23-dup",
        rows: [makeRow({ id: "one" }), makeRow({ id: "two" })],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { cause?: unknown };
    expect(error.message).toMatch(/xlsx cell identity collides with an existing transaction/);
    expect(error.message).toMatch(/No rows were imported/);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toMatch(/UNIQUE constraint failed: transactions\./);
    expect(await tableCount("transactions")).toBe(before.transactions);
    expect(await tableCount("splits")).toBe(before.splits);
    expect(await tableCount("payees")).toBe(before.payees);
    expect(await tableCount("accounts")).toBe(before.accounts);
    expect(await tableCount("import_log")).toBe(before.importLog);
  });

  it("reports per-stage progress: reading, annotating, building, committing, done", async () => {
    const progress: ImportCommitProgress[] = [];

    await commitReviewedImport(t.repos, {
      source_file: "fixture.xlsx",
      content_hash: "hash-progress",
      rows: [makeRow()],
      on_progress: (update) => progress.push(update),
    });

    expect(progress.map((update) => update.stage)).toEqual([
      "reading",
      "annotating",
      "building",
      "committing",
      "done",
    ]);
    expect(progress.every((update) => update.total_rows === 1)).toBe(true);
  });
});
