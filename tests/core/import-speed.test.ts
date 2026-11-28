/**
 * Speed guard for the import commit path — the diagnosed per-row round-trip
 * explosion (one IPC round trip + one `SELECT last_insert_rowid()` per insert
 * under the plugin backend) must never come back.
 *
 * A generated fixture of ≥ 1,000 payment cells goes through the full
 * parse → annotate → commit pipeline and the commit must issue EXACTLY ONE
 * `batch` call (and zero stray `execute` calls). The wall-clock duration is
 * printed for the completion report; there is no hard time assertion because
 * CI machines vary — the < 5 s goal criterion is dev-machine QA evidence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  parsePaymentCells,
  type ImportReviewRow,
  type PaymentCellInput,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

const PAYEE_ROWS = 84;
const MONTH_COLS = 12;
const PAYMENT_COUNT = PAYEE_ROWS * MONTH_COLS; // 1,008 ≥ 1,000

/**
 * Deterministic workbook-shaped fixture: 84 payee rows × 12 month columns of
 * `MM/DD $XX.YY` cells on sheet "2026". Every cell has a unique
 * payee/date/amount so annotation classifies all of them as new.
 */
function generateFixtureCells(): { cells: PaymentCellInput[]; expectedTotalCents: number } {
  const cells: PaymentCellInput[] = [];
  let expectedTotalCents = 0;

  for (let payeeIndex = 0; payeeIndex < PAYEE_ROWS; payeeIndex += 1) {
    for (let monthIndex = 0; monthIndex < MONTH_COLS; monthIndex += 1) {
      const cents = 1000 + payeeIndex * MONTH_COLS + monthIndex;
      expectedTotalCents += cents;

      const month = String(monthIndex + 1).padStart(2, "0");
      const day = String((payeeIndex % 28) + 1).padStart(2, "0");
      const dollars = Math.floor(cents / 100);
      const rest = String(cents % 100).padStart(2, "0");
      cells.push({
        sheet: "2026",
        // Row 1 is the header, col 1 the payee label, as in the real workbook.
        row: payeeIndex + 2,
        col: monthIndex + 2,
        text: `${month}/${day} $${dollars}.${rest}`,
      });
    }
  }

  return { cells, expectedTotalCents };
}

describe("import speed guard (generated 1,008-payment fixture)", () => {
  let t: TestDb;

  beforeEach(() => {
    t = openTestDb();
  });

  afterEach(() => {
    t.close();
  });

  it("commits all payments via exactly one batch call", async () => {
    const { cells, expectedTotalCents } = generateFixtureCells();

    const parsed = parsePaymentCells(cells);
    expect(parsed.parsed).toHaveLength(PAYMENT_COUNT);
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.parsed_cells + parsed.unparsed.length).toBe(parsed.non_empty_cells);

    const rows: ImportReviewRow[] = parsed.parsed.map((record) => ({
      id: `${record.sheet}:${record.row}:${record.col}:${record.occurrence_index}`,
      payee_name: `Payee ${record.row}`,
      account_name: "Checking",
      account_kind: "checking",
      category_name: "utilities",
      date: record.date,
      amount_cents: record.amount_cents,
      source_sheet: record.sheet,
      source_row: record.row,
      source_col: record.col,
      occurrence_index: record.occurrence_index,
      memo: null,
      dedup: { kind: "new" },
    }));

    const annotated = await annotateImportRowsWithDedup(t.repos, rows);
    expect(annotated.every((row) => row.dedup.kind === "new")).toBe(true);

    const callsBefore = t.calls.length;
    const start = performance.now();
    const result = await commitReviewedImport(t.repos, {
      source_file: "generated-speed-guard.xlsx",
      content_hash: "hash-speed-guard",
      rows: annotated,
    });
    const durationMs = performance.now() - start;

    // The round-trip guard: ONE batch call, no execute calls escaping it.
    const during = t.calls.slice(callsBefore);
    expect(during.filter((call) => call.kind === "batch")).toHaveLength(1);
    expect(during.filter((call) => call.kind === "execute")).toHaveLength(0);

    expect(result.inserted_count).toBe(PAYMENT_COUNT);
    expect(
      result.inserted_count +
        result.skipped_exact_duplicates +
        result.skipped_potential_duplicates,
    ).toBe(annotated.length);

    // Every row landed, with exact integer-cent totals.
    const [{ n, total }] = await t.db.select<{ n: number; total: number }>(
      `SELECT COUNT(*) AS n, SUM(s.amount_cents) AS total
       FROM transactions t
       JOIN splits s ON s.transaction_id = t.id
       JOIN accounts a ON a.id = s.account_id AND a.type = 'EXPENSE'`,
    );
    expect(n).toBe(PAYMENT_COUNT);
    expect(total).toBe(expectedTotalCents);
    const [{ payees }] = await t.db.select<{ payees: number }>(
      "SELECT COUNT(*) AS payees FROM payees",
    );
    expect(payees).toBe(PAYEE_ROWS);

    // Wall-clock evidence for the completion report (no hard assertion; CI varies).
    console.log(
      `[speed guard] committed ${result.inserted_count} payments via 1 batch call in ${durationMs.toFixed(1)} ms`,
    );
  });
});
