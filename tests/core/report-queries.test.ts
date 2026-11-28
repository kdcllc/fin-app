import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ValidationError,
  allTimeWindow,
  calendarYearWindow,
  formatCentsDecimal,
  formatPaymentsCsv,
  formatReportCsv,
  formatYearSheetCsv,
  getBillPayGridForYear,
  createIncome,
  createTransfer,
  postTransaction,
  setOpeningBalance,
  listPaymentsForReport,
  runReportQuery,
  trailing12Window,
  yoyWindowForCalendarYear,
} from "../../src/core";
import {
  REPORT_FIXTURE_ALL_TIME,
  REPORT_FIXTURE_BY_ACCOUNT,
  REPORT_FIXTURE_BY_CATEGORY,
  REPORT_FIXTURE_BY_PAYEE,
  REPORT_FIXTURE_TOTAL_CENTS,
  REPORT_FIXTURE_WINDOW,
  reportFixturePaymentSum,
  seedReportingFixture,
} from "../support/report-fixture";
import { openTestDb, type TestDb } from "../support/test-db";

const FIXTURE_WINDOW = REPORT_FIXTURE_WINDOW;
const FIXTURE_TOTAL_CENTS = REPORT_FIXTURE_TOTAL_CENTS;
const FIXTURE_BY_CATEGORY = {
  utilities: REPORT_FIXTURE_BY_CATEGORY.Utilities,
  groceries: REPORT_FIXTURE_BY_CATEGORY.Groceries,
  uncategorized: REPORT_FIXTURE_BY_CATEGORY.Uncategorized,
} as const;
const FIXTURE_BY_PAYEE = {
  powerCo: REPORT_FIXTURE_BY_PAYEE["Power Co"],
  waterCo: REPORT_FIXTURE_BY_PAYEE["Water Co"],
} as const;
const FIXTURE_BY_ACCOUNT = {
  checking: REPORT_FIXTURE_BY_ACCOUNT.Checking,
  visa: REPORT_FIXTURE_BY_ACCOUNT.Visa,
} as const;

