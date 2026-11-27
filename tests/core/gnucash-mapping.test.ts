import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAccountMapping,
  applyCategoryMapping,
  clearMapping,
  GnucashMappingConflictError,
  mappingStatus,
  suggestAccountMappings,
  suggestCategoryMappings,
} from "../../src/core/gnucash-mapping";
import type { Account, Category } from "../../src/core/entities";
import type { GnucashAccount } from "../../src/core/gnucash-types";
import { openTestDb, type TestDb } from "../support/test-db";

function finAccount(overrides: Partial<Account> & Pick<Account, "id" | "name">): Account {
  return {
    kind: "checking",
    last4: null,
    gnucash_guid: null,
    archived: false,
    ...overrides,
  };
}

function finCategory(overrides: Partial<Category> & Pick<Category, "id" | "name">): Category {
  return {
    parent_id: null,
    gnucash_guid: null,
    archived: false,
    ...overrides,
  };
}

function gnucashAccount(
  overrides: Partial<GnucashAccount> & Pick<GnucashAccount, "guid" | "name" | "account_type">,
): GnucashAccount {
  return {
    parent_guid: null,
    placeholder: false,
    commodity_mnemonic: "USD",
    commodity_fraction: 100,
    full_path: overrides.name,
    ...overrides,
  };
}

describe("suggestAccountMappings", () => {
  it("suggests only BANK/CASH/CREDIT/LIABILITY targets, never placeholders", () => {
    const fin = [finAccount({ id: 1, name: "Main Checking" })];
    const gnucash = [
      gnucashAccount({ guid: "bank-1", name: "main checking", account_type: "BANK" }),
      gnucashAccount({ guid: "exp-1", name: "main checking", account_type: "EXPENSE" }),
      gnucashAccount({
        guid: "ph-1",
        name: "main checking",
        account_type: "BANK",
        placeholder: true,
      }),
      gnucashAccount({ guid: "root-1", name: "main checking", account_type: "ROOT" }),
    ];

    const suggestions = suggestAccountMappings(fin, gnucash);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].gnucashGuid).toBe("bank-1");
    expect(suggestions.every((s) => s.gnucashGuid !== "exp-1")).toBe(true);
    expect(suggestions.every((s) => s.gnucashGuid !== "ph-1")).toBe(true);
    expect(suggestions.every((s) => s.gnucashGuid !== "root-1")).toBe(true);
  });

  it("pairs by case-insensitive name match with a reason", () => {
    const fin = [finAccount({ id: 10, name: "Main Checking" })];
    const gnucash = [
      gnucashAccount({ guid: "g-check", name: "main checking", account_type: "BANK" }),
    ];

    const suggestions = suggestAccountMappings(fin, gnucash);

    expect(suggestions).toEqual([
      {
        kind: "account",
        finEntityId: 10,
        gnucashGuid: "g-check",
        reason: expect.stringMatching(/name/i),
      },
    ]);
    expect(suggestions[0].reason.length).toBeGreaterThan(0);
  });

  it("pairs by last4 digits in the GnuCash account name", () => {
    const fin = [finAccount({ id: 2, name: "Checking", last4: "9002" })];
    const gnucash = [
      gnucashAccount({
        guid: "g-9002",
        name: "Checking …9002",
        account_type: "BANK",
      }),
      gnucashAccount({ guid: "g-other", name: "Savings", account_type: "BANK" }),
    ];

    const suggestions = suggestAccountMappings(fin, gnucash);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      kind: "account",
      finEntityId: 2,
      gnucashGuid: "g-9002",
      reason: expect.stringMatching(/last4|9002/i),
    });
  });

  it("excludes fin accounts that already have a gnucash_guid", () => {
    const fin = [
      finAccount({ id: 1, name: "Mapped", gnucash_guid: "already" }),
      finAccount({ id: 2, name: "Unmapped" }),
    ];
    const gnucash = [
      gnucashAccount({ guid: "g1", name: "mapped", account_type: "BANK" }),
      gnucashAccount({ guid: "g2", name: "unmapped", account_type: "BANK" }),
    ];

    const suggestions = suggestAccountMappings(fin, gnucash);

    expect(suggestions.map((s) => s.finEntityId)).toEqual([2]);
  });

  it("is pure — returns suggestions without mutating inputs or touching repos", () => {
    const fin = [finAccount({ id: 1, name: "Cash" })];
    const gnucash = [gnucashAccount({ guid: "g-cash", name: "cash", account_type: "CASH" })];
    const finCopy = structuredClone(fin);
    const gnucashCopy = structuredClone(gnucash);

    const suggestions = suggestAccountMappings(fin, gnucash);

    expect(suggestions).toHaveLength(1);
    expect(fin).toEqual(finCopy);
    expect(gnucash).toEqual(gnucashCopy);
  });

  it("returns deterministic ordering for the same input", () => {
    const fin = [
      finAccount({ id: 2, name: "B Account" }),
      finAccount({ id: 1, name: "A Account" }),
    ];
    const gnucash = [
      gnucashAccount({ guid: "g-b", name: "b account", account_type: "BANK" }),
      gnucashAccount({ guid: "g-a", name: "a account", account_type: "BANK" }),
    ];

    const first = suggestAccountMappings(fin, gnucash);
    const second = suggestAccountMappings(fin, gnucash);

    expect(first).toEqual(second);
  });
});

