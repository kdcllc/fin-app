import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ValidationError,
  allTimeWindow,
  calendarYearWindow,
  formatCentsDecimal,
  formatPaymentsCsv,
  formatReportCsv,
  formatYearSheetCsv,
  getBillPayGridForYear,
  listPaymentsForReport,
  runReportQuery,
  trailing12Window,
  type ReportRow,
  type Repositories,
} from "../core";
import { exportReportCsv, type ExportReportCsvError } from "../report-csv";
import {
  exportReportPdf,
  type ExportReportPdfError,
  type ReportPdfSpec,
} from "../report-pdf";
import {
  buildPaymentsXlsxSpec,
  buildReportTableXlsxSpec,
  buildYearSheetXlsxSpec,
  exportReportXlsx,
  type ExportReportXlsxError,
  type ReportXlsxSpec,
} from "../report-xlsx";
import { buildChartOption, type ChartTheme } from "./report-charts";
import {
  buildReportFilter,
  buildReportPeriodLabel,
  paymentsDefaultFileName,
  reportPdfDefaultFileName,
  reportTableDefaultFileName,
  REPORT_TYPES,
  resolveQueryWindow,
  yearFromFilterTo,
  yearSheetDefaultFileName,
  type CategoryFilterSelection,
  type ReportTypeId,
  type WindowPreset,
} from "./reports-page-utils";

export type { ReportTypeId, WindowPreset } from "./reports-page-utils";

export interface ReportsPageProps {
  repos: Repositories;
  /** Injectable clock for tests — defaults to `new Date()`. */
  asOfDate?: Date;
  /** First-paint calendar year — defaults to the year of `asOfDate`. */
  initialYear?: number;
  pickSavePath?: (defaultPath: string) => Promise<string | null>;
  exportReportPdfFn?: (path: string, spec: ReportPdfSpec) => Promise<void>;
  exportReportCsvFn?: (path: string, content: string) => Promise<void>;
  exportReportXlsxFn?: (path: string, spec: ReportXlsxSpec) => Promise<void>;
}

function toUiErrorMessage(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function toCurrency(amountCents: number): string {
  const formatted = formatCentsDecimal(amountCents);
  if (formatted.startsWith("-")) {
    return `-$${formatted.slice(1)}`;
  }
  return `$${formatted}`;
}

function detectTheme(): ChartTheme {
  if (typeof window === "undefined") return "light";
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function decodeDataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const base64 = dataUrl.slice(comma + 1);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function captureChartPngBytes(chart: echarts.ECharts | null): number[] | null {
  if (!chart) return null;
  try {
    const dataUrl = chart.getDataURL({
      type: "png",
      pixelRatio: 1,
      backgroundColor: "#ffffff",
    });
    const bytes = decodeDataUrlToBytes(dataUrl);
    return bytes ? Array.from(bytes) : null;
  } catch {
    return null;
  }
}

function exportErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const typed = error as ExportReportPdfError | ExportReportCsvError | ExportReportXlsxError;
    if (typed.kind === "write_failed") {
      return `Could not write file to ${typed.path}: ${typed.message}`;
    }
    if (typed.kind === "invalid_chart_image") {
      return `Could not embed chart image: ${typed.message}`;
    }
    if (typed.kind === "build_failed") {
      return `Could not build export file: ${typed.message}`;
    }
  }
  return toUiErrorMessage(error);
}

async function pickExportPath(
  pickSavePath: ReportsPageProps["pickSavePath"],
  title: string,
  defaultPath: string,
  extensions: string[],
): Promise<string | null> {
  if (pickSavePath !== undefined) {
    return pickSavePath(defaultPath);
  }
  return (await save({
    title,
    defaultPath,
    filters: [{ name: extensions[0]?.toUpperCase() ?? "File", extensions }],
  })) as string | null;
}

