import { invoke } from "@tauri-apps/api/core";
import type { BillPayGrid, ReportPaymentRow, ReportRow } from "./core";

export type XlsxCell =
  | { kind: "text"; value: string }
  | { kind: "date"; iso: string }
  | { kind: "cents"; amountCents: number }
  | { kind: "integer"; value: number };

export interface ReportXlsxRow {
  cells: XlsxCell[];
}

export interface ReportXlsxSpec {
  sheetName: string;
  headers: string[];
  rows: ReportXlsxRow[];
}

export type ExportReportXlsxError =
  | { kind: "write_failed"; path: string; message: string }
  | { kind: "build_failed"; message: string };

const MONTH_HEADERS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function buildReportTableXlsxSpec(
  rows: ReportRow[],
  showPeriodColumn: boolean,
  sheetName = "Report",
): ReportXlsxSpec {
  const headers = showPeriodColumn ? ["Period", "Total", "Count"] : ["Group", "Total", "Count"];
  return {
    sheetName,
    headers,
    rows: rows.map((row) => ({
      cells: showPeriodColumn
        ? [
            { kind: "text", value: row.periodKey },
            { kind: "cents", amountCents: row.total_cents },
            { kind: "integer", value: row.count },
          ]
        : [
            { kind: "text", value: row.groupLabel },
            { kind: "cents", amountCents: row.total_cents },
            { kind: "integer", value: row.count },
          ],
    })),
  };
}

export function buildPaymentsXlsxSpec(
  payments: ReportPaymentRow[],
  sheetName = "Payments",
): ReportXlsxSpec {
  return {
    sheetName,
    headers: ["Date", "Payee", "Account", "Category", "Amount", "Memo"],
    rows: payments.map((payment) => ({
      cells: [
        { kind: "date", iso: payment.date },
        { kind: "text", value: payment.payee_name },
        { kind: "text", value: payment.account_name },
        { kind: "text", value: payment.category_name },
        { kind: "cents", amountCents: payment.amount_cents },
        { kind: "text", value: payment.memo ?? "" },
      ],
    })),
  };
}

export function buildYearSheetXlsxSpec(grid: BillPayGrid): ReportXlsxSpec {
  return {
    sheetName: String(grid.year),
    headers: ["Payee", ...MONTH_HEADERS, "Total"],
    rows: [
      ...grid.rows.map((row) => ({
        cells: [
          { kind: "text" as const, value: row.payee_name },
          ...row.cells.map((cell) => ({ kind: "cents" as const, amountCents: cell.total_cents })),
          { kind: "cents" as const, amountCents: row.row_total_cents },
        ],
      })),
      {
        cells: [
          { kind: "text" as const, value: "Month Total" },
          ...grid.month_totals.map((month) => ({
            kind: "cents" as const,
            amountCents: month.total_cents,
          })),
          { kind: "cents" as const, amountCents: grid.grand_total_cents },
        ],
      },
    ],
  };
}

/** Invoke Rust xlsx export for a typed tabular spec. */
export async function exportReportXlsx(path: string, spec: ReportXlsxSpec): Promise<void> {
  return invoke<void>("export_report_xlsx", { path, spec });
}
