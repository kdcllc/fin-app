/**
 * End-to-end import pipeline from a RAW workbook payload (the shape the Rust
 * `read_xlsx_workbook_raw` command returns): parse payment cells → normalize
 * payee labels → build review rows → annotate with dedup → commit as one
 * atomic batch. Mirrors the ImportPage wiring but exercises the core layer
 * directly, pinning the reconciliation invariants:
 *
 * - parser conservation: parsed_cells + unparsed.length == non_empty_cells;
 * - commit accounting: inserted + skipped_exact + skipped_potential == rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  normalizePayeeLabel,
  parsePaymentCells,
  type ImportReviewRow,
  type PaymentCellInput,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/excel");

interface WorkbookSheet {
  name: string;
  rows: string[][];
  nonEmptyCells: Array<{ row: number; col: number; value: string }>;
}

interface WorkbookPayload {
  fileSha256: string;
  sheets: WorkbookSheet[];
}

function loadWorkbookFixture(fileName: string): { payload: WorkbookPayload; hash: string } {
  const bytes = readFileSync(resolve(FIXTURES_DIR, fileName));
  return {
    payload: JSON.parse(bytes.toString("utf8")) as WorkbookPayload,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * The payment cells of a payload: everything outside the header row and the
 * payee label column — the same rule ImportPage applies.
 */
function paymentCellsOf(sheet: WorkbookSheet): PaymentCellInput[] {
  return sheet.nonEmptyCells
    .filter((cell) => cell.row > 1 && cell.col > 1)
    .map((cell) => ({ sheet: sheet.name, row: cell.row, col: cell.col, text: cell.value }));
}

/** Parse a payload into review rows the way the import wizard does. */
function buildReviewRows(payload: WorkbookPayload): {
  rows: ImportReviewRow[];
  parsedCells: number;
  unparsedCells: number;
  nonEmptyCells: number;
} {
  const rows: ImportReviewRow[] = [];
  let parsedCells = 0;
  let unparsedCells = 0;
  let nonEmptyCells = 0;

  for (const sheet of payload.sheets) {
    const parsed = parsePaymentCells(paymentCellsOf(sheet));
    parsedCells += parsed.parsed_cells;
    unparsedCells += parsed.unparsed.length;
    nonEmptyCells += parsed.non_empty_cells;

    for (const record of parsed.parsed) {
      const rawPayeeLabel = (sheet.rows[record.row - 1]?.[0] ?? "").trim();
      if (rawPayeeLabel.length === 0) continue; // UI routes these to manual review

      const normalized = normalizePayeeLabel(rawPayeeLabel);
      rows.push({
        id: `${record.sheet}:${record.row}:${record.col}:${record.occurrence_index}`,
        payee_name: normalized.payee,
        account_name:
          normalized.account_hint.payment_method ??
          (normalized.account_hint.last4 ? `Account ${normalized.account_hint.last4}` : "Checking"),
        account_kind: "checking",
        category_name: normalized.category_suggestion,
        date: record.date,
        amount_cents: record.amount_cents,
        source_sheet: record.sheet,
        source_row: record.row,
        source_col: record.col,
        occurrence_index: record.occurrence_index,
        memo: null,
        dedup: { kind: "new" },
      });
    }
  }

  return { rows, parsedCells, unparsedCells, nonEmptyCells };
}

/**
 * In-code workbook exercising the format edge cases from the real workbook:
 * a multi-payment cell, a thousands-separator amount (`$10,673.91`), a
 * no-decimal amount (`$1000`), and a garbage cell.
 */
const EDGE_CASE_PAYLOAD: WorkbookPayload = {
  fileSha256: "fixture-hash-import-pipeline-edge-cases",
  sheets: [
    {
      name: "2026",
      rows: [
        ["Payee", "Jan", "Feb"],
        ["Water Co", "01/05 $20.00  01/19 $15.25", "?? see bank"],
        ["Mortgage", "01/28 $10,673.91", "04/27 $1000"],
      ],
      nonEmptyCells: [
        { row: 1, col: 1, value: "Payee" },
        { row: 1, col: 2, value: "Jan" },
        { row: 1, col: 3, value: "Feb" },
        { row: 2, col: 1, value: "Water Co" },
        { row: 2, col: 2, value: "01/05 $20.00  01/19 $15.25" },
        { row: 2, col: 3, value: "?? see bank" },
        { row: 3, col: 1, value: "Mortgage" },
        { row: 3, col: 2, value: "01/28 $10,673.91" },
        { row: 3, col: 3, value: "04/27 $1000" },
      ],
    },
  ],
};

