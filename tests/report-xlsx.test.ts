import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBillPayGridForYear, listPaymentsForReport } from "../src/core";
import {
  buildPaymentsXlsxSpec,
  buildYearSheetXlsxSpec,
  type ReportXlsxRow,
  type ReportXlsxSpec,
} from "../src/report-xlsx";
import { openTestDb, type TestDb } from "./support/test-db";
import {
  REPORT_FIXTURE_WINDOW,
  seedReportingFixture,
} from "./support/report-fixture";

const FIXTURE_WINDOW = REPORT_FIXTURE_WINDOW;

function centsFromSpecRow(row: ReportXlsxRow): number[] {
  return row.cells.flatMap((cell) => (cell.kind === "cents" ? [cell.amountCents] : []));
}

function textFromSpecRow(row: ReportXlsxRow): string | undefined {
  const textCell = row.cells.find((cell) => cell.kind === "text");
  return textCell?.kind === "text" ? textCell.value : undefined;
}

function assertYearSheetSpecMatchesGrid(spec: ReportXlsxSpec, grid: Awaited<ReturnType<typeof getBillPayGridForYear>>) {
  expect(spec.sheetName).toBe(String(grid.year));
  expect(spec.headers).toEqual([
    "Payee",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
    "Total",
  ]);
  expect(spec.rows).toHaveLength(grid.rows.length + 1);

  for (const gridRow of grid.rows) {
    const specRow = spec.rows.find((row) => textFromSpecRow(row) === gridRow.payee_name);
    if (!specRow) throw new Error(`missing xlsx row for payee ${gridRow.payee_name}`);

    const monthCents = centsFromSpecRow(specRow).slice(0, 12);
    expect(monthCents).toEqual(gridRow.cells.map((cell) => cell.total_cents));
    expect(centsFromSpecRow(specRow).at(-1)).toBe(gridRow.row_total_cents);
  }

  const monthTotalRow = spec.rows.at(-1);
  if (!monthTotalRow) throw new Error("missing month total row");
  expect(textFromSpecRow(monthTotalRow)).toBe("Month Total");

  const monthTotalCents = centsFromSpecRow(monthTotalRow);
  expect(monthTotalCents.slice(0, 12)).toEqual(grid.month_totals.map((month) => month.total_cents));
  expect(monthTotalCents.at(-1)).toBe(grid.grand_total_cents);
}

describe("report xlsx spec builders", () => {
  let t: TestDb;

  beforeEach(() => {
    t = openTestDb();
  });

  afterEach(() => t.close());

  it("buildYearSheetXlsxSpec cell cents match getBillPayGridForYear totals", async () => {
    await seedReportingFixture(t);

    const grid = await getBillPayGridForYear(t.repos, 2026);
    const spec = buildYearSheetXlsxSpec(grid);

    assertYearSheetSpecMatchesGrid(spec, grid);
  });

  it("buildPaymentsXlsxSpec matches listPaymentsForReport dump including Uncategorized-only", async () => {
    await seedReportingFixture(t);

    const uncategorizedDump = await listPaymentsForReport(t.repos, {
      ...FIXTURE_WINDOW,
      categoryId: null,
    });
    expect(uncategorizedDump).toHaveLength(1);

    const spec = buildPaymentsXlsxSpec(uncategorizedDump);
    expect(spec.rows).toHaveLength(1);

    const payment = uncategorizedDump[0];
    const cells = spec.rows[0]?.cells ?? [];
    expect(cells[0]).toEqual({ kind: "date", iso: payment.date });
    expect(cells[1]).toEqual({ kind: "text", value: payment.payee_name });
    expect(cells[2]).toEqual({ kind: "text", value: payment.account_name });
    expect(cells[3]).toEqual({ kind: "text", value: payment.category_name });
    expect(cells[4]).toEqual({ kind: "cents", amountCents: payment.amount_cents });
    expect(payment.category_id).toBeNull();
    expect(payment.category_name).toBe("Uncategorized");

    const allDump = await listPaymentsForReport(t.repos, FIXTURE_WINDOW);
    const allSpec = buildPaymentsXlsxSpec(allDump);
    expect(allSpec.rows).toHaveLength(4);
    for (let index = 0; index < allDump.length; index += 1) {
      const dumpRow = allDump[index];
      const rowCells = allSpec.rows[index]?.cells ?? [];
      expect(rowCells[0]).toEqual({ kind: "date", iso: dumpRow.date });
      expect(rowCells[1]).toEqual({ kind: "text", value: dumpRow.payee_name });
      expect(rowCells[2]).toEqual({ kind: "text", value: dumpRow.account_name });
      expect(rowCells[3]).toEqual({ kind: "text", value: dumpRow.category_name });
      expect(rowCells[4]).toEqual({ kind: "cents", amountCents: dumpRow.amount_cents });
    }
  });
});
