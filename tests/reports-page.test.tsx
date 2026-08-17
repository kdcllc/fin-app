// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const getDataUrlMock = vi.fn(() => "data:image/png;base64,AA==");

vi.mock("echarts", () => ({
  init: vi.fn(() => ({
    setOption: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
    getDataURL: getDataUrlMock,
  })),
}));

const exportReportPdfMock = vi.fn(async () => undefined);
const exportReportCsvMock = vi.fn(async () => undefined);
const exportReportXlsxMock = vi.fn(async () => undefined);
const pickSavePathMock = vi.fn(async () => null as string | null);

import * as core from "../src/core";
import { ReportsPage } from "../src/pages/ReportsPage";
import { REPORT_TYPES, resolveQueryWindow } from "../src/pages/reports-page-utils";
import {
  REPORT_FIXTURE_ALL_TIME,
  seedReportingFixture,
} from "./support/report-fixture";
import { openTestDb, type TestDb } from "./support/test-db";

const AS_OF = new Date(2026, 7, 16);

describe("resolveQueryWindow", () => {
  it("expands YoY only for calendar-year preset", () => {
    expect(
      resolveQueryWindow("year-over-year", "calendar-year", 2026, {
        from: "2026-01-01",
        to: "2026-12-31",
      }),
    ).toEqual({ from: "2025-01-01", to: "2026-12-31" });

    const trailing = core.trailing12Window(AS_OF);
    expect(
      resolveQueryWindow("year-over-year", "trailing-12", 2026, trailing),
    ).toEqual(trailing);
  });
});

