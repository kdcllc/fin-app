/**
 * Parse free-text payment cells such as `01/08 $48.58` into normalized
 * records. Parsing is conservative and all-or-nothing at the cell level:
 * if any non-whitespace text cannot be parsed, the entire cell is emitted
 * as unparsed for review.
 */

const PAYMENT_FRAGMENT_RE = /(\d{1,2})\/(\d{1,2})\s*\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
const THOUSANDS_AMOUNT_RE = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

export interface PaymentCellInput {
  sheet: string;
  row: number;
  col: number;
  text: string;
  /** Optional metadata for caller-side cross checks; parser trusts MM/DD text. */
  month_column?: number;
}

export interface ParsedPaymentCellRecord {
  sheet: string;
  row: number;
  col: number;
  occurrence_index: number;
  date: string;
  amount_cents: number;
  raw_fragment: string;
}

export interface UnparsedPaymentCell {
  sheet: string;
  row: number;
  col: number;
  raw_text: string;
}

export interface ParsePaymentCellsResult {
  parsed: ParsedPaymentCellRecord[];
  unparsed: UnparsedPaymentCell[];
  /** Count of non-empty source cells seen by the parser. */
  non_empty_cells: number;
  /**
   * Count of source cells that fully parsed.
   * Invariant: `parsed_cells + unparsed.length === non_empty_cells`.
   */
  parsed_cells: number;
}

function parseSheetYear(sheet: string): number | null {
  const match = /^\s*(\d{4})\s*$/.exec(sheet);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const probe = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return iso;
}

function parseAmountCents(amountText: string): number | null {
  if (!THOUSANDS_AMOUNT_RE.test(amountText)) return null;

  const normalized = amountText.replaceAll(",", "");
  const parts = normalized.split(".");
  if (parts.length > 2) return null;

  const dollars = Number.parseInt(parts[0], 10);
  if (!Number.isSafeInteger(dollars) || dollars < 0) return null;

  let centsPart = 0;
  if (parts.length === 2) {
    if (parts[1].length === 1) {
      centsPart = Number.parseInt(parts[1], 10) * 10;
    } else if (parts[1].length === 2) {
      centsPart = Number.parseInt(parts[1], 10);
    } else {
      return null;
    }
  }

  const amountCents = dollars * 100 + centsPart;
  if (!Number.isSafeInteger(amountCents)) return null;
  return amountCents;
}

function parseOneCell(cell: PaymentCellInput):
  | { kind: "empty" }
  | { kind: "parsed"; records: ParsedPaymentCellRecord[] }
  | { kind: "unparsed" } {
  const raw = cell.text;
  if (raw.trim().length === 0) return { kind: "empty" };

  const year = parseSheetYear(cell.sheet);
  if (year === null) return { kind: "unparsed" };

  PAYMENT_FRAGMENT_RE.lastIndex = 0;
  let cursor = 0;
  let occurrence = 0;
  const records: ParsedPaymentCellRecord[] = [];

  for (const match of raw.matchAll(PAYMENT_FRAGMENT_RE)) {
    const matchIndex = match.index ?? 0;
    const gap = raw.slice(cursor, matchIndex);
    if (gap.trim().length > 0) return { kind: "unparsed" };

    const month = Number.parseInt(match[1], 10);
    const day = Number.parseInt(match[2], 10);
    const amountCents = parseAmountCents(match[3]);
    const date = toIsoDate(year, month, day);
    if (amountCents === null || date === null) return { kind: "unparsed" };

    occurrence += 1;
    records.push({
      sheet: cell.sheet,
      row: cell.row,
      col: cell.col,
      occurrence_index: occurrence,
      date,
      amount_cents: amountCents,
      raw_fragment: match[0].trim(),
    });

    cursor = matchIndex + match[0].length;
  }

  if (records.length === 0) return { kind: "unparsed" };

  const tail = raw.slice(cursor);
  if (tail.trim().length > 0) return { kind: "unparsed" };

  return { kind: "parsed", records };
}

export function parsePaymentCells(cells: PaymentCellInput[]): ParsePaymentCellsResult {
  const parsed: ParsedPaymentCellRecord[] = [];
  const unparsed: UnparsedPaymentCell[] = [];

  let nonEmptyCells = 0;
  let parsedCells = 0;

  for (const cell of cells) {
    const parsedCell = parseOneCell(cell);
    if (parsedCell.kind === "empty") continue;

    nonEmptyCells += 1;
    if (parsedCell.kind === "parsed") {
      parsedCells += 1;
      parsed.push(...parsedCell.records);
      continue;
    }

    unparsed.push({
      sheet: cell.sheet,
      row: cell.row,
      col: cell.col,
      raw_text: cell.text,
    });
  }

  return {
    parsed,
    unparsed,
    non_empty_cells: nonEmptyCells,
    parsed_cells: parsedCells,
  };
}