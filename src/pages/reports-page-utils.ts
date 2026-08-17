import { yoyWindowForCalendarYear, type ReportFilter } from "../core";

export type WindowPreset = "calendar-year" | "trailing-12" | "all-time" | "custom";

export type ReportTypeId =
  | "category-breakdown"
  | "payee-ranking"
  | "spend-trend"
  | "year-over-year"
  | "account-usage";

export interface ReportTypeDefinition {
  id: ReportTypeId;
  label: string;
  dimension: "category" | "payee" | "account" | "total";
  grain: "all" | "month" | "year";
}

export const REPORT_TYPES: ReportTypeDefinition[] = [
  { id: "category-breakdown", label: "Where the money goes", dimension: "category", grain: "all" },
  { id: "payee-ranking", label: "Payee ranking", dimension: "payee", grain: "all" },
  { id: "spend-trend", label: "Spend trend", dimension: "total", grain: "month" },
  { id: "year-over-year", label: "Year-over-year", dimension: "total", grain: "year" },
  { id: "account-usage", label: "Account usage", dimension: "account", grain: "all" },
];

export type CategoryFilterSelection = "all" | "uncategorized" | number;

export function resolveQueryWindow(
  reportType: ReportTypeId,
  preset: WindowPreset,
  calendarYear: number,
  baseWindow: { from: string; to: string },
): { from: string; to: string } {
  if (reportType === "year-over-year" && preset === "calendar-year") {
    return yoyWindowForCalendarYear(calendarYear);
  }
  return baseWindow;
}

export function buildReportFilter(
  window: { from: string; to: string },
  accountIdText: string,
  categorySelection: CategoryFilterSelection,
): ReportFilter {
  const filter: ReportFilter = { ...window };

  if (accountIdText.trim().length > 0) {
    filter.accountId = Number.parseInt(accountIdText, 10);
  }
  if (categorySelection === "uncategorized") {
    filter.categoryId = null;
  } else if (categorySelection !== "all") {
    filter.categoryId = categorySelection;
  }

  return filter;
}

const REPORT_PDF_SLUGS: Record<ReportTypeId, string> = {
  "category-breakdown": "category",
  "payee-ranking": "payee",
  "spend-trend": "spend-trend",
  "year-over-year": "yoy",
  "account-usage": "account",
};

export function reportPdfDefaultFileName(reportTypeId: ReportTypeId, year: number): string {
  return `fin-report-${REPORT_PDF_SLUGS[reportTypeId]}-${year}.pdf`;
}

export function yearFromFilterTo(to: string): number {
  return Number.parseInt(to.slice(0, 4), 10);
}

export function reportTableDefaultFileName(
  reportTypeId: ReportTypeId,
  year: number,
  extension: "xlsx" | "csv",
): string {
  return `fin-report-${REPORT_PDF_SLUGS[reportTypeId]}-${year}.${extension}`;
}

export function paymentsDefaultFileName(year: number, extension: "xlsx" | "csv"): string {
  return `fin-payments-${year}.${extension}`;
}

export function yearSheetDefaultFileName(year: number, extension: "xlsx" | "csv"): string {
  return `fin-year-${year}.${extension}`;
}

export function buildReportPeriodLabel(
  preset: WindowPreset,
  calendarYear: number,
  customFrom: string,
  customTo: string,
  queryWindow: { from: string; to: string },
): string {
  switch (preset) {
    case "calendar-year":
      return `Calendar year ${calendarYear}`;
    case "trailing-12":
      return `Trailing 12 months (${queryWindow.from} – ${queryWindow.to})`;
    case "all-time":
      return `All time (${queryWindow.from} – ${queryWindow.to})`;
    case "custom":
      return `${customFrom} – ${customTo}`;
  }
}
