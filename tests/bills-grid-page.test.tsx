// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillsGridPage } from "../src/pages/BillsGridPage";
import { openTestDb, type TestDb } from "./support/test-db";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "./fixtures/bill-pay-grid");
const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface BillPayGridFixture {
  year: number;
  accounts: Array<{ key: string; name: string; kind: "checking" | "credit" | "cash" }>;
  categories: Array<{ key: string; name: string }>;
  payees: Array<{
    key: string;
    name: string;
    default_account: string;
    default_category: string;
  }>;
  payments: Array<{
    payee: string;
    account: string;
    category: string;
    date: string;
    amount_cents: number;
    memo?: string;
  }>;
  expected: {
    placements: Array<{ payee: string; month: number; labels: string[] }>;
    row_totals: Array<{ payee: string; total_cents: number }>;
    month_totals: Array<{ month: number; total_cents: number }>;
    grand_total_cents: number;
  };
}

function loadFixture(name: string): BillPayGridFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8")) as BillPayGridFixture;
}

function toCurrency(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

async function seedGridFixture(t: TestDb, fixture: BillPayGridFixture): Promise<void> {
  const accountIds = new Map<string, number>();
  const categoryIds = new Map<string, number>();
  const payeeIds = new Map<string, number>();

  for (const account of fixture.accounts) {
    const inserted = await t.repos.accounts.insert({
      name: account.name,
      kind: account.kind,
    });
    accountIds.set(account.key, inserted.id);
  }

  for (const category of fixture.categories) {
    const inserted = await t.repos.categories.insert({ name: category.name });
    categoryIds.set(category.key, inserted.id);
  }

  for (const payee of fixture.payees) {
    const inserted = await t.repos.payees.insert({
      name: payee.name,
      default_account_id: accountIds.get(payee.default_account) ?? null,
      default_category_id: categoryIds.get(payee.default_category) ?? null,
    });
    payeeIds.set(payee.key, inserted.id);
  }

  for (const payment of fixture.payments) {
    await t.repos.payments.insert({
      payee_id: payeeIds.get(payment.payee)!,
      account_id: accountIds.get(payment.account)!,
      category_id: categoryIds.get(payment.category)!,
      date: payment.date,
      amount_cents: payment.amount_cents,
      memo: payment.memo,
      source: "manual",
    });
  }
}

describe("BillsGridPage", () => {
  let fixtureDb: TestDb | null = null;

  beforeEach(() => {
    fixtureDb = openTestDb();
  });

  afterEach(() => {
    fixtureDb?.close();
    fixtureDb = null;
    cleanup();
  });

  it("renders payee x month cells with deterministic row and month totals", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    const fixture = loadFixture("goal-03-grid-2026.json");
    await seedGridFixture(fixtureDb, fixture);

    render(<BillsGridPage repos={fixtureDb.repos} initialYear={fixture.year} />);

    await screen.findByRole("heading", { level: 1, name: "Bills Grid" });

    for (const placement of fixture.expected.placements) {
      const openCellButton = await screen.findByRole("button", {
        name: `Open ${placement.payee} ${MONTH_NAMES_LONG[placement.month - 1]} ${fixture.year}`,
      });
      expect(openCellButton).toBeTruthy();

      for (const label of placement.labels) {
        expect(screen.getByText(label)).toBeTruthy();
      }
    }

    for (const rowTotal of fixture.expected.row_totals) {
      const row = screen
        .getAllByRole("row")
        .find((candidate) => within(candidate).queryByRole("rowheader", { name: rowTotal.payee }) !== null);
      expect(row).toBeTruthy();
      expect(within(row as HTMLElement).getByText(toCurrency(rowTotal.total_cents))).toBeTruthy();
    }

    const totalsRow = screen
      .getAllByRole("row")
      .find((row) => within(row).queryByRole("rowheader", { name: "Total" }) !== null);
    expect(totalsRow).toBeTruthy();

    for (const monthTotal of fixture.expected.month_totals) {
      expect(within(totalsRow as HTMLElement).getByText(toCurrency(monthTotal.total_cents))).toBeTruthy();
    }
    expect(within(totalsRow as HTMLElement).getByText(toCurrency(fixture.expected.grand_total_cents))).toBeTruthy();
  });

  it("adds, edits, and deletes from a cell context and refreshes totals immediately", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    const checking = await fixtureDb.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const utilities = await fixtureDb.repos.categories.insert({ name: "Utilities" });
    const power = await fixtureDb.repos.payees.insert({
      name: "Power Co",
      default_account_id: checking.id,
      default_category_id: utilities.id,
    });

    await fixtureDb.repos.payments.insert({
      payee_id: power.id,
      account_id: checking.id,
      category_id: utilities.id,
      date: "2026-01-10",
      amount_cents: 1000,
      memo: "first",
      source: "manual",
    });

    const user = userEvent.setup();
    render(<BillsGridPage repos={fixtureDb.repos} initialYear={2026} />);

    await screen.findByRole("heading", { level: 1, name: "Bills Grid" });

    const janCellButton = await screen.findByRole("button", {
      name: "Open Power Co January 2026",
    });
    await user.click(janCellButton);

    await screen.findByRole("heading", { level: 2, name: "Power Co - January 2026" });

    await user.clear(screen.getByLabelText("Date"));
    await user.type(screen.getByLabelText("Date"), "2026-01-12");
    await user.type(screen.getByLabelText("Amount"), "5.00");
    await user.type(screen.getByLabelText("Memo (optional)"), "second");
    await user.click(screen.getByRole("button", { name: "Add payment" }));

    await screen.findByText("Payment saved.");
    expect(await screen.findAllByText("01/12 $5.00")).toHaveLength(2);
    expect(screen.getAllByText("$15.00").length >= 1).toBe(true);

    const firstPaymentRow = screen
      .getAllByRole("listitem")
      .find((item) => within(item).queryByText("01/10 $10.00") !== null);
    expect(firstPaymentRow).toBeTruthy();
    await user.click(within(firstPaymentRow as HTMLElement).getByRole("button", { name: "Edit" }));

    const editAmountField = within(firstPaymentRow as HTMLElement).getByLabelText("Amount");
    await user.clear(editAmountField);
    await user.type(editAmountField, "12.00");
    await user.click(within(firstPaymentRow as HTMLElement).getByRole("button", { name: "Save" }));

    await screen.findByText("Payment updated.");
    expect(await screen.findAllByText("01/10 $12.00")).toHaveLength(2);
    expect(screen.getAllByText("$17.00").length >= 1).toBe(true);

    const secondPaymentRow = screen
      .getAllByRole("listitem")
      .find((item) => within(item).queryByText("01/12 $5.00") !== null);
    expect(secondPaymentRow).toBeTruthy();
    await user.click(within(secondPaymentRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await screen.findByText("Payment deleted.");
    await waitFor(() => {
      expect(screen.queryAllByText("01/12 $5.00")).toHaveLength(0);
    });
    expect(screen.getAllByText("$12.00").length >= 1).toBe(true);
  });

  it("renders 2026 fixture data after switching years from a different initial year", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");
    const fixture = loadFixture("goal-03-grid-2026.json");
    await seedGridFixture(fixtureDb, fixture);
    const anchorPlacement = fixture.expected.placements[0];

    const user = userEvent.setup();
    render(<BillsGridPage repos={fixtureDb.repos} initialYear={2031} />);

    await screen.findByRole("heading", { level: 1, name: "Bills Grid" });
    await screen.findByRole("button", {
      name: "Open Power Co January 2031",
    });
    expect(screen.queryByText(anchorPlacement.labels[0])).toBeNull();

    const previousYearButton = screen.getByRole("button", { name: "Previous year" });
    for (let index = 0; index < 2031 - fixture.year; index += 1) {
      await user.click(previousYearButton);
    }

    await screen.findByText(anchorPlacement.labels[0]);
    expect(
      screen.getByRole("button", {
        name: `Open ${anchorPlacement.payee} ${MONTH_NAMES_LONG[anchorPlacement.month - 1]} ${fixture.year}`,
      }),
    ).toBeTruthy();
  });
});
