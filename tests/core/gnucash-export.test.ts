import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account, Category, Payee, Payment } from "../../src/core/entities";
import type { GnucashAccount } from "../../src/core/gnucash-types";
import {
  buildCsv,
  buildQif,
  listExportablePayments,
  recordExport,
  validateForExport,
  type ExportBuildInput,
} from "../../src/core/gnucash-export";
import { openTestDb, type TestDb } from "../support/test-db";

function payment(overrides: Partial<Payment> & Pick<Payment, "id">): Payment {
  return {
    payee_id: 1,
    account_id: 1,
    category_id: 1,
    date: "2026-02-15",
    amount_cents: 1000,
    memo: null,
    source: "manual",
    external_ref: null,
    source_sheet: null,
    source_row: null,
    source_col: null,
    occurrence_index: null,
    created_at: "2026-02-15 12:00:00",
    ...overrides,
  };
}

function account(overrides: Partial<Account> & Pick<Account, "id" | "name">): Account {
  return {
    kind: "checking",
    last4: null,
    gnucash_guid: "acct-guid",
    archived: false,
    ...overrides,
  };
}

function category(overrides: Partial<Category> & Pick<Category, "id" | "name">): Category {
  return {
    parent_id: null,
    gnucash_guid: "cat-guid",
    archived: false,
    ...overrides,
  };
}

function payee(overrides: Partial<Payee> & Pick<Payee, "id" | "name">): Payee {
  return {
    default_category_id: null,
    default_account_id: null,
    notes: null,
    archived: false,
    ...overrides,
  };
}

function gnucashAccount(
  overrides: Partial<GnucashAccount> & Pick<GnucashAccount, "guid" | "full_path">,
): GnucashAccount {
  return {
    name: overrides.full_path.split(":").pop() ?? overrides.full_path,
    account_type: "BANK",
    parent_guid: null,
    placeholder: false,
    commodity_mnemonic: "USD",
    commodity_fraction: 100,
    ...overrides,
  };
}

function buildInput(overrides: Partial<ExportBuildInput> & Pick<ExportBuildInput, "payments">): ExportBuildInput {
  const accounts = overrides.accounts ?? [
    account({ id: 1, name: "Checking", gnucash_guid: "acct-guid", kind: "checking" }),
  ];
  const categories = overrides.categories ?? [
    category({ id: 1, name: "Utilities", gnucash_guid: "cat-guid" }),
  ];
  const gnucashAccounts = overrides.gnucashAccounts ?? [
    gnucashAccount({ guid: "acct-guid", full_path: "Assets:Checking", account_type: "BANK" }),
    gnucashAccount({
      guid: "cat-guid",
      full_path: "Expenses:Utilities:Electric",
      account_type: "EXPENSE",
    }),
  ];
  const payees = overrides.payees ?? [payee({ id: 1, name: "Power Co" })];
  return {
    accounts,
    categories,
    gnucashAccounts,
    payees,
    ...overrides,
  };
}

