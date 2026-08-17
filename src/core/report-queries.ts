import type { Database, SqlValue } from "./db";
import type { Payment } from "./entities";
import { ValidationError } from "./errors";
import type { BillPayGrid } from "./payment-grid";
import { getReportDatabase } from "./report-db-link";
import type { Repositories } from "./index";

const UTF8_BOM = "\uFEFF";
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_HEADERS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ReportDimension = "category" | "payee" | "account" | "total";
export type ReportGrain = "all" | "month" | "year";

export interface ReportFilter {
  from: string;
  to: string;
  accountId?: number;
  categoryId?: number | null;
}

export interface ReportQuerySpec {
  dimension: ReportDimension;
  grain: ReportGrain;
  filter: ReportFilter;
}

export interface ReportRow {
  groupKey: number | null;
  groupLabel: string;
  periodKey: string;
  total_cents: number;
  count: number;
}

export interface ReportPaymentRow extends Payment {
  payee_name: string;
  account_name: string;
  category_name: string;
}

interface AggregateRow {
  group_key: number | null;
  group_label: string | null;
  period_key: string | null;
  total_cents: number;
  count: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function formatLocalIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function validateReportFilter(filter: ReportFilter): void {
  const from = parseIsoDate(filter.from);
  const to = parseIsoDate(filter.to);
  if (!from || !to) {
    throw new ValidationError("Invalid date range.");
  }
  if (filter.from > filter.to) {
    throw new ValidationError("Start date must be on or before end date.");
  }
}

function buildFilterClauses(filter: ReportFilter): { clauses: string[]; params: SqlValue[] } {
  validateReportFilter(filter);
  const clauses = ["p.date >= ?", "p.date <= ?"];
  const params: SqlValue[] = [filter.from, filter.to];

  if (filter.accountId !== undefined) {
    clauses.push("p.account_id = ?");
    params.push(filter.accountId);
  }
  if (filter.categoryId === null) {
    clauses.push("p.category_id IS NULL");
  } else if (filter.categoryId !== undefined) {
    clauses.push("p.category_id = ?");
    params.push(filter.categoryId);
  }

  return { clauses, params };
}

function sortAllGrainRows(rows: ReportRow[]): ReportRow[] {
  return [...rows].sort((left, right) => {
    if (right.total_cents !== left.total_cents) return right.total_cents - left.total_cents;
    const labelOrder = left.groupLabel.localeCompare(right.groupLabel);
    if (labelOrder !== 0) return labelOrder;
    if (left.groupKey === null && right.groupKey === null) return 0;
    if (left.groupKey === null) return 1;
    if (right.groupKey === null) return -1;
    return left.groupKey - right.groupKey;
  });
}

function enumerateMonths(from: string, to: string): string[] {
  let year = Number.parseInt(from.slice(0, 4), 10);
  let month = Number.parseInt(from.slice(5, 7), 10);
  const endYear = Number.parseInt(to.slice(0, 4), 10);
  const endMonth = Number.parseInt(to.slice(5, 7), 10);
  const months: string[] = [];

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

export function calendarYearWindow(year: number): { from: string; to: string } {
  const padded = year.toString().padStart(4, "0");
  return { from: `${padded}-01-01`, to: `${padded}-12-31` };
}

export function trailing12Window(asOf: Date): { from: string; to: string } {
  const to = formatLocalIsoDate(asOf);
  const priorYear = asOf.getFullYear() - 1;
  const monthIndex = asOf.getMonth();
  const day = asOf.getDate();
  const lastDay = new Date(priorYear, monthIndex + 1, 0).getDate();
  const clampedDay = Math.min(day, lastDay);
  const fromDate = new Date(priorYear, monthIndex, clampedDay);
  return { from: formatLocalIsoDate(fromDate), to };
}

export function yoyWindowForCalendarYear(year: number): { from: string; to: string } {
  const padded = year.toString().padStart(4, "0");
  const prior = (year - 1).toString().padStart(4, "0");
  return { from: `${prior}-01-01`, to: `${padded}-12-31` };
}

export async function allTimeWindow(
  repos: Repositories,
): Promise<{ from: string; to: string } | null> {
  const [row] = await getReportDatabase(repos).select<{ min_date: string | null; max_date: string | null }>(
    "SELECT MIN(date) AS min_date, MAX(date) AS max_date FROM payments",
  );
  if (!row?.min_date || !row.max_date) return null;
  return { from: row.min_date, to: row.max_date };
}

export function formatCentsDecimal(amountCents: number): string {
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100);
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${sign}${dollars}.${cents}`;
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvLine(fields: string[]): string {
  return fields.map(escapeCsvField).join(",");
}

export function formatReportCsv(rows: ReportRow[]): string {
  const usePeriod = rows.some((row) => row.periodKey.length > 0);
  const headers = usePeriod ? ["Period", "Total", "Count"] : ["Group", "Total", "Count"];
  const lines = [csvLine(headers)];

  for (const row of rows) {
    if (usePeriod) {
      lines.push(csvLine([row.periodKey, formatCentsDecimal(row.total_cents), String(row.count)]));
    } else {
      lines.push(
        csvLine([row.groupLabel, formatCentsDecimal(row.total_cents), String(row.count)]),
      );
    }
  }

  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

export function formatPaymentsCsv(payments: ReportPaymentRow[]): string {
  const headers = ["Date", "Payee", "Account", "Category", "Amount", "Memo"];
  const lines = [csvLine(headers)];

  for (const payment of payments) {
    lines.push(
      csvLine([
        payment.date,
        payment.payee_name,
        payment.account_name,
        payment.category_name,
        formatCentsDecimal(payment.amount_cents),
        payment.memo ?? "",
      ]),
    );
  }

  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

export function formatYearSheetCsv(grid: BillPayGrid): string {
  const headers = ["Payee", ...MONTH_HEADERS, "Total"];
  const lines = [csvLine(headers)];

  for (const row of grid.rows) {
    lines.push(
      csvLine([
        row.payee_name,
        ...row.cells.map((cell) => formatCentsDecimal(cell.total_cents)),
        formatCentsDecimal(row.row_total_cents),
      ]),
    );
  }

  lines.push(
    csvLine([
      "Month Total",
      ...grid.month_totals.map((month) => formatCentsDecimal(month.total_cents)),
      formatCentsDecimal(grid.grand_total_cents),
    ]),
  );

  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

const PAYMENT_COLUMNS =
  "p.id, p.payee_id, p.account_id, p.category_id, p.date, p.amount_cents, p.memo, p.source, p.external_ref, p.source_sheet, p.source_row, p.source_col, p.occurrence_index, p.created_at";

export async function listPaymentsForReport(
  repos: Repositories,
  filter: ReportFilter,
): Promise<ReportPaymentRow[]> {
  const { clauses, params } = buildFilterClauses(filter);
  return getReportDatabase(repos).select<ReportPaymentRow>(
    `SELECT ${PAYMENT_COLUMNS},
            py.name AS payee_name,
            a.name AS account_name,
            COALESCE(c.name, 'Uncategorized') AS category_name
     FROM payments p
     JOIN payees py ON py.id = p.payee_id
     JOIN accounts a ON a.id = p.account_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.date, p.id`,
    params,
  );
}

async function aggregateCategoryAll(db: Database, filter: ReportFilter): Promise<ReportRow[]> {
  const { clauses, params } = buildFilterClauses(filter);
  const rows = await db.select<AggregateRow>(
    `SELECT p.category_id AS group_key,
            COALESCE(c.name, 'Uncategorized') AS group_label,
            SUM(p.amount_cents) AS total_cents,
            COUNT(*) AS count
     FROM payments p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY p.category_id`,
    params,
  );

  return sortAllGrainRows(
    rows.map((row) => ({
      groupKey: row.group_key,
      groupLabel: row.group_label ?? "Uncategorized",
      periodKey: "",
      total_cents: row.total_cents,
      count: row.count,
    })),
  );
}

async function aggregatePayeeAll(db: Database, filter: ReportFilter): Promise<ReportRow[]> {
  const { clauses, params } = buildFilterClauses(filter);
  const rows = await db.select<AggregateRow>(
    `SELECT p.payee_id AS group_key,
            py.name AS group_label,
            SUM(p.amount_cents) AS total_cents,
            COUNT(*) AS count
     FROM payments p
     JOIN payees py ON py.id = p.payee_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY p.payee_id`,
    params,
  );

  return sortAllGrainRows(
    rows.map((row) => ({
      groupKey: row.group_key,
      groupLabel: row.group_label ?? "",
      periodKey: "",
      total_cents: row.total_cents,
      count: row.count,
    })),
  );
}

async function aggregateAccountAll(db: Database, filter: ReportFilter): Promise<ReportRow[]> {
  const { clauses, params } = buildFilterClauses(filter);
  const rows = await db.select<AggregateRow>(
    `SELECT p.account_id AS group_key,
            a.name AS group_label,
            SUM(p.amount_cents) AS total_cents,
            COUNT(*) AS count
     FROM payments p
     JOIN accounts a ON a.id = p.account_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY p.account_id`,
    params,
  );

  return sortAllGrainRows(
    rows.map((row) => ({
      groupKey: row.group_key,
      groupLabel: row.group_label ?? "",
      periodKey: "",
      total_cents: row.total_cents,
      count: row.count,
    })),
  );
}

async function aggregateTotalMonth(db: Database, filter: ReportFilter): Promise<ReportRow[]> {
  const { clauses, params } = buildFilterClauses(filter);
  const rows = await db.select<AggregateRow>(
    `SELECT substr(p.date, 1, 7) AS period_key,
            SUM(p.amount_cents) AS total_cents,
            COUNT(*) AS count
     FROM payments p
     WHERE ${clauses.join(" AND ")}
     GROUP BY substr(p.date, 1, 7)
     ORDER BY period_key`,
    params,
  );

  const byPeriod = new Map(rows.map((row) => [row.period_key ?? "", row] as const));
  return enumerateMonths(filter.from, filter.to).map((periodKey) => {
    const match = byPeriod.get(periodKey);
    return {
      groupKey: null,
      groupLabel: "",
      periodKey,
      total_cents: match?.total_cents ?? 0,
      count: match?.count ?? 0,
    };
  });
}

async function aggregateTotalYear(db: Database, filter: ReportFilter): Promise<ReportRow[]> {
  const { clauses, params } = buildFilterClauses(filter);
  const rows = await db.select<AggregateRow>(
    `SELECT substr(p.date, 1, 4) AS period_key,
            SUM(p.amount_cents) AS total_cents,
            COUNT(*) AS count
     FROM payments p
     WHERE ${clauses.join(" AND ")}
     GROUP BY substr(p.date, 1, 4)
     ORDER BY period_key`,
    params,
  );

  return rows.map((row) => ({
    groupKey: null,
    groupLabel: "",
    periodKey: row.period_key ?? "",
    total_cents: row.total_cents,
    count: row.count,
  }));
}

export async function runReportQuery(
  repos: Repositories,
  spec: ReportQuerySpec,
): Promise<ReportRow[]> {
  validateReportFilter(spec.filter);
  const db = getReportDatabase(repos);

  if (spec.dimension === "category" && spec.grain === "all") {
    return aggregateCategoryAll(db, spec.filter);
  }
  if (spec.dimension === "payee" && spec.grain === "all") {
    return aggregatePayeeAll(db, spec.filter);
  }
  if (spec.dimension === "account" && spec.grain === "all") {
    return aggregateAccountAll(db, spec.filter);
  }
  if (spec.dimension === "total" && spec.grain === "month") {
    return aggregateTotalMonth(db, spec.filter);
  }
  if (spec.dimension === "total" && spec.grain === "year") {
    return aggregateTotalYear(db, spec.filter);
  }

  throw new ValidationError("Unsupported report query.");
}