describe("import pipeline end-to-end (raw workbook payload)", () => {
  let t: TestDb;

  beforeEach(() => {
    t = openTestDb();
  });

  afterEach(() => {
    t.close();
  });

  async function tableCount(name: string): Promise<number> {
    const rows = await t.db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
    return rows[0].n;
  }

  it("parses, annotates, and commits the happy-path workbook with reconciling counts", async () => {
    const { payload, hash } = loadWorkbookFixture("import-review-ui-happy-path.json");
    const review = buildReviewRows(payload);

    // Parser conservation over the payment cells (3 cells, all parseable).
    expect(review.nonEmptyCells).toBe(3);
    expect(review.parsedCells + review.unparsedCells).toBe(review.nonEmptyCells);
    expect(review.unparsedCells).toBe(0);
    // The 03/10 cell sits on a row without a payee label → excluded, as in the UI.
    expect(review.rows).toHaveLength(2);

    const annotated = await annotateImportRowsWithDedup(t.repos, review.rows);
    expect(annotated.every((row) => row.dedup.kind === "new")).toBe(true);

    const result = await commitReviewedImport(t.repos, {
      source_file: "happy-path.xlsx",
      content_hash: hash,
      rows: annotated,
    });

    expect(result.inserted_count).toBe(2);
    expect(
      result.inserted_count +
        result.skipped_exact_duplicates +
        result.skipped_potential_duplicates,
    ).toBe(annotated.length);

    expect(await tableCount("transactions")).toBe(2);
    expect(await tableCount("splits")).toBe(4);
    expect(await tableCount("import_log")).toBe(1);
    const payments = await t.db.select<{ amount_cents: number; date: string }>(
      `SELECT s.amount_cents AS amount_cents, t.date AS date
       FROM transactions t
       JOIN splits s ON s.transaction_id = t.id
       JOIN accounts a ON a.id = s.account_id AND a.type = 'EXPENSE'
       ORDER BY t.date`,
    );
    expect(payments).toEqual([
      { amount_cents: 4858, date: "2026-01-08" },
      { amount_cents: 4899, date: "2026-02-09" },
    ]);
    const payees = await t.db.select<{ name: string }>("SELECT name FROM payees");
    expect(payees).toEqual([{ name: "Power Co" }]);
  });

  it("re-imports the same workbook payload with zero new rows anywhere", async () => {
    const { payload, hash } = loadWorkbookFixture("import-review-ui-happy-path.json");

    const first = await commitReviewedImport(t.repos, {
      source_file: "happy-path.xlsx",
      content_hash: hash,
      rows: await annotateImportRowsWithDedup(t.repos, buildReviewRows(payload).rows),
    });
    expect(first.inserted_count).toBe(2);

    const countsAfterFirst = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      categories: await tableCount("accounts WHERE type = 'EXPENSE'"),
      payments: await tableCount("transactions"),
      splits: await tableCount("splits"),
    };

    // Full pipeline again from the same raw payload — annotation must mark
    // every row an exact duplicate and the commit must insert nothing.
    const secondRows = await annotateImportRowsWithDedup(t.repos, buildReviewRows(payload).rows);
    expect(secondRows.every((row) => row.dedup.kind === "exact_duplicate")).toBe(true);

    const second = await commitReviewedImport(t.repos, {
      source_file: "happy-path.xlsx",
      content_hash: hash,
      rows: secondRows,
    });
    expect(second.inserted_count).toBe(0);
    expect(second.skipped_exact_duplicates).toBe(2);

    expect(await tableCount("payees")).toBe(countsAfterFirst.payees);
    expect(await tableCount("accounts")).toBe(countsAfterFirst.accounts);
    expect(await tableCount("accounts WHERE type = 'EXPENSE'")).toBe(countsAfterFirst.categories);
    expect(await tableCount("transactions")).toBe(countsAfterFirst.payments);
    expect(await tableCount("splits")).toBe(countsAfterFirst.splits);
  });

  it("handles multi-payment, thousands-separator, no-decimal, and garbage cells", async () => {
    const review = buildReviewRows(EDGE_CASE_PAYLOAD);

    // 4 payment cells: 3 parse (one into two records), 1 is garbage.
    expect(review.nonEmptyCells).toBe(4);
    expect(review.parsedCells).toBe(3);
    expect(review.unparsedCells).toBe(1);
    expect(review.parsedCells + review.unparsedCells).toBe(review.nonEmptyCells);
    expect(review.rows).toHaveLength(4);

    const multiPayment = review.rows.filter((row) => row.source_row === 2 && row.source_col === 2);
    expect(multiPayment.map((row) => row.occurrence_index)).toEqual([1, 2]);

    const result = await commitReviewedImport(t.repos, {
      source_file: "edge-cases.xlsx",
      content_hash: EDGE_CASE_PAYLOAD.fileSha256,
      rows: await annotateImportRowsWithDedup(t.repos, review.rows),
    });
    expect(result.inserted_count).toBe(4);

    const payments = await t.db.select<{ amount_cents: number; date: string }>(
      `SELECT s.amount_cents AS amount_cents, t.date AS date
       FROM transactions t
       JOIN splits s ON s.transaction_id = t.id
       JOIN accounts a ON a.id = s.account_id AND a.type = 'EXPENSE'
       ORDER BY t.date, s.amount_cents`,
    );
    // Exact integer cents, including $10,673.91 and the no-decimal $1000.
    expect(payments).toEqual([
      { amount_cents: 2000, date: "2026-01-05" },
      { amount_cents: 1525, date: "2026-01-19" },
      { amount_cents: 1067391, date: "2026-01-28" },
      { amount_cents: 100000, date: "2026-04-27" },
    ]);
  });

  it("rolls back the whole pipeline commit on a mid-batch failure", async () => {
    const review = buildReviewRows(EDGE_CASE_PAYLOAD);
    const tables = [
      "payees",
      "accounts",
      "accounts WHERE type = 'EXPENSE'",
      "transactions",
      "splits",
      "import_log",
    ];
    // `accounts` starts with the seeded roots/system accounts, so compare to
    // the pre-commit baseline instead of zero.
    const baseline: number[] = [];
    for (const table of tables) baseline.push(await tableCount(table));

    await expect(
      commitReviewedImport(t.repos, {
        source_file: "edge-cases.xlsx",
        content_hash: EDGE_CASE_PAYLOAD.fileSha256,
        rows: await annotateImportRowsWithDedup(t.repos, review.rows),
        fail_after_insert_count: 2,
      }),
    ).rejects.toThrow(/injected failure/i);

    for (const [index, table] of tables.entries()) {
      expect(await tableCount(table)).toBe(baseline[index]);
    }
  });
});