describe("listExportablePayments", () => {
  let t: TestDb;
  let accountId: number;
  let payeeId: number;
  let categoryId: number;

  beforeEach(async () => {
    t = openTestDb();
    accountId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
    payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
    categoryId = (await t.repos.categories.insert({ name: "Utilities" })).id;
  });
  afterEach(() => t.close());

  async function seedPayment(date: string, amount_cents = 1000) {
    return t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date,
      amount_cents,
      source: "manual",
    });
  }

  it("returns only payments in the inclusive date window", async () => {
    const jan = await seedPayment("2026-01-31");
    const feb = await seedPayment("2026-02-15");
    const mar = await seedPayment("2026-03-01");

    const result = await listExportablePayments(t.db, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      includeExported: false,
    });

    expect(result.map((p) => p.id)).toEqual([feb.id]);
    expect(result.every((p) => p.exportHistory)).toBeTruthy();
    expect(result[0].exportHistory).toEqual([]);
    void jan;
    void mar;
  });

  it("excludes exported payments by default", async () => {
    const exported = await seedPayment("2026-02-10");
    const fresh = await seedPayment("2026-02-11");
    await t.db.execute(
      "INSERT INTO payment_exports (payment_id, format, exported_at) VALUES (?, 'qif', '2026-02-12 10:00:00')",
      [exported.id],
    );

    const result = await listExportablePayments(t.db, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      includeExported: false,
    });

    expect(result.map((p) => p.id)).toEqual([fresh.id]);
  });

  it("includes exported payments when includeExported is true", async () => {
    const exported = await seedPayment("2026-02-10");
    await t.db.execute(
      "INSERT INTO payment_exports (payment_id, format, exported_at) VALUES (?, 'csv', '2026-02-12 10:00:00')",
      [exported.id],
    );

    const result = await listExportablePayments(t.db, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      includeExported: true,
    });

    expect(result.map((p) => p.id)).toEqual([exported.id]);
    expect(result[0].exportHistory).toEqual([
      { format: "csv", exportedAt: "2026-02-12 10:00:00" },
    ]);
  });

  it("returns export history ordered oldest to newest", async () => {
    const p = await seedPayment("2026-02-10");
    await t.db.execute(
      "INSERT INTO payment_exports (payment_id, format, exported_at) VALUES (?, 'qif', '2026-02-12 08:00:00')",
      [p.id],
    );
    await t.db.execute(
      "INSERT INTO payment_exports (payment_id, format, exported_at) VALUES (?, 'csv', '2026-02-12 12:00:00')",
      [p.id],
    );

    const result = await listExportablePayments(t.db, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      includeExported: true,
    });

    expect(result[0].exportHistory).toEqual([
      { format: "qif", exportedAt: "2026-02-12 08:00:00" },
      { format: "csv", exportedAt: "2026-02-12 12:00:00" },
    ]);
  });
});

describe("validateForExport", () => {
  it("ignores gnucashAccounts and reads mapping from entity gnucash_guid columns", () => {
    const payments = [payment({ id: 1 })];
    const accounts = [account({ id: 1, name: "Checking", gnucash_guid: null })];
    const categories = [category({ id: 1, name: "Utilities", gnucash_guid: "cat-guid" })];
    const gnucashAccounts = [
      gnucashAccount({ guid: "orphan", full_path: "Assets:Checking", account_type: "BANK" }),
    ];

    const result = validateForExport(payments, accounts, categories);

    expect(result.blockers.some((b) => b.paymentId === 1 && /account/i.test(b.reason))).toBe(true);
    void gnucashAccounts;
  });

  it("blocks payments whose funding account lacks gnucash_guid", () => {
    const payments = [payment({ id: 42, account_id: 2 })];
    const accounts = [
      account({ id: 1, name: "Mapped", gnucash_guid: "g1" }),
      account({ id: 2, name: "Unmapped", gnucash_guid: null }),
    ];
    const categories = [category({ id: 1, name: "Cat", gnucash_guid: "c1" })];

    const result = validateForExport(payments, accounts, categories);

    expect(result.blockers).toEqual([
      expect.objectContaining({ paymentId: 42, reason: expect.stringMatching(/account/i) }),
    ]);
  });

  it("blocks payments with null category_id", () => {
    const payments = [payment({ id: 5, category_id: null })];
    const accounts = [account({ id: 1, name: "Checking" })];
    const categories = [category({ id: 1, name: "Utilities" })];

    const result = validateForExport(payments, accounts, categories);

    expect(result.blockers.some((b) => b.paymentId === 5 && /category/i.test(b.reason))).toBe(true);
  });

  it("blocks payments whose category lacks gnucash_guid", () => {
    const payments = [payment({ id: 6, category_id: 2 })];
    const accounts = [account({ id: 1, name: "Checking" })];
    const categories = [
      category({ id: 1, name: "Mapped", gnucash_guid: "c1" }),
      category({ id: 2, name: "Unmapped", gnucash_guid: null }),
    ];

    const result = validateForExport(payments, accounts, categories);

    expect(result.blockers.some((b) => b.paymentId === 6 && /category/i.test(b.reason))).toBe(true);
  });

  it("returns no blockers for fully mapped payments", () => {
    const payments = [payment({ id: 1 })];
    const accounts = [account({ id: 1, name: "Checking" })];
    const categories = [category({ id: 1, name: "Utilities" })];

    expect(validateForExport(payments, accounts, categories).blockers).toEqual([]);
  });

  it("returns at least one blocker when both account and category are unmapped", () => {
    const payments = [payment({ id: 99, account_id: 2, category_id: 2 })];
    const accounts = [
      account({ id: 1, name: "Mapped", gnucash_guid: "g1" }),
      account({ id: 2, name: "Unmapped", gnucash_guid: null }),
    ];
    const categories = [
      category({ id: 1, name: "Mapped", gnucash_guid: "c1" }),
      category({ id: 2, name: "Unmapped", gnucash_guid: null }),
    ];

    const result = validateForExport(payments, accounts, categories);

    expect(result.blockers.some((b) => b.paymentId === 99)).toBe(true);
    expect(result.blockers.some((b) => /account/i.test(b.reason))).toBe(true);
    expect(result.blockers.some((b) => /category/i.test(b.reason))).toBe(true);
  });
});

