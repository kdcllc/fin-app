// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GnucashTransactionList } from "../src/core/gnucash-types";
import { GnuCashPage } from "../src/pages/GnuCashPage";
import { openTestDb, type TestDb } from "./support/test-db";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./fixtures/gnucash/reader-output.json",
);

const CHECKING_GUID = "a0000000000000000000000000000002";
const ELECTRIC_GUID = "a0000000000000000000000000000007";
const GROCERIES_GUID = "a0000000000000000000000000000008";
const INEXACT_GUID = "t0000000000000000000000000000000d";

const loadGnucashBookStateMock = vi.fn();
const updateGnucashBookStateMock = vi.fn();
const gnucashProbeBookMock = vi.fn();
const gnucashListAccountsMock = vi.fn();
const gnucashListTransactionsMock = vi.fn();

vi.mock("../src/gnucash-book", () => ({
  loadGnucashBookState: () => loadGnucashBookStateMock(),
  updateGnucashBookState: (patch: unknown) => updateGnucashBookStateMock(patch),
  gnucashProbeBook: (path: string) => gnucashProbeBookMock(path),
  gnucashListAccounts: (path: string) => gnucashListAccountsMock(path),
  gnucashListTransactions: (
    path: string,
    accountGuids: string[],
    from: string,
    to: string,
  ) => gnucashListTransactionsMock(path, accountGuids, from, to),
}));

interface ReaderFixture {
  probe: { status: string; schemaVersion: number };
  accounts: ReturnType<typeof loadFixture> extends infer _T ? import("../src/core").GnucashAccount[] : never;
  transactionList: GnucashTransactionList;
}

function loadFixture(): ReaderFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ReaderFixture;
}

function linkedBookState(importAccountGuids: string[] = [CHECKING_GUID]) {
  return {
    bookPath: "/tmp/fixture-book.gnucash",
    importAccountGuids,
    lastImportAt: null as string | null,
  };
}

async function clickTab(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("tab", { name: label }));
}

