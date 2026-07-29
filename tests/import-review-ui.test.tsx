// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportPage } from "../src/pages/ImportPage";
import type { Repositories } from "../src/core";
import type { RawWorkbookPayload } from "../src/xlsx-reader";
import { openTestDb, type TestDb } from "./support/test-db";

const readWorkbookMock = vi.fn();
const pickWorkbookPathMock = vi.fn(async () => "/tmp/fixture.xlsx");
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "./fixtures/excel");

function loadWorkbookFixture(fileName: string): RawWorkbookPayload {
  const path = resolve(FIXTURES_DIR, fileName);
  return JSON.parse(readFileSync(path, "utf8")) as RawWorkbookPayload;
}

function reposWithInjectedCommitFailure(baseRepos: Repositories): Repositories {
  return {
    ...baseRepos,
    withTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
      return baseRepos.withTransaction(async (txRepos) => {
        let insertCount = 0;
        const wrappedTx: Repositories = {
          ...txRepos,
          payments: {
            ...txRepos.payments,
            async insert(input) {
              const inserted = await txRepos.payments.insert(input);
              insertCount += 1;
              if (insertCount >= 1) {
                throw new Error("injected failure after payment insert");
              }
              return inserted;
            },
          },
        };

        return work(wrappedTx);
      });
    },
  };
}

