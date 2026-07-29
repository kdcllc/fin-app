import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dismissRecurringBillSuggestion,
  getRecurringBillSuggestions,
  getRecurringDashboardMonth,
  type BillFrequency,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/recurring-dashboard",
);

interface ClassificationFixture {
  year: number;
  month: number;
  as_of_date: string;
  tolerance_cents: number;
  payees: Array<{ name: string }>;
  recurring_bills: Array<{
    payee: string;
    frequency: BillFrequency;
    expected_amount_cents: number | null;
    due_day: number;
    anchor_month?: number;
    anchor_phase?: number;
  }>;
  payments: Array<{ payee: string; date: string; amount_cents: number }>;
  expected: {
    month_to_date_spent_cents: number;
    paid: string[];
    due: string[];
    overdue: string[];
  };
}

interface SuggestionsFixture {
  through_date: string;
  lookback_months: number;
  payees: Array<{ name: string }>;
  existing_recurring: Array<{
    payee: string;
    frequency: BillFrequency;
    expected_amount_cents: number;
    due_day: number;
  }>;
  payments: Array<{ payee: string; date: string; amount_cents: number }>;
  expected: Array<{
    payee: string;
    frequency: BillFrequency;
    due_day: number;
    expected_amount_cents: number;
    anchor_month: number;
    anchor_phase: number;
  }>;
}

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8")) as T;
}

describe("recurring dashboard services", () => {
  let t: TestDb;
  let checkingId: number;

  beforeEach(async () => {
    t = openTestDb();
    checkingId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
  });

  afterEach(() => t.close());

  it("classifies due/paid/overdue with tolerance from deterministic fixtures", async () => {
    const fixture = loadFixture<ClassificationFixture>("classification.json");
    const payeeIds = new Map<string, number>();

    for (const payee of fixture.payees) {
      const created = await t.repos.payees.insert({
        name: payee.name,
        default_account_id: checkingId,
      });
      payeeIds.set(payee.name, created.id);
    }

    for (const bill of fixture.recurring_bills) {
      await t.repos.recurringBills.insert({
        payee_id: payeeIds.get(bill.payee)!,
        frequency: bill.frequency,
        expected_amount_cents: bill.expected_amount_cents,
        due_day: bill.due_day,
        anchor_month: bill.anchor_month,
        anchor_phase: bill.anchor_phase,
      });
    }

    for (const payment of fixture.payments) {
      await t.repos.payments.insert({
        payee_id: payeeIds.get(payment.payee)!,
        account_id: checkingId,
        date: payment.date,
        amount_cents: payment.amount_cents,
        source: "manual",
      });
    }

    const dashboard = await getRecurringDashboardMonth(t.repos, {
      year: fixture.year,
      month: fixture.month,
      toleranceCents: fixture.tolerance_cents,
      asOfDate: fixture.as_of_date,
    });

    expect(dashboard.month_to_date_spent_cents).toBe(fixture.expected.month_to_date_spent_cents);
    expect(dashboard.paid.map((item) => item.payee_name)).toEqual(fixture.expected.paid);
    expect(dashboard.due.map((item) => item.payee_name)).toEqual(fixture.expected.due);
    expect(dashboard.overdue.map((item) => item.payee_name)).toEqual(fixture.expected.overdue);
  });

  it("classifies anchored quarterly and annual schedules for non-January periods", async () => {
    const fixture = loadFixture<ClassificationFixture>("classification-anchors.json");
    const payeeIds = new Map<string, number>();

    for (const payee of fixture.payees) {
      const created = await t.repos.payees.insert({
        name: payee.name,
        default_account_id: checkingId,
      });
      payeeIds.set(payee.name, created.id);
    }

    for (const bill of fixture.recurring_bills) {
      await t.repos.recurringBills.insert({
        payee_id: payeeIds.get(bill.payee)!,
        frequency: bill.frequency,
        expected_amount_cents: bill.expected_amount_cents,
        due_day: bill.due_day,
        anchor_month: bill.anchor_month,
        anchor_phase: bill.anchor_phase,
      });
    }

    for (const payment of fixture.payments) {
      await t.repos.payments.insert({
        payee_id: payeeIds.get(payment.payee)!,
        account_id: checkingId,
        date: payment.date,
        amount_cents: payment.amount_cents,
        source: "manual",
      });
    }

    const dashboard = await getRecurringDashboardMonth(t.repos, {
      year: fixture.year,
      month: fixture.month,
      toleranceCents: fixture.tolerance_cents,
      asOfDate: fixture.as_of_date,
    });

    expect(dashboard.month_to_date_spent_cents).toBe(fixture.expected.month_to_date_spent_cents);
    expect(dashboard.paid.map((item) => item.payee_name)).toEqual(fixture.expected.paid);
    expect(dashboard.due.map((item) => item.payee_name)).toEqual(fixture.expected.due);
    expect(dashboard.overdue.map((item) => item.payee_name)).toEqual(fixture.expected.overdue);
  });

  it("derives recurring suggestions and persists dismissals deterministically", async () => {
    const fixture = loadFixture<SuggestionsFixture>("suggestions.json");
    const payeeIds = new Map<string, number>();

    for (const payee of fixture.payees) {
      const created = await t.repos.payees.insert({
        name: payee.name,
        default_account_id: checkingId,
      });
      payeeIds.set(payee.name, created.id);
    }

    for (const recurring of fixture.existing_recurring) {
      await t.repos.recurringBills.insert({
        payee_id: payeeIds.get(recurring.payee)!,
        frequency: recurring.frequency,
        expected_amount_cents: recurring.expected_amount_cents,
        due_day: recurring.due_day,
      });
    }

    for (const payment of fixture.payments) {
      await t.repos.payments.insert({
        payee_id: payeeIds.get(payment.payee)!,
        account_id: checkingId,
        date: payment.date,
        amount_cents: payment.amount_cents,
        source: "manual",
      });
    }

    const suggestions = await getRecurringBillSuggestions(t.repos, {
      throughDate: fixture.through_date,
      lookbackMonths: fixture.lookback_months,
    });

    expect(
      suggestions.map((item) => ({
        payee: item.payee_name,
        frequency: item.frequency,
        due_day: item.due_day,
        expected_amount_cents: item.expected_amount_cents,
        anchor_month: item.anchor_month,
        anchor_phase: item.anchor_phase,
      })),
    ).toEqual(fixture.expected);

    const dismissed = suggestions.find((item) => item.payee_name === "Gym Membership");
    if (!dismissed) throw new Error("missing expected Gym Membership suggestion");
    await dismissRecurringBillSuggestion(t.repos, dismissed);

    const afterDismiss = await getRecurringBillSuggestions(t.repos, {
      throughDate: fixture.through_date,
      lookbackMonths: fixture.lookback_months,
    });

    expect(afterDismiss.map((item) => item.payee_name)).toEqual([
      "Estimated Taxes",
      "Insurance Premium",
    ]);

    const persistedDismissals = await t.repos.recurringBills.listSuggestionDismissals();
    expect(persistedDismissals).toHaveLength(1);
  });
});
