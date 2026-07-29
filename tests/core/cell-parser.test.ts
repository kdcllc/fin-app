import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePaymentCells } from "../../src/core";

type ParserFixture = {
  cells: Array<{
    sheet: string;
    row: number;
    col: number;
    text: string;
    month_column?: number;
  }>;
  non_empty_data_cells: number;
};

type WorkbookFixture = {
  sheets: Array<{
    name: string;
    rows: string[][];
    nonEmptyCells: Array<{ row: number; col: number; value: string }>;
  }>;
};

function loadParserFixture(fileName: string): ParserFixture {
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/excel", fileName);
  return JSON.parse(readFileSync(fixturePath, "utf8")) as ParserFixture;
}

function loadWorkbookFixture(fileName: string): WorkbookFixture {
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/excel", fileName);
  return JSON.parse(readFileSync(fixturePath, "utf8")) as WorkbookFixture;
}

describe("payment cell parser", () => {
  it("parses observed formats into integer cents", () => {
    const result = parsePaymentCells([
      { sheet: "2026", row: 11, col: 2, text: "01/08  $48.58" },
      { sheet: "2026", row: 11, col: 3, text: "04/27 $1000" },
      { sheet: "2026", row: 11, col: 4, text: "01/28 $10,673.91" },
    ]);

    expect(result.unparsed).toEqual([]);
    expect(result.parsed).toEqual([
      {
        sheet: "2026",
        row: 11,
        col: 2,
        occurrence_index: 1,
        date: "2026-01-08",
        amount_cents: 4858,
        raw_fragment: "01/08  $48.58",
      },
      {
        sheet: "2026",
        row: 11,
        col: 3,
        occurrence_index: 1,
        date: "2026-04-27",
        amount_cents: 100000,
        raw_fragment: "04/27 $1000",
      },
      {
        sheet: "2026",
        row: 11,
        col: 4,
        occurrence_index: 1,
        date: "2026-01-28",
        amount_cents: 1067391,
        raw_fragment: "01/28 $10,673.91",
      },
    ]);
    expect(result.non_empty_cells).toBe(3);
    expect(result.parsed_cells).toBe(3);
    expect(result.parsed_cells + result.unparsed.length).toBe(result.non_empty_cells);
    for (const payment of result.parsed) {
      expect(Number.isInteger(payment.amount_cents)).toBe(true);
    }
  });

  it("supports multiple payments in one cell via newlines or repeated MM/DD patterns", () => {
    const result = parsePaymentCells([
      { sheet: "2026", row: 20, col: 8, text: "01/08 $48.58\n01/10 $12" },
      { sheet: "2026", row: 21, col: 8, text: "02/09 $48.99 02/10 $10,000.05" },
    ]);

    expect(result.unparsed).toEqual([]);
    expect(result.parsed).toEqual([
      {
        sheet: "2026",
        row: 20,
        col: 8,
        occurrence_index: 1,
        date: "2026-01-08",
        amount_cents: 4858,
        raw_fragment: "01/08 $48.58",
      },
      {
        sheet: "2026",
        row: 20,
        col: 8,
        occurrence_index: 2,
        date: "2026-01-10",
        amount_cents: 1200,
        raw_fragment: "01/10 $12",
      },
      {
        sheet: "2026",
        row: 21,
        col: 8,
        occurrence_index: 1,
        date: "2026-02-09",
        amount_cents: 4899,
        raw_fragment: "02/09 $48.99",
      },
      {
        sheet: "2026",
        row: 21,
        col: 8,
        occurrence_index: 2,
        date: "2026-02-10",
        amount_cents: 1000005,
        raw_fragment: "02/10 $10,000.05",
      },
    ]);

    expect(result.non_empty_cells).toBe(2);
    expect(result.parsed_cells).toBe(2);
    expect(result.parsed).toHaveLength(4);
    expect(result.parsed_cells + result.unparsed.length).toBe(result.non_empty_cells);
  });

  it("trusts MM/DD in the cell text even when month column metadata disagrees", () => {
    const result = parsePaymentCells([
      {
        sheet: "2026",
        row: 12,
        col: 5,
        month_column: 4,
        text: "03/26 $52.44",
      },
    ]);

    expect(result.unparsed).toEqual([]);
    expect(result.parsed[0]).toMatchObject({
      date: "2026-03-26",
      amount_cents: 5244,
    });
  });

  it("emits unparsed records with source coordinates for non-empty cells that fail full parsing", () => {
    const result = parsePaymentCells([
      { sheet: "2026", row: 9, col: 2, text: "hello" },
      { sheet: "2026", row: 9, col: 3, text: "01/08 $48.58 trailing" },
      { sheet: "2026", row: 9, col: 4, text: "02/30 $10" },
      { sheet: "2026", row: 9, col: 5, text: "  " },
    ]);

    expect(result.parsed).toEqual([]);
    expect(result.unparsed).toEqual([
      {
        sheet: "2026",
        row: 9,
        col: 2,
        raw_text: "hello",
      },
      {
        sheet: "2026",
        row: 9,
        col: 3,
        raw_text: "01/08 $48.58 trailing",
      },
      {
        sheet: "2026",
        row: 9,
        col: 4,
        raw_text: "02/30 $10",
      },
    ]);

    expect(result.non_empty_cells).toBe(3);
    expect(result.parsed_cells).toBe(0);
    expect(result.parsed_cells + result.unparsed.length).toBe(result.non_empty_cells);
  });

  it("proves conservation behavior against representative fixture cells", () => {
    const fixture = loadParserFixture("cell-parser-conservation.json");
    const result = parsePaymentCells(fixture.cells);

    expect(result.non_empty_cells).toBe(fixture.non_empty_data_cells);
    expect(result.parsed_cells + result.unparsed.length).toBe(fixture.non_empty_data_cells);

    // The fixture has one multi-payment cell and one unparsed garbage cell.
    expect(result.parsed).toHaveLength(4);
    expect(result.unparsed).toHaveLength(1);
  });

  it("proves parser conservation per sheet for workbook fixture data cells", () => {
    const fixture = loadWorkbookFixture("import-review-ui-happy-path.json");

    for (const sheet of fixture.sheets) {
      const paymentCells = sheet.nonEmptyCells
        .filter((cell) => cell.row > 1 && cell.col > 1)
        .map((cell) => ({
          sheet: sheet.name,
          row: cell.row,
          col: cell.col,
          text: cell.value,
        }));

      const result = parsePaymentCells(paymentCells);
      expect(result.parsed_cells + result.unparsed.length).toBe(paymentCells.length);
      expect(result.non_empty_cells).toBe(paymentCells.length);
    }
  });
});