describe("ReportsPage", () => {
  let fixtureDb: TestDb | null = null;
  let runReportQuerySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fixtureDb = openTestDb();
    runReportQuerySpy = vi.spyOn(core, "runReportQuery");
    exportReportPdfMock.mockClear();
    exportReportCsvMock.mockClear();
    exportReportXlsxMock.mockClear();
    pickSavePathMock.mockClear();
    getDataUrlMock.mockClear();
  });

  afterEach(() => {
    runReportQuerySpy.mockRestore();
    fixtureDb?.close();
    fixtureDb = null;
    cleanup();
  });

  async function seedFixtureBook(options?: { withArchivedEntities?: boolean }) {
    if (!fixtureDb) throw new Error("fixture db not available");
    return seedReportingFixture(fixtureDb, options);
  }

  it("first paint uses the current calendar year window", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);

    await screen.findByRole("heading", { level: 1, name: "Reports" });
    await screen.findByLabelText("Calendar year");

    expect(screen.getByLabelText("Calendar year")).toHaveProperty("value", "2026");
    await screen.findByText("No payments match the current filters for this period.");

    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        dimension: "category",
        grain: "all",
        filter: expect.objectContaining({ from: "2026-01-01", to: "2026-12-31" }),
      }),
    );
  });

  it("renders table cents from query results for each report type", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const user = userEvent.setup();
    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);

    await screen.findByRole("heading", { level: 1, name: "Reports" });
    await screen.findByText("$108.00");

    const reportTypeSpecs = {
      "category-breakdown": { dimension: "category", grain: "all" },
      "payee-ranking": { dimension: "payee", grain: "all" },
      "spend-trend": { dimension: "total", grain: "month" },
      "year-over-year": { dimension: "total", grain: "year" },
      "account-usage": { dimension: "account", grain: "all" },
    } as const;

    for (const report of REPORT_TYPES) {
      await user.selectOptions(screen.getByLabelText("Report type"), report.id);
      await screen.findByRole("table");

      expect(runReportQuerySpy).toHaveBeenCalledWith(
        fixtureDb.repos,
        expect.objectContaining(reportTypeSpecs[report.id]),
      );

      const result = runReportQuerySpy.mock.results.at(-1);
      if (!result) throw new Error("missing runReportQuery result");
      const rows = await result.value;
      if (!rows) throw new Error("runReportQuery returned nothing");

      const table = screen.getByRole("table");
      for (const row of rows) {
        const label =
          report.grain === "month" || report.grain === "year" ? row.periodKey : row.groupLabel;
        if (label.length === 0) continue;
        const tableRow = within(table).getByText(label).closest("tr");
        if (!tableRow) throw new Error(`missing table row for ${label}`);
        const dollars = row.total_cents < 0 ? "-$" : "$";
        const abs = Math.abs(row.total_cents);
        const formatted = `${dollars}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
        expect(within(tableRow).getByText(formatted)).toBeTruthy();
      }
    }
  });

  it("applies all four window presets for non-YoY reports", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const user = userEvent.setup();
    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);
    await screen.findByRole("heading", { level: 1, name: "Reports" });

    runReportQuerySpy.mockClear();

    await user.selectOptions(screen.getByLabelText("Window preset"), "trailing-12");
    await screen.findByRole("table");
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining(core.trailing12Window(AS_OF)),
      }),
    );

    runReportQuerySpy.mockClear();
    await user.selectOptions(screen.getByLabelText("Window preset"), "all-time");
    await screen.findByRole("table");
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining(REPORT_FIXTURE_ALL_TIME),
      }),
    );

    runReportQuerySpy.mockClear();
    await user.selectOptions(screen.getByLabelText("Window preset"), "custom");
    fireEvent.change(screen.getByLabelText("Custom from date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("Custom to date"), {
      target: { value: "2026-01-31" },
    });
    await screen.findByRole("table");
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining({ from: "2026-01-01", to: "2026-01-31" }),
      }),
    );

    runReportQuerySpy.mockClear();
    await user.selectOptions(screen.getByLabelText("Window preset"), "calendar-year");
    await screen.findByRole("table");
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining({ from: "2026-01-01", to: "2026-12-31" }),
      }),
    );
  });

  it("expands YoY for calendar year 2026 but not for trailing 12", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const user = userEvent.setup();
    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);
    await screen.findByRole("heading", { level: 1, name: "Reports" });

    await user.selectOptions(screen.getByLabelText("Report type"), "year-over-year");
    await screen.findByRole("table");

    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        dimension: "total",
        grain: "year",
        filter: expect.objectContaining({ from: "2025-01-01", to: "2026-12-31" }),
      }),
    );

    runReportQuerySpy.mockClear();
    await user.selectOptions(screen.getByLabelText("Window preset"), "trailing-12");
    await screen.findByRole("table");

    const trailing = core.trailing12Window(AS_OF);
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining(trailing),
      }),
    );
    expect(runReportQuerySpy).not.toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining({ from: "2025-01-01", to: "2026-12-31" }),
      }),
    );
  });

  it("includes archived entities and applies account/category filters", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    const ids = await seedFixtureBook({ withArchivedEntities: true });

    const user = userEvent.setup();
    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);
    await screen.findByRole("heading", { level: 1, name: "Reports" });

    const accountSelect = screen.getByLabelText("Account filter");
    expect(within(accountSelect).getByRole("option", { name: "Old Savings (archived)" })).toBeTruthy();

    const categorySelect = screen.getByLabelText("Category filter");
    expect(within(categorySelect).getByRole("option", { name: "Legacy (archived)" })).toBeTruthy();
    expect(within(categorySelect).getByRole("option", { name: "Uncategorized" })).toBeTruthy();

    runReportQuerySpy.mockClear();
    await user.selectOptions(accountSelect, String(ids.checkingId));
    await screen.findByRole("table");
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining({ accountId: ids.checkingId }),
      }),
    );

    runReportQuerySpy.mockClear();
    await user.selectOptions(categorySelect, "__uncategorized__");
    await screen.findByRole("table");
    expect(runReportQuerySpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({
        filter: expect.objectContaining({ categoryId: null }),
      }),
    );
  });

  it("shows empty state and validation errors", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    const user = userEvent.setup();
    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);
    await screen.findByText("No payments match the current filters for this period.");

    await user.selectOptions(screen.getByLabelText("Window preset"), "custom");
    fireEvent.change(screen.getByLabelText("Custom from date"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.change(screen.getByLabelText("Custom to date"), {
      target: { value: "2026-01-01" },
    });

    await screen.findByText("Start date must be on or before end date.");
  });

  it("shows validation error for malformed custom dates", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    const user = userEvent.setup();
    render(<ReportsPage repos={fixtureDb.repos} asOfDate={AS_OF} initialYear={2026} />);
    await screen.findByText("No payments match the current filters for this period.");

    await user.selectOptions(screen.getByLabelText("Window preset"), "custom");
    fireEvent.change(screen.getByLabelText("Custom from date"), {
      target: { value: "2026-13-01" },
    });
    fireEvent.change(screen.getByLabelText("Custom to date"), {
      target: { value: "2026-12-31" },
    });

    await screen.findByText("Invalid date range.");
  });

  function uniqueExportPath(extension: string): string {
    return path.join(
      os.tmpdir(),
      `fin-app-report-export-${Date.now()}-${process.pid}.${extension}`,
    );
  }

  function renderWithExportMocks() {
    return render(
      <ReportsPage
        repos={fixtureDb!.repos}
        asOfDate={AS_OF}
        initialYear={2026}
        pickSavePath={pickSavePathMock}
        exportReportPdfFn={exportReportPdfMock}
        exportReportCsvFn={exportReportCsvMock}
        exportReportXlsxFn={exportReportXlsxMock}
      />,
    );
  }

  it("renders all six tabular export controls", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    renderWithExportMocks();
    await screen.findByText("$108.00");

    expect(screen.getByTestId("export-report-table-xlsx")).toBeTruthy();
    expect(screen.getByTestId("export-report-table-csv")).toBeTruthy();
    expect(screen.getByTestId("export-payments-xlsx")).toBeTruthy();
    expect(screen.getByTestId("export-payments-csv")).toBeTruthy();
    expect(screen.getByTestId("export-year-sheet-xlsx")).toBeTruthy();
    expect(screen.getByTestId("export-year-sheet-csv")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Year sheet (full year, ignores account/category filters) as Excel",
      ),
    ).toBeTruthy();
  });

  it("exports PDF with integer cents from the current query result", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const exportPath = uniqueExportPath("pdf");
    pickSavePathMock.mockResolvedValueOnce(exportPath);

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-report-category-2026.pdf");
    expect(exportReportPdfMock).toHaveBeenCalledTimes(1);

    const [pathArg, specArg] = exportReportPdfMock.mock.calls[0] ?? [];
    expect(pathArg).toBe(exportPath);
    expect(specArg.title).toBe("Where the money goes");
    expect(specArg.periodLabel).toBe("Calendar year 2026");
    expect(specArg.tableRows.length).toBeGreaterThan(0);
    for (const row of specArg.tableRows) {
      expect(Number.isInteger(row.totalCents)).toBe(true);
      expect(Number.isInteger(row.count)).toBe(true);
    }

    const result = runReportQuerySpy.mock.results.at(-1);
    if (!result) throw new Error("missing runReportQuery result");
    const queryRows = await result.value;
    if (!queryRows) throw new Error("runReportQuery returned nothing");
    expect(specArg.tableRows.map((row: { totalCents: number }) => row.totalCents)).toEqual(
      queryRows.map((row) => row.total_cents),
    );
  });

  it("exports report table xlsx with current filters and query rows", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const exportPath = uniqueExportPath("xlsx");
    pickSavePathMock.mockResolvedValueOnce(exportPath);

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.click(screen.getByTestId("export-report-table-xlsx"));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-report-category-2026.xlsx");
    expect(exportReportXlsxMock).toHaveBeenCalledTimes(1);

    const [pathArg, specArg] = exportReportXlsxMock.mock.calls[0] ?? [];
    expect(pathArg).toBe(exportPath);
    expect(specArg.headers).toEqual(["Group", "Total", "Count"]);
    expect(specArg.rows.length).toBeGreaterThan(0);

    const result = runReportQuerySpy.mock.results.at(-1);
    if (!result) throw new Error("missing runReportQuery result");
    const queryRows = await result.value;
    if (!queryRows) throw new Error("runReportQuery returned nothing");
    expect(
      specArg.rows.map((row: { cells: Array<{ amountCents?: number }> }) => row.cells[1]?.amountCents),
    ).toEqual(queryRows.map((row) => row.total_cents));
  });

  it("exports report table csv using formatReportCsv content", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const exportPath = uniqueExportPath("csv");
    pickSavePathMock.mockResolvedValueOnce(exportPath);

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.click(screen.getByTestId("export-report-table-csv"));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-report-category-2026.csv");
    expect(exportReportCsvMock).toHaveBeenCalledTimes(1);

    const [pathArg, contentArg] = exportReportCsvMock.mock.calls[0] ?? [];
    expect(pathArg).toBe(exportPath);
    expect(contentArg.startsWith("\uFEFF")).toBe(true);
    expect(contentArg).toContain("108.00");
  });

  it("exports raw payments csv from listPaymentsForReport with current filters", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const exportPath = uniqueExportPath("csv");
    pickSavePathMock.mockResolvedValueOnce(exportPath);
    const listPaymentsSpy = vi.spyOn(core, "listPaymentsForReport");

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.click(screen.getByTestId("export-payments-csv"));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-payments-2026.csv");
    expect(listPaymentsSpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({ from: "2026-01-01", to: "2026-12-31" }),
    );
    expect(exportReportCsvMock).toHaveBeenCalledTimes(1);

    const [pathArg, contentArg] = exportReportCsvMock.mock.calls[0] ?? [];
    expect(pathArg).toBe(exportPath);
    expect(contentArg.startsWith("\uFEFF")).toBe(true);
    expect(contentArg).toContain("75.00");
    expect(contentArg).toContain("12.00");

    listPaymentsSpy.mockRestore();
  });

  it("exports raw payments xlsx from listPaymentsForReport with current filters", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    const ids = await seedFixtureBook();

    const exportPath = uniqueExportPath("xlsx");
    pickSavePathMock.mockResolvedValueOnce(exportPath);
    const listPaymentsSpy = vi.spyOn(core, "listPaymentsForReport");

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.selectOptions(screen.getByLabelText("Category filter"), "__uncategorized__");
    await screen.findByRole("table");

    await user.click(screen.getByTestId("export-payments-xlsx"));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-payments-2026.xlsx");
    expect(listPaymentsSpy).toHaveBeenCalledWith(
      fixtureDb.repos,
      expect.objectContaining({ categoryId: null }),
    );
    expect(exportReportXlsxMock).toHaveBeenCalledTimes(1);

    const dump = await listPaymentsSpy.mock.results.at(-1)?.value;
    const [, specArg] = exportReportXlsxMock.mock.calls[0] ?? [];
    expect(specArg.rows).toHaveLength(dump.length);
    for (const row of dump) {
      expect(row.category_id).toBeNull();
    }

    listPaymentsSpy.mockRestore();
  });

  it("exports year sheet csv without passing account or category filters", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    const ids = await seedFixtureBook();

    const exportPath = uniqueExportPath("csv");
    pickSavePathMock.mockResolvedValueOnce(exportPath);
    const gridSpy = vi.spyOn(core, "getBillPayGridForYear");

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.selectOptions(screen.getByLabelText("Account filter"), String(ids.checkingId));
    await user.selectOptions(screen.getByLabelText("Category filter"), "__uncategorized__");
    await screen.findByRole("table");

    await user.click(screen.getByTestId("export-year-sheet-csv"));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-year-2026.csv");
    expect(gridSpy).toHaveBeenCalledWith(fixtureDb.repos, 2026);
    expect(gridSpy.mock.calls.every((call) => call.length === 2)).toBe(true);
    expect(exportReportCsvMock).toHaveBeenCalledTimes(1);

    const [, contentArg] = exportReportCsvMock.mock.calls[0] ?? [];
    expect(contentArg.startsWith("\uFEFF")).toBe(true);

    gridSpy.mockRestore();
  });

  it("exports year sheet xlsx without passing account or category filters", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    const ids = await seedFixtureBook();

    const exportPath = uniqueExportPath("xlsx");
    pickSavePathMock.mockResolvedValueOnce(exportPath);
    const gridSpy = vi.spyOn(core, "getBillPayGridForYear");

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.selectOptions(screen.getByLabelText("Account filter"), String(ids.checkingId));
    await user.selectOptions(screen.getByLabelText("Category filter"), "__uncategorized__");
    await screen.findByRole("table");

    await user.click(screen.getByTestId("export-year-sheet-xlsx"));

    expect(pickSavePathMock).toHaveBeenCalledWith("fin-year-2026.xlsx");
    expect(gridSpy).toHaveBeenCalledWith(fixtureDb.repos, 2026);
    expect(gridSpy.mock.calls.every((call) => call.length === 2)).toBe(true);
    expect(exportReportXlsxMock).toHaveBeenCalledTimes(1);

    const [pathArg] = exportReportXlsxMock.mock.calls[0] ?? [];
    expect(pathArg).toBe(exportPath);

    gridSpy.mockRestore();
  });

  it("does not export when the save dialog is cancelled", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const exportPath = uniqueExportPath("pdf");
    pickSavePathMock.mockResolvedValueOnce(null);

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(exportReportPdfMock).not.toHaveBeenCalled();
    expect(exportReportXlsxMock).not.toHaveBeenCalled();
    expect(exportReportCsvMock).not.toHaveBeenCalled();
    expect(fs.existsSync(exportPath)).toBe(false);
  });

  it("shows a user-facing message when tabular export I/O fails", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    await seedFixtureBook();

    const exportPath = uniqueExportPath("csv");
    pickSavePathMock.mockResolvedValueOnce(exportPath);
    exportReportCsvMock.mockRejectedValueOnce({
      kind: "write_failed",
      path: exportPath,
      message: "permission denied",
    });

    const user = userEvent.setup();
    renderWithExportMocks();

    await screen.findByText("$108.00");
    await user.click(screen.getByTestId("export-report-table-csv"));

    await screen.findByText(`Could not write file to ${exportPath}: permission denied`);
  });
});