describe("report window helpers", () => {
  it("calendarYearWindow bounds a calendar year", () => {
    expect(calendarYearWindow(2026)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("trailing12Window matches GOAL.md worked examples", () => {
    expect(trailing12Window(new Date(2026, 7, 16))).toEqual({
      from: "2025-08-16",
      to: "2026-08-16",
    });
    expect(trailing12Window(new Date(2026, 2, 31))).toEqual({
      from: "2025-03-31",
      to: "2026-03-31",
    });
    expect(trailing12Window(new Date(2024, 1, 29))).toEqual({
      from: "2023-02-28",
      to: "2024-02-29",
    });
  });

  it("yoyWindowForCalendarYear expands to prior January through year-end", () => {
    expect(yoyWindowForCalendarYear(2026)).toEqual({
      from: "2025-01-01",
      to: "2026-12-31",
    });
  });
});

describe("report query validation and empty states", () => {
  let t: TestDb;

  beforeEach(() => {
    t = openTestDb();
  });
  afterEach(() => t.close());

  it("throws ValidationError for from > to and malformed dates", async () => {
    const spec = { dimension: "total" as const, grain: "month" as const, filter: { from: "2026-02-01", to: "2026-01-31" } };
    await expect(runReportQuery(t.repos, spec)).rejects.toThrow(ValidationError);
    await expect(
      runReportQuery(t.repos, {
        ...spec,
        filter: { from: "2026-13-01", to: "2026-12-31" },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      runReportQuery(t.repos, {
        ...spec,
        filter: { from: "not-a-date", to: "2026-12-31" },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("returns [] for an empty book and allTimeWindow returns null", async () => {
    expect(await allTimeWindow(t.repos)).toBeNull();
    expect(
      await runReportQuery(t.repos, {
        dimension: "category",
        grain: "all",
        filter: FIXTURE_WINDOW,
      }),
    ).toEqual([]);
  });
});

describe("report query engine fixture book", () => {
  let t: TestDb;
  let utilitiesId: number;
  let groceriesId: number;
  let checkingId: number;
  let visaId: number;
  let powerCoId: number;
  let waterCoId: number;

  beforeEach(async () => {
    t = openTestDb();
    const ids = await seedReportingFixture(t);
    checkingId = ids.checkingId;
    visaId = ids.visaId;
    powerCoId = ids.powerCoId;
    waterCoId = ids.waterCoId;
    utilitiesId = ids.utilitiesId;
    groceriesId = ids.groceriesId;
  });
  afterEach(() => t.close());

  it("allTimeWindow spans the seeded payment dates", async () => {
    expect(await allTimeWindow(t.repos)).toEqual(REPORT_FIXTURE_ALL_TIME);
  });

  it("conserves fixture payment cents for all five dimension/grain pairs", async () => {
    const expectedSum = reportFixturePaymentSum();
    expect(expectedSum).toBe(FIXTURE_TOTAL_CENTS);

    const queries = [
      { dimension: "category" as const, grain: "all" as const },
      { dimension: "payee" as const, grain: "all" as const },
      { dimension: "account" as const, grain: "all" as const },
      { dimension: "total" as const, grain: "month" as const },
      { dimension: "total" as const, grain: "year" as const, filter: yoyWindowForCalendarYear(2026) },
    ];

    for (const query of queries) {
      const filter = query.filter ?? FIXTURE_WINDOW;
      const rows = await runReportQuery(t.repos, {
        dimension: query.dimension,
        grain: query.grain,
        filter,
      });
      expect(rows.reduce((sum, row) => sum + row.total_cents, 0)).toBe(expectedSum);
    }
  });

  it("category/all conserves fixture cents including Uncategorized", async () => {
    const rows = await runReportQuery(t.repos, {
      dimension: "category",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });

    expect(rows.reduce((sum, row) => sum + row.total_cents, 0)).toBe(FIXTURE_TOTAL_CENTS);
    expect(rows.find((row) => row.groupKey === utilitiesId)).toMatchObject({
      groupLabel: "Utilities",
      total_cents: FIXTURE_BY_CATEGORY.utilities,
      count: 1,
    });
    expect(rows.find((row) => row.groupKey === groceriesId)).toMatchObject({
      groupLabel: "Groceries",
      total_cents: FIXTURE_BY_CATEGORY.groceries,
      count: 2,
    });
    expect(rows.find((row) => row.groupKey === null)).toEqual({
      groupKey: null,
      groupLabel: "Uncategorized",
      periodKey: "",
      total_cents: FIXTURE_BY_CATEGORY.uncategorized,
      count: 1,
    });
  });

  it("payee/all and account/all match fixture literals", async () => {
    const payeeRows = await runReportQuery(t.repos, {
      dimension: "payee",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(payeeRows.reduce((sum, row) => sum + row.total_cents, 0)).toBe(FIXTURE_TOTAL_CENTS);
    expect(payeeRows.find((row) => row.groupKey === powerCoId)?.total_cents).toBe(
      FIXTURE_BY_PAYEE.powerCo,
    );
    expect(payeeRows.find((row) => row.groupKey === waterCoId)?.total_cents).toBe(
      FIXTURE_BY_PAYEE.waterCo,
    );

    const accountRows = await runReportQuery(t.repos, {
      dimension: "account",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(accountRows.reduce((sum, row) => sum + row.total_cents, 0)).toBe(FIXTURE_TOTAL_CENTS);
    expect(accountRows.find((row) => row.groupKey === checkingId)?.total_cents).toBe(
      FIXTURE_BY_ACCOUNT.checking,
    );
    expect(accountRows.find((row) => row.groupKey === visaId)?.total_cents).toBe(
      FIXTURE_BY_ACCOUNT.visa,
    );
  });

  it("grain=all sorts by total_cents DESC, groupLabel ASC, groupKey ASC with nulls last", async () => {
    const acmeCoId = (await t.repos.payees.insert({ name: "Acme Co" })).id;
    const otherAccountId = (await t.repos.accounts.insert({ name: "Other", kind: "cash" })).id;
    await t.repos.payments.insert({
      payee_id: acmeCoId,
      account_id: otherAccountId,
      category_id: groceriesId,
      date: "2026-04-01",
      amount_cents: 6_200,
      source: "manual",
    });

    const savingsId = (await t.repos.accounts.insert({ name: "Savings", kind: "cash" })).id;
    await t.repos.payments.insert({
      payee_id: waterCoId,
      account_id: savingsId,
      category_id: groceriesId,
      date: "2026-04-01",
      amount_cents: 7_500,
      source: "manual",
    });

    const extraCoId = (await t.repos.payees.insert({ name: "Extra Co" })).id;
    const dupLowId = (await t.repos.categories.insert({ name: "Dup" })).id;
    const dupHighId = (await t.repos.categories.insert({ name: "Dup" })).id;
    await t.repos.payments.insert({
      payee_id: extraCoId,
      account_id: otherAccountId,
      category_id: dupLowId,
      date: "2026-04-01",
      amount_cents: 5_000,
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: extraCoId,
      account_id: otherAccountId,
      category_id: dupHighId,
      date: "2026-04-02",
      amount_cents: 5_000,
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: extraCoId,
      account_id: otherAccountId,
      category_id: null,
      date: "2026-04-03",
      amount_cents: 3_800,
      source: "manual",
    });

    const categoryRows = await runReportQuery(t.repos, {
      dimension: "category",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(categoryRows.map((row) => row.total_cents)).toEqual([
      24_500, 5_000, 5_000, 5_000, 5_000,
    ]);
    expect(categoryRows.map((row) => row.groupLabel)).toEqual([
      "Groceries",
      "Dup",
      "Dup",
      "Uncategorized",
      "Utilities",
    ]);
    expect(categoryRows.map((row) => row.groupKey)).toEqual([
      groceriesId,
      dupLowId,
      dupHighId,
      null,
      utilitiesId,
    ]);

    const payeeRows = await runReportQuery(t.repos, {
      dimension: "payee",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(payeeRows.map((row) => row.total_cents)).toEqual([18_300, 13_800, 6_200, 6_200]);
    expect(payeeRows.map((row) => row.groupLabel)).toEqual([
      "Water Co",
      "Extra Co",
      "Acme Co",
      "Power Co",
    ]);
    expect(payeeRows.map((row) => row.groupKey)).toEqual([
      waterCoId,
      extraCoId,
      acmeCoId,
      powerCoId,
    ]);

    const accountRows = await runReportQuery(t.repos, {
      dimension: "account",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(accountRows.map((row) => row.total_cents)).toEqual([20_000, 9_500, 7_500, 7_500]);
    expect(accountRows.map((row) => row.groupLabel)).toEqual([
      "Other",
      "Checking",
      "Savings",
      "Visa",
    ]);
    expect(accountRows.map((row) => row.groupKey)).toEqual([
      otherAccountId,
      checkingId,
      savingsId,
      visaId,
    ]);
  });

  it("total/month zero-fills across Dec→Jan and buckets leap-day into February", async () => {
    const trend = await runReportQuery(t.repos, {
      dimension: "total",
      grain: "month",
      filter: { from: "2025-12-01", to: "2026-04-30" },
    });
    expect(trend).toEqual([
      { groupKey: null, groupLabel: "", periodKey: "2025-12", total_cents: 5_000, count: 1 },
      { groupKey: null, groupLabel: "", periodKey: "2026-01", total_cents: 7_500, count: 1 },
      { groupKey: null, groupLabel: "", periodKey: "2026-02", total_cents: 1_200, count: 1 },
      { groupKey: null, groupLabel: "", periodKey: "2026-03", total_cents: 3_300, count: 1 },
      { groupKey: null, groupLabel: "", periodKey: "2026-04", total_cents: 0, count: 0 },
    ]);
    expect(trend.reduce((sum, row) => sum + row.total_cents, 0)).toBe(17_000);

    const leapMonth = await runReportQuery(t.repos, {
      dimension: "total",
      grain: "month",
      filter: { from: "2024-02-01", to: "2024-02-29" },
    });
    expect(leapMonth).toEqual([
      { groupKey: null, groupLabel: "", periodKey: "2024-02", total_cents: 2_900, count: 1 },
    ]);
  });

  it("total/year uses YoY window and does not zero-fill empty years", async () => {
    const yoyFilter = yoyWindowForCalendarYear(2026);
    const rows = await runReportQuery(t.repos, {
      dimension: "total",
      grain: "year",
      filter: yoyFilter,
    });
    expect(rows).toEqual([
      { groupKey: null, groupLabel: "", periodKey: "2025", total_cents: 5_000, count: 1 },
      { groupKey: null, groupLabel: "", periodKey: "2026", total_cents: 12_000, count: 3 },
    ]);
    expect(rows.reduce((sum, row) => sum + row.total_cents, 0)).toBe(FIXTURE_TOTAL_CENTS);
  });

  it("categoryId null limits category/all and matches Uncategorized dump cents", async () => {
    const uncategorizedDump = await listPaymentsForReport(t.repos, {
      ...FIXTURE_WINDOW,
      categoryId: null,
    });
    expect(uncategorizedDump).toHaveLength(1);
    expect(uncategorizedDump[0]).toMatchObject({
      date: "2026-02-01",
      amount_cents: 1_200,
      category_id: null,
      category_name: "Uncategorized",
    });

    const rows = await runReportQuery(t.repos, {
      dimension: "category",
      grain: "all",
      filter: { ...FIXTURE_WINDOW, categoryId: null },
    });
    expect(rows).toEqual([
      {
        groupKey: null,
        groupLabel: "Uncategorized",
        periodKey: "",
        total_cents: 1_200,
        count: 1,
      },
    ]);
    expect(rows.reduce((sum, row) => sum + row.total_cents, 0)).toBe(
      uncategorizedDump.reduce((sum, row) => sum + row.amount_cents, 0),
    );
  });

  it("listPaymentsForReport honors categoryId null for Uncategorized-only dump", async () => {
    const uncategorized = await listPaymentsForReport(t.repos, {
      ...FIXTURE_WINDOW,
      categoryId: null,
    });
    expect(uncategorized).toHaveLength(1);
    expect(uncategorized[0]).toMatchObject({
      date: "2026-02-01",
      amount_cents: 1_200,
      category_id: null,
      category_name: "Uncategorized",
    });

    const allCategories = await listPaymentsForReport(t.repos, FIXTURE_WINDOW);
    expect(allCategories).toHaveLength(4);
    expect(allCategories.reduce((sum, row) => sum + row.amount_cents, 0)).toBe(
      FIXTURE_TOTAL_CENTS,
    );
  });

  it("three-split expense, transfer and income change no report output", async () => {
    const dims = [
      { dimension: "category" as const, grain: "all" as const },
      { dimension: "payee" as const, grain: "all" as const },
      { dimension: "account" as const, grain: "all" as const },
      { dimension: "total" as const, grain: "month" as const },
      { dimension: "total" as const, grain: "year" as const },
    ];
    const snapshot = async () => ({
      rows: await Promise.all(
        dims.map((d) =>
          runReportQuery(t.repos, { dimension: d.dimension, grain: d.grain, filter: FIXTURE_WINDOW }),
        ),
      ),
      list: await listPaymentsForReport(t.repos, FIXTURE_WINDOW),
      window: await allTimeWindow(t.repos),
    });
    const before = await snapshot();

    const ledger = t.repos.ledger;
    const expenseRoot = await ledger.getSystemAccount("root_expense");
    const incomeRoot = await ledger.getSystemAccount("root_income");
    const extra = await ledger.insertAccount({
      name: "Extra Expense",
      type: "EXPENSE",
      parent_id: expenseRoot!.id,
    });
    const salary = await ledger.insertAccount({
      name: "Salary",
      type: "INCOME",
      parent_id: incomeRoot!.id,
    });
    await postTransaction(ledger, {
      date: "2026-01-20",
      payee_id: powerCoId,
      splits: [
        { account_id: utilitiesId, amount_cents: 500 },
        { account_id: extra.id, amount_cents: 700 },
        { account_id: checkingId, amount_cents: -1_200 },
      ],
    });
    // Out-of-window dates must not move allTimeWindow either.
    await postTransaction(ledger, {
      date: "1999-01-01",
      payee_id: powerCoId,
      splits: [
        { account_id: extra.id, amount_cents: 100 },
        { account_id: visaId, amount_cents: -50 },
        { account_id: checkingId, amount_cents: -50 },
      ],
    });
    await createTransfer(ledger, {
      date: "2026-01-21",
      fromAccountId: checkingId,
      toAccountId: visaId,
      amount_cents: 9_900,
      payee_id: powerCoId,
    });
    await createIncome(ledger, {
      date: "2030-01-22",
      incomeAccountId: salary.id,
      depositAccountId: checkingId,
      amount_cents: 300_000,
      payee_id: powerCoId,
    });

    // Two-split shapes that fail one guard each: EXPENSE<->EXPENSE funding,
    // NULL payee, and EXPENSE<->INCOME funding.
    await postTransaction(ledger, {
      date: "2026-01-22",
      payee_id: powerCoId,
      splits: [
        { account_id: utilitiesId, amount_cents: 400 },
        { account_id: extra.id, amount_cents: -400 },
      ],
    });
    await postTransaction(ledger, {
      date: "2026-01-23",
      payee_id: null,
      splits: [
        { account_id: utilitiesId, amount_cents: 800 },
        { account_id: checkingId, amount_cents: -800 },
      ],
    });
    await postTransaction(ledger, {
      date: "2026-01-24",
      payee_id: powerCoId,
      splits: [
        { account_id: utilitiesId, amount_cents: 600 },
        { account_id: salary.id, amount_cents: -600 },
      ],
    });
    await setOpeningBalance(ledger, checkingId, "1998-06-01", 50_000);

    expect(await snapshot()).toEqual(before);
  });

  it("labels the uncategorized system account 'Uncategorized' even when renamed", async () => {
    const uncategorized = await t.repos.ledger.getSystemAccount("uncategorized");
    await t.repos.ledger.updateAccount(uncategorized!.id, { name: "Misc Renamed" });

    const rows = await runReportQuery(t.repos, {
      dimension: "category",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    const row = rows.find((r) => r.groupKey === null);
    expect(row).toMatchObject({
      groupKey: null,
      groupLabel: "Uncategorized",
      total_cents: FIXTURE_BY_CATEGORY.uncategorized,
    });
    const dump = await listPaymentsForReport(t.repos, { ...FIXTURE_WINDOW, categoryId: null });
    expect(dump[0].category_name).toBe("Uncategorized");
  });

  it("includes archived payees and categories when they have in-window payments", async () => {
    await t.repos.payees.archive(waterCoId);
    await t.repos.categories.archive(groceriesId);

    const payeeRows = await runReportQuery(t.repos, {
      dimension: "payee",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(payeeRows.find((row) => row.groupKey === waterCoId)?.groupLabel).toBe("Water Co");

    const categoryRows = await runReportQuery(t.repos, {
      dimension: "category",
      grain: "all",
      filter: FIXTURE_WINDOW,
    });
    expect(categoryRows.find((row) => row.groupKey === groceriesId)?.groupLabel).toBe("Groceries");
  });
});

describe("report CSV formatters", () => {
  it("formatCentsDecimal uses integer abs/100 and abs%100", () => {
    expect(formatCentsDecimal(12_345)).toBe("123.45");
    expect(formatCentsDecimal(-50)).toBe("-0.50");
  });

  it("formatReportCsv emits UTF-8 BOM and RFC 4180 quoting", () => {
    const csv = formatReportCsv([
      {
        groupKey: 1,
        groupLabel: 'Groceries, "fresh"',
        periodKey: "",
        total_cents: 12_345,
        count: 2,
      },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"Groceries, ""fresh"""');
    expect(csv).toContain("123.45");
  });

  it("formatPaymentsCsv emits BOM and amount strings from fixture cents", () => {
    const csv = formatPaymentsCsv([
      {
        id: 1,
        payee_id: 1,
        account_id: 1,
        category_id: null,
        date: "2026-02-01",
        amount_cents: -50,
        memo: "note",
        source: "manual",
        external_ref: null,
        source_sheet: null,
        source_row: null,
        source_col: null,
        occurrence_index: null,
        created_at: "2026-02-01 00:00:00",
        payee_name: "Power Co",
        account_name: "Checking",
        category_name: "Uncategorized",
      },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("-0.50");
  });

  it("formatYearSheetCsv totals match getBillPayGridForYear", async () => {
    const t = openTestDb();
    const checkingId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
    const payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
    const categoryId = (await t.repos.categories.insert({ name: "Utilities" })).id;
    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: checkingId,
      category_id: categoryId,
      date: "2026-01-15",
      amount_cents: 4_005,
      source: "manual",
    });
    await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: checkingId,
      category_id: categoryId,
      date: "2026-02-20",
      amount_cents: 2_000,
      source: "manual",
    });

    const grid = await getBillPayGridForYear(t.repos, 2026);
    const csv = formatYearSheetCsv(grid);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("40.05");
    expect(csv).toContain("20.00");
    expect(csv).toContain(formatCentsDecimal(grid.grand_total_cents));
    t.close();
  });
});

describe("report query performance guard", () => {
  it("answers each of the five report queries in under 100 ms on ~3,000 rows", async () => {
    const t = openTestDb();
    const accountId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
    const payeeId = (await t.repos.payees.insert({ name: "Payee A" })).id;
    const categoryId = (await t.repos.categories.insert({ name: "Utilities" })).id;

    let paymentIndex = 0;
    for (let year = 2021; year <= 2025; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        for (let row = 0; row < 50; row += 1) {
          paymentIndex += 1;
          const day = (row % 28) + 1;
          await t.repos.payments.insert({
            payee_id: payeeId,
            account_id: accountId,
            category_id: row % 5 === 0 ? null : categoryId,
            date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            amount_cents: 100 + paymentIndex,
            source: "manual",
          });
        }
      }
    }

    const [{ n }] = await t.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM transactions t WHERE t.payee_id IS NOT NULL AND (SELECT COUNT(*) FROM splits s WHERE s.transaction_id = t.id) = 2");
    expect(n).toBe(3_000);

    const filter = { from: "2021-01-01", to: "2025-12-31" };
    const queries = [
      { dimension: "category" as const, grain: "all" as const },
      { dimension: "payee" as const, grain: "all" as const },
      { dimension: "account" as const, grain: "all" as const },
      { dimension: "total" as const, grain: "month" as const },
      { dimension: "total" as const, grain: "year" as const },
    ];

    for (const query of queries) {
      const start = performance.now();
      const rows = await runReportQuery(t.repos, { ...query, filter });
      const durationMs = performance.now() - start;
      expect(rows.length).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(100);
    }

    t.close();
  });
});
