import fixture from "../fixtures/report/reporting-fixture.json";
import type { Repositories } from "../../src/core";
import type { TestDb } from "./test-db";

/** Inclusive report window with literal expected totals in `reporting-fixture.json`. */
export const REPORT_FIXTURE_WINDOW = fixture.window as { from: string; to: string };

/** Sum of in-window payment cents — independent of `runReportQuery`. */
export const REPORT_FIXTURE_TOTAL_CENTS = fixture.expected.in_window_total_cents as number;

export const REPORT_FIXTURE_BY_CATEGORY = fixture.expected.by_category as Record<string, number>;
export const REPORT_FIXTURE_BY_PAYEE = fixture.expected.by_payee as Record<string, number>;
export const REPORT_FIXTURE_BY_ACCOUNT = fixture.expected.by_account as Record<string, number>;

export const REPORT_FIXTURE_ALL_TIME = fixture.expected.all_time_window as {
  from: string;
  to: string;
};

export interface ReportFixtureIds {
  checkingId: number;
  visaId: number;
  powerCoId: number;
  waterCoId: number;
  utilitiesId: number;
  groceriesId: number;
  /** Present when `withArchivedEntities` is true. */
  archivedAccountId?: number;
  archivedCategoryId?: number;
}

export interface SeedReportingFixtureOptions {
  /** Adds archived account/category rows for filter-dropdown UI tests. */
  withArchivedEntities?: boolean;
}

/**
 * Seeds the documented Goal 04 reporting fixture into a temp book.
 * Expected totals come from `tests/fixtures/report/reporting-fixture.json`.
 */
export async function seedReportingFixture(
  t: TestDb | { repos: Repositories },
  options: SeedReportingFixtureOptions = {},
): Promise<ReportFixtureIds> {
  const { repos } = t;
  const accountIds = new Map<string, number>();
  const payeeIds = new Map<string, number>();
  const categoryIds = new Map<string, number>();

  for (const account of fixture.accounts) {
    accountIds.set(account.name, (await repos.accounts.insert(account)).id);
  }
  for (const payee of fixture.payees) {
    payeeIds.set(payee.name, (await repos.payees.insert(payee)).id);
  }
  for (const category of fixture.categories) {
    categoryIds.set(category.name, (await repos.categories.insert(category)).id);
  }

  let archivedAccountId: number | undefined;
  let archivedCategoryId: number | undefined;
  if (options.withArchivedEntities) {
    archivedAccountId = (
      await repos.accounts.insert({ name: "Old Savings", kind: "cash" })
    ).id;
    await repos.accounts.archive(archivedAccountId);
    archivedCategoryId = (await repos.categories.insert({ name: "Legacy" })).id;
    await repos.categories.archive(archivedCategoryId);
  }

  for (const payment of fixture.payments) {
    const payeeId = payeeIds.get(payment.payee);
    const accountId = accountIds.get(payment.account);
    if (payeeId === undefined || accountId === undefined) {
      throw new Error(`unknown fixture entity for payment on ${payment.date}`);
    }

    const categoryId =
      payment.category === null
        ? null
        : categoryIds.get(payment.category) ?? null;

    await repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: payment.date,
      amount_cents: payment.amount_cents,
      source: "manual",
    });
  }

  const checkingId = accountIds.get("Checking");
  const visaId = accountIds.get("Visa");
  const powerCoId = payeeIds.get("Power Co");
  const waterCoId = payeeIds.get("Water Co");
  const utilitiesId = categoryIds.get("Utilities");
  const groceriesId = categoryIds.get("Groceries");

  if (
    checkingId === undefined ||
    visaId === undefined ||
    powerCoId === undefined ||
    waterCoId === undefined ||
    utilitiesId === undefined ||
    groceriesId === undefined
  ) {
    throw new Error("fixture seed failed to create required entities");
  }

  return {
    checkingId,
    visaId,
    powerCoId,
    waterCoId,
    utilitiesId,
    groceriesId,
    archivedAccountId,
    archivedCategoryId,
  };
}

/** Independent sum of in-window payment cents from the fixture JSON. */
export function reportFixturePaymentSum(): number {
  return (fixture.expected.in_window_payment_cents as number[]).reduce(
    (sum, cents) => sum + cents,
    0,
  );
}