describe("suggestCategoryMappings", () => {
  it("suggests only EXPENSE targets, never placeholders", () => {
    const categories = [finCategory({ id: 1, name: "Electric" })];
    const gnucash = [
      gnucashAccount({
        guid: "exp-1",
        name: "Electric",
        account_type: "EXPENSE",
        full_path: "Expenses:Utilities:Electric",
      }),
      gnucashAccount({ guid: "bank-1", name: "Electric", account_type: "BANK" }),
      gnucashAccount({
        guid: "ph-1",
        name: "Electric",
        account_type: "EXPENSE",
        placeholder: true,
        full_path: "Expenses:Electric",
      }),
    ];

    const suggestions = suggestCategoryMappings(categories, gnucash);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].gnucashGuid).toBe("exp-1");
  });

  it("matches category name against GnuCash account name", () => {
    const categories = [finCategory({ id: 5, name: "Groceries" })];
    const gnucash = [
      gnucashAccount({
        guid: "g-groc",
        name: "groceries",
        account_type: "EXPENSE",
        full_path: "Expenses:Groceries",
      }),
    ];

    const suggestions = suggestCategoryMappings(categories, gnucash);

    expect(suggestions).toEqual([
      {
        kind: "category",
        finEntityId: 5,
        gnucashGuid: "g-groc",
        reason: expect.stringMatching(/name/i),
      },
    ]);
  });

  it("matches category name against full_path segments", () => {
    const categories = [finCategory({ id: 7, name: "Electric" })];
    const gnucash = [
      gnucashAccount({
        guid: "g-elec",
        name: "Utilities bucket",
        account_type: "EXPENSE",
        full_path: "Expenses:Utilities:Electric",
      }),
    ];

    const suggestions = suggestCategoryMappings(categories, gnucash);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      kind: "category",
      finEntityId: 7,
      gnucashGuid: "g-elec",
      reason: expect.stringMatching(/path|Electric/i),
    });
  });

  it("excludes categories that already have a gnucash_guid", () => {
    const categories = [
      finCategory({ id: 1, name: "Mapped", gnucash_guid: "mapped-guid" }),
      finCategory({ id: 2, name: "Rent" }),
    ];
    const gnucash = [
      gnucashAccount({
        guid: "g-mapped",
        name: "Mapped",
        account_type: "EXPENSE",
        full_path: "Expenses:Mapped",
      }),
      gnucashAccount({
        guid: "g-rent",
        name: "Rent",
        account_type: "EXPENSE",
        full_path: "Expenses:Rent",
      }),
    ];

    const suggestions = suggestCategoryMappings(categories, gnucash);

    expect(suggestions.map((s) => s.finEntityId)).toEqual([2]);
  });

  it("is pure — no side effects", () => {
    const categories = [finCategory({ id: 1, name: "Gas" })];
    const gnucash = [
      gnucashAccount({
        guid: "g-gas",
        name: "Gas",
        account_type: "EXPENSE",
        full_path: "Expenses:Gas",
      }),
    ];
    const catCopy = structuredClone(categories);
    const gnucashCopy = structuredClone(gnucash);

    suggestCategoryMappings(categories, gnucash);

    expect(categories).toEqual(catCopy);
    expect(gnucash).toEqual(gnucashCopy);
  });
});

describe("applyAccountMapping / applyCategoryMapping / clearMapping", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("applyAccountMapping patches gnucash_guid only", async () => {
    const created = await t.repos.accounts.insert({
      name: "Main Checking",
      kind: "checking",
      last4: "1234",
    });

    await applyAccountMapping(t.repos, created.id, "guid-abc");

    const updated = await t.repos.accounts.get(created.id);
    expect(updated).toEqual({ ...created, gnucash_guid: "guid-abc" });
  });

  it("applyCategoryMapping patches gnucash_guid only", async () => {
    const created = await t.repos.categories.insert({ name: "Utilities" });

    await applyCategoryMapping(t.repos, created.id, "cat-guid");

    const updated = await t.repos.categories.get(created.id);
    expect(updated).toEqual({ ...created, gnucash_guid: "cat-guid" });
  });

  it("remaps the same entity to a different GUID without error", async () => {
    const account = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });

    await applyAccountMapping(t.repos, account.id, "guid-one");
    await applyAccountMapping(t.repos, account.id, "guid-two");

    expect(await t.repos.accounts.get(account.id)).toEqual({
      ...account,
      gnucash_guid: "guid-two",
    });
  });

  it("clearMapping clears gnucash_guid for accounts and categories", async () => {
    const account = await t.repos.accounts.insert({
      name: "Cash",
      kind: "cash",
      gnucash_guid: "a-guid",
    });
    const category = await t.repos.categories.insert({
      name: "Food",
      gnucash_guid: "c-guid",
    });

    await clearMapping(t.repos, "account", account.id);
    await clearMapping(t.repos, "category", category.id);

    expect(await t.repos.accounts.get(account.id)).toEqual({ ...account, gnucash_guid: null });
    expect(await t.repos.categories.get(category.id)).toEqual({
      ...category,
      gnucash_guid: null,
    });
  });
});