describe("buildQif", () => {
  it("throws when a payment account or category is unmapped", () => {
    const input = buildInput({
      payments: [payment({ id: 1 })],
      accounts: [account({ id: 1, name: "Checking", gnucash_guid: null })],
    });

    expect(() => buildQif(input)).toThrow(/account|mapping|guid/i);
  });

  it("groups sections by funding account ordered by GnuCash full_path", () => {
    const input = buildInput({
      payments: [
        payment({ id: 2, account_id: 2, date: "2026-02-10" }),
        payment({ id: 1, account_id: 1, date: "2026-02-11" }),
      ],
      accounts: [
        account({ id: 1, name: "Savings", gnucash_guid: "save-guid", kind: "checking" }),
        account({ id: 2, name: "Checking", gnucash_guid: "check-guid", kind: "checking" }),
      ],
      gnucashAccounts: [
        gnucashAccount({ guid: "check-guid", full_path: "Assets:Checking", account_type: "BANK" }),
        gnucashAccount({ guid: "save-guid", full_path: "Assets:Savings", account_type: "BANK" }),
        gnucashAccount({
          guid: "cat-guid",
          full_path: "Expenses:Utilities:Electric",
          account_type: "EXPENSE",
        }),
      ],
    });

    const qif = buildQif(input);
    const checkingIndex = qif.indexOf("Assets:Checking");
    const savingsIndex = qif.indexOf("Assets:Savings");

    expect(checkingIndex).toBeGreaterThanOrEqual(0);
    expect(savingsIndex).toBeGreaterThan(checkingIndex);
  });

  it("emits !Type from fin-app account kind, not GnuCash account_type", () => {
    const kinds: Array<{ kind: Account["kind"]; type: string }> = [
      { kind: "checking", type: "Bank" },
      { kind: "cash", type: "Cash" },
      { kind: "credit", type: "CCard" },
    ];

    for (const { kind, type } of kinds) {
      const input = buildInput({
        payments: [payment({ id: 1, account_id: 1 })],
        accounts: [account({ id: 1, name: "Acct", gnucash_guid: "acct-guid", kind })],
        gnucashAccounts: [
          gnucashAccount({
            guid: "acct-guid",
            full_path: "Liabilities:CreditCard",
            account_type: kind === "credit" ? "LIABILITY" : "BANK",
          }),
          gnucashAccount({
            guid: "cat-guid",
            full_path: "Expenses:Utilities:Electric",
            account_type: "EXPENSE",
          }),
        ],
      });

      expect(buildQif(input)).toContain(`!Type:${type}`);
    }
  });

  it("orders records by date then id within a section", () => {
    const input = buildInput({
      payments: [
        payment({ id: 3, date: "2026-02-20", amount_cents: 300 }),
        payment({ id: 1, date: "2026-02-10", amount_cents: 100 }),
        payment({ id: 2, date: "2026-02-10", amount_cents: 200 }),
      ],
    });

    const qif = buildQif(input);
    const first = qif.indexOf("D02/10/2026");
    const second = qif.indexOf("D02/10/2026", first + 1);
    const third = qif.indexOf("D02/20/2026");

    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(qif.indexOf("T-1.00")).toBeLessThan(qif.indexOf("T-2.00"));
  });

  it("formats golden QIF record with memo and pinned money-out amounts", () => {
    const input = buildInput({
      payments: [
        payment({ id: 1, date: "2026-02-15", amount_cents: 1, memo: "tiny" }),
        payment({ id: 2, date: "2026-03-01", amount_cents: 1067391, memo: null }),
      ],
      payees: [payee({ id: 1, name: "Power Co" })],
    });

    const qif = buildQif(input);

    expect(qif).toContain("!Account");
    expect(qif).toContain("Assets:Checking");
    expect(qif).toContain("!Type:Bank");
    expect(qif).toContain("D02/15/2026");
    expect(qif).toContain("T-0.01");
    expect(qif).toContain("PPower Co");
    expect(qif).toContain("LExpenses:Utilities:Electric");
    expect(qif).toContain("Mtiny");
    expect(qif).toContain("T-10673.91");
    expect(qif).not.toContain("M\n^");
    expect(qif.split("^").length - 1).toBe(2);
  });

  it("is deterministic for identical input", () => {
    const input = buildInput({ payments: [payment({ id: 1 })] });
    expect(buildQif(input)).toBe(buildQif(input));
  });
});