describe("GnuCashPage", () => {
  let t: TestDb;
  let fixture: ReaderFixture;

  beforeEach(() => {
    fixture = loadFixture();
    t = openTestDb();

    loadGnucashBookStateMock.mockReset();
    updateGnucashBookStateMock.mockReset();
    gnucashProbeBookMock.mockReset();
    gnucashListAccountsMock.mockReset();
    gnucashListTransactionsMock.mockReset();

    loadGnucashBookStateMock.mockResolvedValue(linkedBookState());
    updateGnucashBookStateMock.mockImplementation(async (patch) => ({
      ...linkedBookState(),
      ...patch,
    }));
    gnucashProbeBookMock.mockResolvedValue(fixture.probe);
    gnucashListAccountsMock.mockResolvedValue(fixture.accounts);
    gnucashListTransactionsMock.mockResolvedValue(fixture.transactionList);
  });

  afterEach(() => {
    cleanup();
    t.close();
  });

  async function renderPage(
    props: Partial<React.ComponentProps<typeof GnuCashPage>> = {},
  ) {
    render(<GnuCashPage db={t.db} repos={t.repos} {...props} />);
    await screen.findByRole("heading", { name: "GnuCash" });
  }

  it("renders each tab with tab-specific controls", async () => {
    const user = userEvent.setup();
    await renderPage();

    expect(screen.getByRole("tab", { name: "Link book", selected: true })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose / re-link book" }),
    ).toBeTruthy();

    await clickTab(user, "Account mapping");
    await screen.findByRole("heading", { name: "Fin-app accounts" });

    await clickTab(user, "Import");
    expect(screen.getByRole("button", { name: "Plan import" })).toBeTruthy();

  });

  it("renders exactly the Link book, Account mapping and Import tabs", async () => {
    await renderPage();

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Link book",
      "Account mapping",
      "Import",
    ]);
    expect(screen.queryByRole("tab", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Reconcile" })).toBeNull();
  });

  it("shows XML conversion walkthrough without persisting the XML path", async () => {
    const user = userEvent.setup();
    const xmlPath = "/tmp/book.gnucash";
    const pickBookPath = vi.fn(async () => xmlPath);

    loadGnucashBookStateMock.mockResolvedValue({
      bookPath: null,
      importAccountGuids: [],
      lastImportAt: null,
    });
    gnucashProbeBookMock.mockResolvedValue({ status: "xml" });

    await renderPage({ pickBookPath });
    await user.click(screen.getByRole("button", { name: "Choose / re-link book" }));

    await screen.findByText(/File → Save As/i);
    expect(screen.getByText(/save as sqlite3 format/i)).toBeTruthy();
    expect(updateGnucashBookStateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookPath: xmlPath }),
    );
  });

  it("blocks mapping/import when the linked book is missing", async () => {
    const user = userEvent.setup();

    loadGnucashBookStateMock.mockResolvedValue({
      bookPath: "/tmp/missing.gnucash",
      importAccountGuids: [CHECKING_GUID],
      lastImportAt: null,
    });
    gnucashProbeBookMock.mockResolvedValue({ status: "missing" });

    await renderPage();

    await clickTab(user, "Import");
    expect(
      screen.getByText(/linked GnuCash book file could not be found/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-link book" })).toBeTruthy();

    await clickTab(user, "Link book");
    expect(screen.getByRole("button", { name: "Choose / re-link book" })).toBeTruthy();
  });

  it("persists account mapping when Apply is clicked on a suggestion", async () => {
    const user = userEvent.setup();
    const account = await t.repos.accounts.insert({
      name: "Checking …9002",
      kind: "checking",
      last4: "9002",
    });

    await renderPage();
    await clickTab(user, "Account mapping");
    await screen.findByRole("heading", { name: "Account suggestions" });

    const applyButtons = screen.getAllByRole("button", { name: "Apply" });
    await user.click(applyButtons[0]);

    await waitFor(async () => {
      const row = await t.repos.accounts.get(account.id);
      expect(row?.gnucash_guid).toBe(CHECKING_GUID);
    });
  });

  it("shows every import review bucket including unreadable reader errors", async () => {
    const user = userEvent.setup();
    const checkingId = (
      await t.repos.accounts.insert({
        name: "Checking",
        kind: "checking",
        gnucash_guid: CHECKING_GUID,
      })
    ).id;
    const electricId = (
      await t.repos.categories.insert({ name: "Electric", gnucash_guid: ELECTRIC_GUID })
    ).id;
    const payeeId = (await t.repos.payees.insert({ name: "Existing Payee" })).id;

    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: checkingId,
      category_id: electricId,
      date: "2026-03-10",
      amount_cents: 4858,
      source: "gnucash",
      external_ref: "review-updated",
      memo: "Existing",
    });
    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: checkingId,
      category_id: electricId,
      date: "2026-03-12",
      amount_cents: 2500,
      source: "manual",
    });

    const reviewList: GnucashTransactionList = {
      transactions: [
        {
          txn_guid: "review-new",
          post_date: "2026-03-15",
          description: "Existing Payee",
          splits: [
            {
              split_guid: "s-new-fund",
              account_guid: CHECKING_GUID,
              memo: "",
              value_cents: -3000,
            },
            {
              split_guid: "s-new-exp",
              account_guid: ELECTRIC_GUID,
              memo: "",
              value_cents: 3000,
            },
          ],
        },
        {
          txn_guid: "review-updated",
          post_date: "2026-03-10",
          description: "Existing",
          splits: [
            {
              split_guid: "s-upd-fund",
              account_guid: CHECKING_GUID,
              memo: "",
              value_cents: -5000,
            },
            {
              split_guid: "s-upd-exp",
              account_guid: ELECTRIC_GUID,
              memo: "",
              value_cents: 5000,
            },
          ],
        },
        {
          txn_guid: "review-merge",
          post_date: "2026-03-12",
          description: "Existing Payee",
          splits: [
            {
              split_guid: "s-merge-fund",
              account_guid: CHECKING_GUID,
              memo: "",
              value_cents: -2500,
            },
            {
              split_guid: "s-merge-exp",
              account_guid: ELECTRIC_GUID,
              memo: "",
              value_cents: 2500,
            },
          ],
        },
        {
          txn_guid: "review-unmapped",
          post_date: "2026-03-20",
          description: "No mapping",
          splits: [
            {
              split_guid: "s-bad-fund",
              account_guid: "missing-funding-guid",
              memo: "",
              value_cents: -100,
            },
            {
              split_guid: "s-bad-exp",
              account_guid: ELECTRIC_GUID,
              memo: "",
              value_cents: 100,
            },
          ],
        },
      ],
      errors: [
        {
          txn_guid: INEXACT_GUID,
          post_date: "2026-02-20",
          description: "Inexact rational txn",
          reason: "inexact rational: -1/3 cannot be represented at fraction 100",
        },
      ],
    };

    gnucashListTransactionsMock.mockResolvedValue(reviewList);

    await renderPage();
    await clickTab(user, "Import");
    await user.click(screen.getByRole("button", { name: "Plan import" }));

    await screen.findByRole("heading", { name: /^New \(1\)$/ });
    expect(screen.getByRole("heading", { name: /^Updated \(1\)$/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Merge candidates \(1\)$/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Unmappable \(1\)$/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Unreadable \(1\)$/ })).toBeTruthy();

    expect(screen.getByText("review-unmapped")).toBeTruthy();
    expect(screen.getByText(INEXACT_GUID)).toBeTruthy();
    expect(screen.getByText(/inexact rational/i)).toBeTruthy();
    expect(screen.getByText(/amount_cents/i)).toBeTruthy();

    const unreadableRow = screen.getByText(INEXACT_GUID).closest("tr");
    expect(unreadableRow).toBeTruthy();
    expect(within(unreadableRow!).queryByRole("checkbox")).toBeNull();
  });

  it("keeps commit disabled when new row is approved before payee confirmation", async () => {
    const user = userEvent.setup();
    await t.repos.accounts.insert({
      name: "Checking",
      kind: "checking",
      gnucash_guid: CHECKING_GUID,
    });
    await t.repos.categories.insert({ name: "Groceries", gnucash_guid: GROCERIES_GUID });

    gnucashListTransactionsMock.mockResolvedValue({
      transactions: [
        {
          txn_guid: "payee-new-txn",
          post_date: "2026-04-01",
          description: "Totally New Vendor",
          splits: [
            {
              split_guid: "s1",
              account_guid: CHECKING_GUID,
              memo: "",
              value_cents: -500,
            },
            {
              split_guid: "s2",
              account_guid: GROCERIES_GUID,
              memo: "",
              value_cents: 500,
            },
          ],
        },
      ],
      errors: [],
    });

    await renderPage();
    await clickTab(user, "Import");
    await user.click(screen.getByRole("button", { name: "Plan import" }));
    await screen.findByText("Suggested: Totally New Vendor");

    const commitButton = () =>
      screen.getByRole("button", { name: "Commit import" }) as HTMLButtonElement;

    await user.click(screen.getByRole("checkbox"));
    expect(commitButton().disabled).toBe(true);
    expect(screen.getByText(/Confirm or select a payee for 1 new row/i)).toBeTruthy();

    const beforePayees = await t.db.select<{ count: number }>("SELECT COUNT(*) AS count FROM payees");
    const beforeTransactions = await t.db.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM transactions",
    );

    await user.click(screen.getByRole("button", { name: "Create payee" }));
    await waitFor(() => {
      expect(commitButton().disabled).toBe(false);
    });

    const afterPayees = await t.db.select<{ count: number }>("SELECT COUNT(*) AS count FROM payees");
    expect(afterPayees[0].count).toBe(beforePayees[0].count + 1);

    await user.click(commitButton());
    await screen.findByText(/Import complete:/);

    expect(
      await t.db.select<{ count: number }>("SELECT COUNT(*) AS count FROM transactions"),
    ).toEqual([{ count: beforeTransactions[0].count + 1 }]);
    expect(
      await t.db.select<{ external_ref: string; amount_cents: number }>(
        `SELECT t.external_ref AS external_ref, s.amount_cents AS amount_cents
           FROM transactions t JOIN splits s ON s.transaction_id = t.id
          WHERE t.external_ref = 'payee-new-txn'
          ORDER BY s.amount_cents`,
      ),
    ).toEqual([
      { external_ref: "payee-new-txn", amount_cents: -500 },
      { external_ref: "payee-new-txn", amount_cents: 500 },
    ]);
  });

  it("requires payee auto-create confirmation before commit succeeds", async () => {
    const user = userEvent.setup();
    await t.repos.accounts.insert({
      name: "Checking",
      kind: "checking",
      gnucash_guid: CHECKING_GUID,
    });
    await t.repos.categories.insert({ name: "Groceries", gnucash_guid: GROCERIES_GUID });

    gnucashListTransactionsMock.mockResolvedValue({
      transactions: [
        {
          txn_guid: "payee-new-txn",
          post_date: "2026-04-01",
          description: "Totally New Vendor",
          splits: [
            {
              split_guid: "s1",
              account_guid: CHECKING_GUID,
              memo: "",
              value_cents: -500,
            },
            {
              split_guid: "s2",
              account_guid: GROCERIES_GUID,
              memo: "",
              value_cents: 500,
            },
          ],
        },
      ],
      errors: [],
    });

    await renderPage();
    await clickTab(user, "Import");
    await user.click(screen.getByRole("button", { name: "Plan import" }));
    await screen.findByText("Suggested: Totally New Vendor");
    expect(screen.getByText(/Confirm or select a payee for 1 new row/i)).toBeTruthy();

    const beforePayees = await t.db.select<{ count: number }>("SELECT COUNT(*) AS count FROM payees");
    await user.click(screen.getByRole("button", { name: "Create payee" }));
    await waitFor(() => {
      expect(screen.queryByText(/Confirm or select a payee for 1 new row/i)).toBeNull();
    });

    const afterPayees = await t.db.select<{ count: number }>("SELECT COUNT(*) AS count FROM payees");
    expect(afterPayees[0].count).toBe(beforePayees[0].count + 1);

    const commitButton = screen.getByRole("button", { name: "Commit import" }) as HTMLButtonElement;
    expect(commitButton.disabled).toBe(false);
    await user.click(commitButton);
    await screen.findByText(/Import complete:/);
    expect(
      await t.db.select<{ count: number }>("SELECT COUNT(*) AS count FROM transactions"),
    ).toEqual([{ count: 0 }]);
  });

  it("lists eligible accounts nested under ROOT and placeholder parents on a real-book-shaped tree", async () => {
    const user = userEvent.setup();
    const acct = (
      guid: string,
      name: string,
      account_type: string,
      parent_guid: string | null,
      full_path: string,
      placeholder = false,
    ) => ({
      guid,
      name,
      account_type,
      parent_guid,
      placeholder,
      commodity_mnemonic: "USD",
      commodity_fraction: 100,
      full_path,
    });
    gnucashListAccountsMock.mockResolvedValue([
      acct("r00", "Root Account", "ROOT", null, "Root Account", true),
      acct("r01", "Assets", "ASSET", "r00", "Assets", true),
      acct("r02", "Liabilities", "LIABILITY", "r00", "Liabilities", true),
      acct("r03", "Checking", "BANK", "r01", "Assets:Checking"),
      acct("r04", "Visa", "CREDIT", "r02", "Liabilities:Visa"),
      acct("r05", "Checking Sub", "BANK", "r03", "Assets:Checking:Checking Sub"),
    ]);
    loadGnucashBookStateMock.mockResolvedValue(linkedBookState([]));

    await renderPage();
    await clickTab(user, "Import");

    const checking = await screen.findByRole("checkbox", { name: "Assets:Checking" });
    const sub = screen.getByRole("checkbox", { name: "Assets:Checking:Checking Sub" });
    const visa = screen.getByRole("checkbox", { name: "Liabilities:Visa" });
    const checkingNode = checking.closest("div") as HTMLElement;
    expect(checkingNode.contains(sub)).toBe(true);
    expect(checkingNode.contains(visa)).toBe(false);

    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.queryByRole("checkbox", { name: /^Root Account$/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^Assets$/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^Liabilities$/ })).toBeNull();
    expect(screen.queryByText("No eligible GnuCash accounts loaded.")).toBeNull();

    const plan = screen.getByRole("button", { name: "Plan import" }) as HTMLButtonElement;
    expect(plan.disabled).toBe(true);
    await user.click(checking);
    expect(plan.disabled).toBe(false);
  });
});