export function ReportsPage({
  repos,
  asOfDate,
  initialYear,
  pickSavePath,
  exportReportPdfFn = exportReportPdf,
  exportReportCsvFn = exportReportCsv,
  exportReportXlsxFn = exportReportXlsx,
}: ReportsPageProps) {
  const asOf = useMemo(() => asOfDate ?? new Date(), [asOfDate]);
  const defaultYear = initialYear ?? asOf.getFullYear();

  const [windowPreset, setWindowPreset] = useState<WindowPreset>("calendar-year");
  const [calendarYear, setCalendarYear] = useState(defaultYear);
  const [customFrom, setCustomFrom] = useState(`${defaultYear}-01-01`);
  const [customTo, setCustomTo] = useState(`${defaultYear}-12-31`);
  const [accountIdText, setAccountIdText] = useState("");
  const [categorySelection, setCategorySelection] = useState<CategoryFilterSelection>("all");
  const [reportTypeId, setReportTypeId] = useState<ReportTypeId>("category-breakdown");

  const [accounts, setAccounts] = useState<Array<{ id: number; name: string; archived: boolean }>>(
    [],
  );
  const [categories, setCategories] = useState<
    Array<{ id: number; name: string; archived: boolean }>
  >([]);

  const [loadState, setLoadState] = useState<"loading" | "idle">("loading");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [emptyBook, setEmptyBook] = useState(false);
  const [theme, setTheme] = useState<ChartTheme>(detectTheme);
  const [exportState, setExportState] = useState<"idle" | "exporting">("idle");
  const [exportError, setExportError] = useState<string | null>(null);

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);

  const activeReport = useMemo(
    () => REPORT_TYPES.find((report) => report.id === reportTypeId) ?? REPORT_TYPES[0],
    [reportTypeId],
  );

  const resolveBaseWindow = useCallback(async (): Promise<{ from: string; to: string } | null> => {
    switch (windowPreset) {
      case "calendar-year":
        return calendarYearWindow(calendarYear);
      case "trailing-12":
        return trailing12Window(asOf);
      case "all-time":
        return allTimeWindow(repos);
      case "custom":
        return { from: customFrom, to: customTo };
    }
  }, [windowPreset, calendarYear, asOf, repos, customFrom, customTo]);

  const refreshReport = useCallback(async () => {
    setLoadState("loading");
    try {
      const baseWindow = await resolveBaseWindow();
      if (!baseWindow) {
        setRows([]);
        setEmptyBook(true);
        setError(null);
        return;
      }

      setEmptyBook(false);
      const queryWindow = resolveQueryWindow(reportTypeId, windowPreset, calendarYear, baseWindow);
      const filter = buildReportFilter(queryWindow, accountIdText, categorySelection);
      const result = await runReportQuery(repos, {
        dimension: activeReport.dimension,
        grain: activeReport.grain,
        filter,
      });
      setRows(result);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toUiErrorMessage(e));
    } finally {
      setLoadState("idle");
    }
  }, [
    resolveBaseWindow,
    reportTypeId,
    windowPreset,
    calendarYear,
    accountIdText,
    categorySelection,
    repos,
    activeReport.dimension,
    activeReport.grain,
  ]);

  useEffect(() => {
    void (async () => {
      try {
        const [nextAccounts, nextCategories] = await Promise.all([
          repos.accounts.list({ includeArchived: true }),
          repos.categories.list({ includeArchived: true }),
        ]);
        setAccounts(nextAccounts);
        setCategories(nextCategories);
      } catch (e) {
        setError(toUiErrorMessage(e));
        setLoadState("idle");
      }
    })();
  }, [repos]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void refreshReport();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [refreshReport]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setTheme(detectTheme());
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || loadState !== "idle" || error || emptyBook || rows.length === 0) {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
      return;
    }

    try {
      const chart = chartInstanceRef.current ?? echarts.init(container);
      chartInstanceRef.current = chart;
      chart.setOption(
        buildChartOption(
          rows,
          { dimension: activeReport.dimension, grain: activeReport.grain },
          theme,
        ),
        true,
      );
    } catch {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
    }

    return () => {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
    };
  }, [rows, theme, activeReport.dimension, activeReport.grain, loadState, error, emptyBook]);

  const showPeriodColumn = activeReport.grain === "month" || activeReport.grain === "year";

  const resolveExportContext = useCallback(async () => {
    const baseWindow = await resolveBaseWindow();
    if (!baseWindow) return null;

    const queryWindow = resolveQueryWindow(reportTypeId, windowPreset, calendarYear, baseWindow);
    const filter = buildReportFilter(queryWindow, accountIdText, categorySelection);
    const exportYear = yearFromFilterTo(queryWindow.to);
    return { queryWindow, filter, exportYear };
  }, [
    resolveBaseWindow,
    reportTypeId,
    windowPreset,
    calendarYear,
    accountIdText,
    categorySelection,
  ]);

  const runExport = useCallback(
    async (action: () => Promise<void>) => {
      setExportState("exporting");
      setExportError(null);
      try {
        await action();
      } catch (exportFailure) {
        setExportError(exportErrorMessage(exportFailure));
      } finally {
        setExportState("idle");
      }
    },
    [],
  );

  const handleExportPdf = useCallback(async () => {
    if (rows.length === 0 || loadState !== "idle" || error) return;

    const context = await resolveExportContext();
    if (!context) return;

    const { queryWindow } = context;
    const defaultPath = reportPdfDefaultFileName(reportTypeId, context.exportYear);
    const path = await pickExportPath(
      pickSavePath,
      "Export report as PDF",
      defaultPath,
      ["pdf"],
    );

    if (!path) return;

    const labelHeader = showPeriodColumn ? "Period" : "Group";
    const chartPngBytes = captureChartPngBytes(chartInstanceRef.current);
    const spec: ReportPdfSpec = {
      title: activeReport.label,
      periodLabel: buildReportPeriodLabel(
        windowPreset,
        calendarYear,
        customFrom,
        customTo,
        queryWindow,
      ),
      columnHeaders: [labelHeader, "Total", "Count"],
      tableRows: rows.map((row) => ({
        label: showPeriodColumn ? row.periodKey : row.groupLabel,
        totalCents: row.total_cents,
        count: row.count,
      })),
      ...(chartPngBytes ? { chartPngBytes } : {}),
    };

    await runExport(() => exportReportPdfFn(path, spec));
  }, [
    rows,
    loadState,
    error,
    resolveExportContext,
    reportTypeId,
    pickSavePath,
    showPeriodColumn,
    activeReport.label,
    windowPreset,
    calendarYear,
    customFrom,
    customTo,
    exportReportPdfFn,
    runExport,
  ]);

  const handleExportReportTableXlsx = useCallback(async () => {
    if (rows.length === 0 || loadState !== "idle" || error) return;

    const context = await resolveExportContext();
    if (!context) return;

    const defaultPath = reportTableDefaultFileName(reportTypeId, context.exportYear, "xlsx");
    const path = await pickExportPath(
      pickSavePath,
      "Export report table as Excel",
      defaultPath,
      ["xlsx"],
    );
    if (!path) return;

    const spec = buildReportTableXlsxSpec(rows, showPeriodColumn);
    await runExport(() => exportReportXlsxFn(path, spec));
  }, [
    rows,
    loadState,
    error,
    resolveExportContext,
    reportTypeId,
    pickSavePath,
    showPeriodColumn,
    exportReportXlsxFn,
    runExport,
  ]);

  const handleExportReportTableCsv = useCallback(async () => {
    if (rows.length === 0 || loadState !== "idle" || error) return;

    const context = await resolveExportContext();
    if (!context) return;

    const defaultPath = reportTableDefaultFileName(reportTypeId, context.exportYear, "csv");
    const path = await pickExportPath(
      pickSavePath,
      "Export report table as CSV",
      defaultPath,
      ["csv"],
    );
    if (!path) return;

    await runExport(() => exportReportCsvFn(path, formatReportCsv(rows)));
  }, [
    rows,
    loadState,
    error,
    resolveExportContext,
    reportTypeId,
    pickSavePath,
    exportReportCsvFn,
    runExport,
  ]);

  const handleExportPaymentsXlsx = useCallback(async () => {
    if (loadState !== "idle" || error || emptyBook) return;

    const context = await resolveExportContext();
    if (!context) return;

    const defaultPath = paymentsDefaultFileName(context.exportYear, "xlsx");
    const path = await pickExportPath(
      pickSavePath,
      "Export raw payments as Excel",
      defaultPath,
      ["xlsx"],
    );
    if (!path) return;

    const payments = await listPaymentsForReport(repos, context.filter);
    const spec = buildPaymentsXlsxSpec(payments);
    await runExport(() => exportReportXlsxFn(path, spec));
  }, [
    loadState,
    error,
    emptyBook,
    resolveExportContext,
    pickSavePath,
    repos,
    exportReportXlsxFn,
    runExport,
  ]);

  const handleExportPaymentsCsv = useCallback(async () => {
    if (loadState !== "idle" || error || emptyBook) return;

    const context = await resolveExportContext();
    if (!context) return;

    const defaultPath = paymentsDefaultFileName(context.exportYear, "csv");
    const path = await pickExportPath(
      pickSavePath,
      "Export raw payments as CSV",
      defaultPath,
      ["csv"],
    );
    if (!path) return;

    const payments = await listPaymentsForReport(repos, context.filter);
    await runExport(() => exportReportCsvFn(path, formatPaymentsCsv(payments)));
  }, [
    loadState,
    error,
    emptyBook,
    resolveExportContext,
    pickSavePath,
    repos,
    exportReportCsvFn,
    runExport,
  ]);

  const handleExportYearSheetXlsx = useCallback(async () => {
    if (loadState !== "idle" || error || emptyBook) return;

    const context = await resolveExportContext();
    if (!context) return;

    const defaultPath = yearSheetDefaultFileName(context.exportYear, "xlsx");
    const path = await pickExportPath(
      pickSavePath,
      "Export year sheet as Excel",
      defaultPath,
      ["xlsx"],
    );
    if (!path) return;

    const grid = await getBillPayGridForYear(repos, context.exportYear);
    const spec = buildYearSheetXlsxSpec(grid);
    await runExport(() => exportReportXlsxFn(path, spec));
  }, [
    loadState,
    error,
    emptyBook,
    resolveExportContext,
    pickSavePath,
    repos,
    exportReportXlsxFn,
    runExport,
  ]);

  const handleExportYearSheetCsv = useCallback(async () => {
    if (loadState !== "idle" || error || emptyBook) return;

    const context = await resolveExportContext();
    if (!context) return;

    const defaultPath = yearSheetDefaultFileName(context.exportYear, "csv");
    const path = await pickExportPath(
      pickSavePath,
      "Export year sheet as CSV",
      defaultPath,
      ["csv"],
    );
    if (!path) return;

    const grid = await getBillPayGridForYear(repos, context.exportYear);
    await runExport(() => exportReportCsvFn(path, formatYearSheetCsv(grid)));
  }, [
    loadState,
    error,
    emptyBook,
    resolveExportContext,
    pickSavePath,
    repos,
    exportReportCsvFn,
    runExport,
  ]);

  const exportBusy = exportState === "exporting";
  const reportTableExportDisabled =
    loadState !== "idle" || !!error || emptyBook || rows.length === 0 || exportBusy;
  const tabularExportDisabled = loadState !== "idle" || !!error || emptyBook || exportBusy;

  return (
    <section className="page reports-page">
      <header className="payments-header">
        <div>
          <h1>Reports</h1>
          <p className="muted">Spending summaries with charts and data tables.</p>
        </div>
        <div className="reports-export-actions">
          <button
            type="button"
            className="primary"
            aria-label="Export PDF"
            disabled={reportTableExportDisabled}
            onClick={() => void handleExportPdf()}
          >
            {exportBusy ? "Exporting…" : "Export PDF"}
          </button>
          <button
            type="button"
            data-testid="export-report-table-xlsx"
            aria-label="Export report table as Excel"
            disabled={reportTableExportDisabled}
            onClick={() => void handleExportReportTableXlsx()}
          >
            Export report table (.xlsx)
          </button>
          <button
            type="button"
            data-testid="export-report-table-csv"
            aria-label="Export report table as CSV"
            disabled={reportTableExportDisabled}
            onClick={() => void handleExportReportTableCsv()}
          >
            Export report table (.csv)
          </button>
          <button
            type="button"
            data-testid="export-payments-xlsx"
            aria-label="Export raw payments as Excel"
            disabled={tabularExportDisabled}
            onClick={() => void handleExportPaymentsXlsx()}
          >
            Export raw payments (.xlsx)
          </button>
          <button
            type="button"
            data-testid="export-payments-csv"
            aria-label="Export raw payments as CSV"
            disabled={tabularExportDisabled}
            onClick={() => void handleExportPaymentsCsv()}
          >
            Export raw payments (.csv)
          </button>
          <button
            type="button"
            data-testid="export-year-sheet-xlsx"
            aria-label="Year sheet (full year, ignores account/category filters) as Excel"
            disabled={tabularExportDisabled}
            onClick={() => void handleExportYearSheetXlsx()}
          >
            Year sheet (full year, ignores account/category filters) (.xlsx)
          </button>
          <button
            type="button"
            data-testid="export-year-sheet-csv"
            aria-label="Year sheet (full year, ignores account/category filters) as CSV"
            disabled={tabularExportDisabled}
            onClick={() => void handleExportYearSheetCsv()}
          >
            Year sheet (full year, ignores account/category filters) (.csv)
          </button>
        </div>
      </header>

      <div className="reports-filters" aria-label="Report filters">
        <label className="field">
          Report type
          <select
            aria-label="Report type"
            value={reportTypeId}
            onChange={(event) => setReportTypeId(event.currentTarget.value as ReportTypeId)}
          >
            {REPORT_TYPES.map((report) => (
              <option key={report.id} value={report.id}>
                {report.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Window preset
          <select
            aria-label="Window preset"
            value={windowPreset}
            onChange={(event) => setWindowPreset(event.currentTarget.value as WindowPreset)}
          >
            <option value="calendar-year">Calendar year</option>
            <option value="trailing-12">Trailing 12 months</option>
            <option value="all-time">All time</option>
            <option value="custom">Custom from/to</option>
          </select>
        </label>

        {windowPreset === "calendar-year" && (
          <label className="field">
            Calendar year
            <input
              aria-label="Calendar year"
              inputMode="numeric"
              value={String(calendarYear)}
              onChange={(event) => {
                const next = Number.parseInt(event.currentTarget.value, 10);
                if (Number.isInteger(next)) setCalendarYear(next);
              }}
            />
          </label>
        )}

        {windowPreset === "custom" && (
          <>
            <label className="field">
              From
              <input
                aria-label="Custom from date"
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.currentTarget.value)}
              />
            </label>
            <label className="field">
              To
              <input
                aria-label="Custom to date"
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.currentTarget.value)}
              />
            </label>
          </>
        )}

        <label className="field">
          Account
          <select
            aria-label="Account filter"
            value={accountIdText}
            onChange={(event) => setAccountIdText(event.currentTarget.value)}
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={String(account.id)}>
                {account.name}
                {account.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Category
          <select
            aria-label="Category filter"
            value={
              categorySelection === "all"
                ? ""
                : categorySelection === "uncategorized"
                  ? "__uncategorized__"
                  : String(categorySelection)
            }
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (value === "") {
                setCategorySelection("all");
              } else if (value === "__uncategorized__") {
                setCategorySelection("uncategorized");
              } else {
                setCategorySelection(Number.parseInt(value, 10));
              }
            }}
          >
            <option value="">All categories</option>
            <option value="__uncategorized__">Uncategorized</option>
            {categories.map((category) => (
              <option key={category.id} value={String(category.id)}>
                {category.name}
                {category.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {exportError && <p className="error">{exportError}</p>}
      {loadState === "loading" && <p className="muted">Loading report…</p>}

      {loadState === "idle" && !error && (emptyBook || rows.length === 0) && (
        <p className="muted">No payments match the current filters for this period.</p>
      )}

      {loadState === "idle" && !error && !emptyBook && rows.length > 0 && (
        <>
          <div
            ref={chartContainerRef}
            className="reports-chart"
            aria-label={`${activeReport.label} chart`}
            role="img"
          />
          <table className="entity-table reports-table">
            <thead>
              <tr>
                <th>{showPeriodColumn ? "Period" : "Group"}</th>
                <th>Total</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = showPeriodColumn
                  ? row.periodKey
                  : `${row.groupKey ?? "null"}|${row.groupLabel}`;
                const label = showPeriodColumn ? row.periodKey : row.groupLabel;
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td className="amount-cell">{toCurrency(row.total_cents)}</td>
                    <td>{row.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