describe("buildCsv", () => {
  it("throws when a payment account or category is unmapped", () => {
    const input = buildInput({
      payments: [payment({ id: 1, category_id: 2 })],
      categories: [category({ id: 2, name: "Unmapped", gnucash_guid: null })],
    });

    expect(() => buildCsv(input)).toThrow(/category|mapping|guid/i);
  });

  it("starts with the exact header row", () => {
    const csv = buildCsv(buildInput({ payments: [payment({ id: 1 })] }));
    expect(csv.split("\n")[0]).toBe("date,account,description,category,amount");
  });

  it("keeps ISO dates and pinned money-out amounts", () => {
    const input = buildInput({
      payments: [
        payment({ id: 1, date: "2026-02-15", amount_cents: 1 }),
        payment({ id: 2, date: "2026-03-01", amount_cents: 1067391 }),
      ],
    });

    const lines = buildCsv(input).split("\n").slice(1);

    expect(lines[0]).toBe(
      "2026-02-15,Assets:Checking,Power Co,Expenses:Utilities:Electric,-0.01",
    );
    expect(lines[1]).toBe(
      "2026-03-01,Assets:Checking,Power Co,Expenses:Utilities:Electric,-10673.91",
    );
  });

  it("formats inflow (negative stored cents) as positive decimal without plus prefix", () => {
    const input = buildInput({
      payments: [payment({ id: 1, amount_cents: -100 })],
    });

    const line = buildCsv(input).split("\n")[1];
    expect(line?.endsWith(",1.00")).toBe(true);
  });

  it("RFC-4180 quotes fields with commas or embedded quotes", () => {
    const input = buildInput({
      payments: [payment({ id: 1 })],
      payees: [payee({ id: 1, name: 'Acme, "Best" Co' })],
      gnucashAccounts: [
        gnucashAccount({ guid: "acct-guid", full_path: "Assets:Checking", account_type: "BANK" }),
        gnucashAccount({
          guid: "cat-guid",
          full_path: "Expenses:Food,Dining",
          account_type: "EXPENSE",
        }),
      ],
    });

    const line = buildCsv(input).split("\n")[1];
    expect(line).toContain('"Acme, ""Best"" Co"');
    expect(line).toContain('"Expenses:Food,Dining"');
  });

  it("orders rows by account path, date, then id", () => {
    const input = buildInput({
      payments: [
        payment({ id: 3, account_id: 2, date: "2026-02-20" }),
        payment({ id: 1, account_id: 1, date: "2026-02-10" }),
        payment({ id: 2, account_id: 1, date: "2026-02-10" }),
      ],
      accounts: [
        account({ id: 1, name: "Checking", gnucash_guid: "check-guid" }),
        account({ id: 2, name: "Savings", gnucash_guid: "save-guid" }),
      ],
      gnucashAccounts: [
        gnucashAccount({ guid: "check-guid", full_path: "Assets:Checking", account_type: "BANK" }),
        gnucashAccount({ guid: "save-guid", full_path: "Assets:Savings", account_type: "BANK" }),
        gnucashAccount({
          guid: "cat-guid",
          full_path: "Expenses:Utilities:Electric",
          account_type: "EXPENSE",
        }),
      ],
    });

    const rows = buildCsv(input).split("\n").slice(1);
    expect(rows[0]?.startsWith("2026-02-10,")).toBe(true);
    expect(rows[1]?.startsWith("2026-02-10,")).toBe(true);
    expect(rows[2]?.startsWith("2026-02-20,")).toBe(true);
  });

  it("is deterministic for identical input", () => {
    const input = buildInput({ payments: [payment({ id: 1 })] });
    expect(buildCsv(input)).toBe(buildCsv(input));
  });
});