describe("GnucashMappingConflictError", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("throws when mapping a duplicate account GUID to a different account", async () => {
    const a = await t.repos.accounts.insert({ name: "A", kind: "checking" });
    const b = await t.repos.accounts.insert({ name: "B", kind: "checking" });

    await applyAccountMapping(t.repos, a.id, "shared-guid");

    await expect(applyAccountMapping(t.repos, b.id, "shared-guid")).rejects.toBeInstanceOf(
      GnucashMappingConflictError,
    );
    expect(await t.repos.accounts.get(a.id)).toEqual({ ...a, gnucash_guid: "shared-guid" });
    expect(await t.repos.accounts.get(b.id)).toEqual({ ...b, gnucash_guid: null });
  });

  it("throws when mapping a duplicate category GUID to a different category", async () => {
    const a = await t.repos.categories.insert({ name: "Cat A" });
    const b = await t.repos.categories.insert({ name: "Cat B" });

    await applyCategoryMapping(t.repos, a.id, "cat-shared");

    await expect(applyCategoryMapping(t.repos, b.id, "cat-shared")).rejects.toBeInstanceOf(
      GnucashMappingConflictError,
    );
    expect(await t.repos.categories.get(a.id)).toEqual({ ...a, gnucash_guid: "cat-shared" });
    expect(await t.repos.categories.get(b.id)).toEqual({ ...b, gnucash_guid: null });
  });

  it("allows the same GUID on one account and one category", async () => {
    const account = await t.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const category = await t.repos.categories.insert({ name: "Misc" });

    await applyAccountMapping(t.repos, account.id, "cross-kind");
    await expect(
      applyCategoryMapping(t.repos, category.id, "cross-kind"),
    ).resolves.toBeUndefined();

    expect(await t.repos.accounts.get(account.id)).toEqual({
      ...account,
      gnucash_guid: "cross-kind",
    });
    expect(await t.repos.categories.get(category.id)).toEqual({
      ...category,
      gnucash_guid: "cross-kind",
    });
  });

  it("sets error name to GnucashMappingConflictError", async () => {
    const a = await t.repos.accounts.insert({ name: "One", kind: "checking" });
    const b = await t.repos.accounts.insert({ name: "Two", kind: "checking" });
    await applyAccountMapping(t.repos, a.id, "dup");

    try {
      await applyAccountMapping(t.repos, b.id, "dup");
      expect.fail("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(GnucashMappingConflictError);
      expect((error as Error).name).toBe("GnucashMappingConflictError");
    }
  });
});

describe("mappingStatus", () => {
  it("returns three unmapped lists", () => {
    const finAccounts = [
      finAccount({ id: 1, name: "Mapped", gnucash_guid: "g1" }),
      finAccount({ id: 2, name: "Unmapped" }),
    ];
    const categories = [
      finCategory({ id: 1, name: "Mapped Cat", gnucash_guid: "g2" }),
      finCategory({ id: 2, name: "Unmapped Cat" }),
    ];
    const gnucashAccounts = [
      gnucashAccount({ guid: "g1", name: "Bank", account_type: "BANK" }),
      gnucashAccount({ guid: "g2", name: "Expense", account_type: "EXPENSE" }),
      gnucashAccount({ guid: "g3", name: "Orphan", account_type: "BANK" }),
    ];

    const status = mappingStatus(finAccounts, categories, gnucashAccounts);

    expect(Object.keys(status).sort()).toEqual([
      "unmappedCategories",
      "unmappedFinAccounts",
      "unmappedGnucashAccounts",
    ]);
    expect(status.unmappedFinAccounts.map((a) => a.id)).toEqual([2]);
    expect(status.unmappedCategories.map((c) => c.id)).toEqual([2]);
    expect(status.unmappedGnucashAccounts.map((g) => g.guid)).toEqual(["g3"]);
  });

  it("is pure — operates on supplied arrays only", () => {
    const finAccounts = [finAccount({ id: 1, name: "A" })];
    const categories = [finCategory({ id: 1, name: "C" })];
    const gnucashAccounts = [
      gnucashAccount({ guid: "orphan", name: "Orphan", account_type: "BANK" }),
    ];

    const status = mappingStatus(finAccounts, categories, gnucashAccounts);

    expect(status.unmappedFinAccounts).toHaveLength(1);
    expect(status.unmappedCategories).toHaveLength(1);
    expect(status.unmappedGnucashAccounts).toHaveLength(1);
  });
});