describe("import review UI", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = openTestDb();
    readWorkbookMock.mockReset();
    pickWorkbookPathMock.mockClear();

    const payee = await t.repos.payees.insert({ name: "Power Co" });
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const category = await t.repos.categories.insert({ name: "utilities" });

    await t.repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      category_id: category.id,
      date: "2026-01-08",
      amount_cents: 4858,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 2,
      source_col: 9,
      occurrence_index: 1,
    });

    readWorkbookMock.mockResolvedValue({
      fileSha256: "file-hash-review-default",
      sheets: [
        {
          name: "2026",
          rows: [
            ["Payee", "Jan", "Feb"],
            ["Power Co", "01/08 $48.58", "not-parseable"],
          ],
          nonEmptyCells: [
            { row: 1, col: 1, value: "Payee" },
            { row: 1, col: 2, value: "Jan" },
            { row: 1, col: 3, value: "Feb" },
            { row: 2, col: 1, value: "Power Co" },
            { row: 2, col: 2, value: "01/08 $48.58" },
            { row: 2, col: 3, value: "not-parseable" },
          ],
        },
      ],
      warnings: [],
    });
  });

  afterEach(() => {
    cleanup();
    t.close();
  });

  async function tableCount(name: string): Promise<number> {
    const rows = await t.db.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`);
    return rows[0].count;
  }

  it("disables commit until unparsed cells are resolved and potential duplicate decisions are made, without pre-commit writes", async () => {
    const user = userEvent.setup();
    render(
      <ImportPage
        repos={t.repos}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />, 
    );

    const countsBefore = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      categories: await tableCount("categories"),
      payments: await tableCount("payments"),
      importLog: await tableCount("import_log"),
    };

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));

    await screen.findByText(/unparsed cell\(s\) must be fixed or skipped/i);
    await screen.findByText(/potential duplicate row\(s\) require keep\/skip decisions/i);

    const commitButton = screen.getByRole("button", { name: "Commit import" });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);

    await waitFor(async () => {
      expect(await tableCount("payees")).toBe(countsBefore.payees);
      expect(await tableCount("accounts")).toBe(countsBefore.accounts);
      expect(await tableCount("categories")).toBe(countsBefore.categories);
      expect(await tableCount("payments")).toBe(countsBefore.payments);
      expect(await tableCount("import_log")).toBe(countsBefore.importLog);
    });

    await user.click(screen.getByRole("button", { name: "Skip cell" }));
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);

    const duplicateDecision = screen.getByRole("combobox");
    await user.selectOptions(duplicateDecision, "keep");

    await waitFor(() => {
      expect((commitButton as HTMLButtonElement).disabled).toBe(false);
    });

    await waitFor(async () => {
      expect(await tableCount("payees")).toBe(countsBefore.payees);
      expect(await tableCount("accounts")).toBe(countsBefore.accounts);
      expect(await tableCount("categories")).toBe(countsBefore.categories);
      expect(await tableCount("payments")).toBe(countsBefore.payments);
      expect(await tableCount("import_log")).toBe(countsBefore.importLog);
    });
  });

  it("surfaces non-empty cells with missing payee labels as unresolved review items with coordinates", async () => {
    readWorkbookMock.mockResolvedValue({
      fileSha256: "file-hash-missing-payee",
      sheets: [
        {
          name: "2026",
          rows: [
            ["Payee", "Jan", "Feb"],
            ["Water Co", "01/09 $10", ""],
            ["", "", "02/09 $11"],
          ],
          nonEmptyCells: [
            { row: 1, col: 1, value: "Payee" },
            { row: 1, col: 2, value: "Jan" },
            { row: 1, col: 3, value: "Feb" },
            { row: 2, col: 1, value: "Water Co" },
            { row: 2, col: 2, value: "01/09 $10" },
            { row: 3, col: 3, value: "02/09 $11" },
          ],
        },
      ],
      warnings: [],
    });

    const user = userEvent.setup();
    render(
      <ImportPage
        repos={t.repos}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));

    await screen.findByText("2026!R3C3");
    await screen.findByText(/Missing payee label for non-empty payment cell/i);

    const commitButton = screen.getByRole("button", { name: "Commit import" });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Skip cell" }));

    await waitFor(() => {
      expect((commitButton as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("runs fixture-based happy path: choose file, resolve gates, commit, and persist payments", async () => {
    readWorkbookMock.mockResolvedValue(loadWorkbookFixture("import-review-ui-happy-path.json"));

    const user = userEvent.setup();
    render(
      <ImportPage
        repos={t.repos}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));

    await screen.findByText(/unparsed cell\(s\) must be fixed or skipped/i);
    await screen.findByText(/potential duplicate row\(s\) require keep\/skip decisions/i);

    const commitButton = screen.getByRole("button", { name: "Commit import" });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Skip cell" }));
    await user.selectOptions(screen.getByRole("combobox"), "skip");

    await waitFor(() => {
      expect((commitButton as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(commitButton);

    await screen.findByText(/Imported 1 rows \(0 exact duplicates skipped, 1 potential duplicates skipped\)/i);

    const payments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(payments).toHaveLength(2);
    expect(
      payments.some(
        (payment) =>
          payment.date === "2026-02-09" &&
          payment.amount_cents === 4899 &&
          payment.source_sheet === "2026" &&
          payment.source_row === 2 &&
          payment.source_col === 3,
      ),
    ).toBe(true);

    const logs = await t.repos.importLog.list();
    expect(logs).toHaveLength(1);
    expect(logs[0].row_count).toBe(2);
  });

  it("rolls back atomically on injected commit failure (no payment or import_log writes)", async () => {
    readWorkbookMock.mockResolvedValue(loadWorkbookFixture("import-review-ui-happy-path.json"));

    const countsBefore = {
      payees: await tableCount("payees"),
      accounts: await tableCount("accounts"),
      categories: await tableCount("categories"),
      payments: await tableCount("payments"),
      importLog: await tableCount("import_log"),
    };

    const user = userEvent.setup();
    render(
      <ImportPage
        repos={reposWithInjectedCommitFailure(t.repos)}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));
    await screen.findByText(/unparsed cell\(s\) must be fixed or skipped/i);
    await screen.findByText(/potential duplicate row\(s\) require keep\/skip decisions/i);

    await user.click(screen.getByRole("button", { name: "Skip cell" }));
    await user.selectOptions(screen.getByRole("combobox"), "keep");

    const commitButton = screen.getByRole("button", { name: "Commit import" });
    await waitFor(() => {
      expect((commitButton as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(commitButton);
    await screen.findByText(/injected failure after payment insert/i);

    await waitFor(async () => {
      expect(await tableCount("payees")).toBe(countsBefore.payees);
      expect(await tableCount("accounts")).toBe(countsBefore.accounts);
      expect(await tableCount("categories")).toBe(countsBefore.categories);
      expect(await tableCount("payments")).toBe(countsBefore.payments);
      expect(await tableCount("import_log")).toBe(countsBefore.importLog);
    });
  });

  it("shows warning when workbook content hash was previously imported", async () => {
    const workbookPayload: RawWorkbookPayload = {
      fileSha256: "file-hash-previously-imported",
      sheets: [
        {
          name: "2026",
          rows: [
            ["Payee", "Jan"],
            ["Power Co", "01/08 $48.58"],
          ],
          nonEmptyCells: [
            { row: 1, col: 1, value: "Payee" },
            { row: 1, col: 2, value: "Jan" },
            { row: 2, col: 1, value: "Power Co" },
            { row: 2, col: 2, value: "01/08 $48.58" },
          ],
        },
      ],
      warnings: [],
    };

    await t.repos.importLog.append({
      source_file: "/tmp/previous.xlsx",
      content_hash: workbookPayload.fileSha256,
      row_count: 1,
    });

    readWorkbookMock.mockResolvedValue(workbookPayload);
    const user = userEvent.setup();

    render(
      <ImportPage
        repos={t.repos}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));

    await screen.findByText(/exact workbook file hash was imported before/i);
    await screen.findByText(/previous\.xlsx/i);
  });

  it("does not warn when only semantic payload hash was previously imported", async () => {
    const workbookPayload: RawWorkbookPayload = {
      fileSha256: "bytes-hash-new-file",
      sheets: [
        {
          name: "2026",
          rows: [
            ["Payee", "Jan"],
            ["Power Co", "01/08 $48.58"],
          ],
          nonEmptyCells: [
            { row: 1, col: 1, value: "Payee" },
            { row: 1, col: 2, value: "Jan" },
            { row: 2, col: 1, value: "Power Co" },
            { row: 2, col: 2, value: "01/08 $48.58" },
          ],
        },
      ],
      warnings: [],
    };

    await t.repos.importLog.append({
      source_file: "/tmp/semantic-only.xlsx",
      content_hash: "semantic-payload-hash-only",
      row_count: 1,
    });

    readWorkbookMock.mockResolvedValue(workbookPayload);
    const user = userEvent.setup();

    render(
      <ImportPage
        repos={t.repos}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));
    await screen.findByText(/Editable payment rows/i);

    expect(
      screen.queryByText(/exact workbook file hash was imported before/i),
    ).toBeNull();
  });

  it("surfaces workbook warnings from raw reader payload", async () => {
    readWorkbookMock.mockResolvedValue({
      fileSha256: "file-hash-reader-warning",
      sheets: [
        {
          name: "2026",
          rows: [
            ["Payee", "Jan"],
            ["Water Co", "01/09 $10"],
          ],
          nonEmptyCells: [
            { row: 1, col: 1, value: "Payee" },
            { row: 1, col: 2, value: "Jan" },
            { row: 2, col: 1, value: "Water Co" },
            { row: 2, col: 2, value: "01/09 $10" },
          ],
        },
      ],
      warnings: [
        {
          kind: "skipped_non_year_sheet",
          sheet_name: "Summary",
          reason: "sheet name is not a 4-digit year",
        },
      ],
    });

    const user = userEvent.setup();

    render(
      <ImportPage
        repos={t.repos}
        pickWorkbookPath={pickWorkbookPathMock}
        readWorkbook={readWorkbookMock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose workbook" }));

    await screen.findByText(/Workbook warning:/i);
    await screen.findByText(/Skipped sheet "Summary": sheet name is not a 4-digit year\./i);
  });
});