describe("recordExport", () => {
  let t: TestDb;
  let paymentIds: number[];

  beforeEach(async () => {
    t = openTestDb();
    const accountId = (await t.repos.accounts.insert({ name: "Checking", kind: "checking" })).id;
    const payeeId = (await t.repos.payees.insert({ name: "Power Co" })).id;
    const categoryId = (await t.repos.categories.insert({ name: "Utilities" })).id;
    const p1 = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-10",
      amount_cents: 1000,
      source: "manual",
    });
    const p2 = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-11",
      amount_cents: 2000,
      source: "manual",
    });
    paymentIds = [p1.id, p2.id];
  });
  afterEach(() => t.close());

  it("inserts one batch with one row per payment id", async () => {
    t.calls.length = 0;

    await recordExport(t.db, paymentIds, "qif");

    const batchCalls = t.calls.filter((c) => c.kind === "batch");
    expect(batchCalls).toHaveLength(1);

    const rows = await t.db.select<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM payment_exports WHERE format = 'qif'",
    );
    expect(rows[0]?.cnt).toBe(2);
  });

  it("preserves history on re-export", async () => {
    await recordExport(t.db, [paymentIds[0]], "qif");
    await recordExport(t.db, [paymentIds[0]], "csv");

    const rows = await t.db.select<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM payment_exports WHERE payment_id = ?",
      [paymentIds[0]],
    );
    expect(rows[0]?.cnt).toBe(2);
  });

  it("excludes recorded payments from default list and includes them on forced re-export", async () => {
    await recordExport(t.db, paymentIds, "csv");

    const excluded = await listExportablePayments(t.db, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      includeExported: false,
    });
    expect(excluded).toHaveLength(0);

    const included = await listExportablePayments(t.db, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      includeExported: true,
    });
    expect(included).toHaveLength(2);
    expect(included.every((p) => p.exportHistory.length === 1)).toBe(true);
    expect(included.every((p) => p.exportHistory[0]?.format === "csv")).toBe(true);
  });
});
