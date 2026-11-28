import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityInUseError, ValidationError, createIncome } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

describe("accounts repository", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("round-trips insert and list", async () => {
    const checking = await t.repos.accounts.insert({
      name: "Main Checking",
      kind: "checking",
      last4: "1234",
    });
    const cash = await t.repos.accounts.insert({ name: "Cash", kind: "cash" });

    expect(checking).toEqual({
      id: checking.id,
      name: "Main Checking",
      kind: "checking",
      type: "ASSET",
      subtype: "bank",
      parent_id: checking.parent_id,
      last4: "1234",
      gnucash_guid: null,
      archived: false,
    });
    const assetRoot = await t.repos.ledger.getSystemAccount("root_asset");
    expect(checking.parent_id).toBe(assetRoot?.id);
    expect(cash.last4).toBeNull();

    const listed = await t.repos.accounts.list();
    expect(listed).toEqual([cash, checking]); // ordered by name
  });

  it("gets by id, null when unknown", async () => {
    const created = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });
    expect(await t.repos.accounts.get(created.id)).toEqual(created);
    expect(await t.repos.accounts.get(9999)).toBeNull();
  });

  it("updates only the patched fields", async () => {
    const created = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });
    const updated = await t.repos.accounts.update(created.id, { last4: "9876" });
    expect(updated).toEqual({ ...created, last4: "9876" });
    expect(await t.repos.accounts.update(9999, { name: "nope" })).toBeNull();
  });

  it("validates account name and last4", async () => {
    await expect(t.repos.accounts.insert({ name: "", kind: "checking" })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      t.repos.accounts.insert({ name: "Main", kind: "checking", last4: "12" }),
    ).rejects.toThrow(ValidationError);

    const created = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });
    await expect(t.repos.accounts.update(created.id, { last4: "abcd" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("archive hides from default list but keeps the row reachable", async () => {
    const account = await t.repos.accounts.insert({ name: "Old Bank", kind: "checking" });
    expect(await t.repos.accounts.archive(account.id)).toBe(true);

    expect(await t.repos.accounts.list()).toEqual([]);
    expect(await t.repos.accounts.list({ includeArchived: true })).toEqual([
      { ...account, archived: true },
    ]);
    expect(await t.repos.accounts.get(account.id)).toEqual({ ...account, archived: true });
    expect(await t.repos.accounts.archive(9999)).toBe(false);
  });

  it("blocks delete when payments reference the account and allows archive path", async () => {
    const payee = await t.repos.payees.insert({ name: "Power Co" });
    const account = await t.repos.accounts.insert({ name: "Main", kind: "checking" });

    await t.repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      date: "2026-02-10",
      amount_cents: 3000,
      source: "manual",
    });

    await expect(t.repos.accounts.delete(account.id)).rejects.toThrow(EntityInUseError);
    expect(await t.repos.accounts.archive(account.id)).toBe(true);
  });

  it("deletes an unreferenced account", async () => {
    const account = await t.repos.accounts.insert({ name: "Temp Account", kind: "cash" });
    expect(await t.repos.accounts.delete(account.id)).toBe(true);
    expect(await t.repos.accounts.get(account.id)).toBeNull();
    expect(await t.repos.accounts.delete(account.id)).toBe(false);
  });

  it("derives kind from type/subtype and parents under the matching root", async () => {
    const liabilityRoot = await t.repos.ledger.getSystemAccount("root_liability");
    const expected = [
      ["checking", "ASSET", "bank"],
      ["cash", "ASSET", "cash"],
      ["savings", "ASSET", "savings"],
      ["credit", "LIABILITY", "credit_card"],
      ["loan", "LIABILITY", "loan"],
    ] as const;
    for (const [kind, type, subtype] of expected) {
      const created = await t.repos.accounts.insert({ name: `acct-${kind}`, kind });
      expect(created).toMatchObject({ kind, type, subtype });
      if (type === "LIABILITY") expect(created.parent_id).toBe(liabilityRoot?.id);
    }
  });

  it("lists funding accounts only: never roots, placeholders or EXPENSE/INCOME/EQUITY accounts", async () => {
    const funding = await t.repos.accounts.insert({ name: "Main", kind: "checking" });
    const root = (await t.repos.ledger.getSystemAccount("root_expense"))!;
    const expenseLeaf = await t.repos.ledger.insertAccount({
      name: "Food",
      type: "EXPENSE",
      parent_id: root.id,
    });
    const incomeRoot = (await t.repos.ledger.getSystemAccount("root_income"))!;
    const income = await t.repos.ledger.insertAccount({
      name: "Salary",
      type: "INCOME",
      parent_id: incomeRoot.id,
    });
    const assetRoot = (await t.repos.ledger.getSystemAccount("root_asset"))!;
    const placeholder = await t.repos.ledger.insertAccount({
      name: "Bank Group",
      type: "ASSET",
      parent_id: assetRoot.id,
      placeholder: true,
    });

    const all = await t.repos.accounts.list({ includeArchived: true });
    expect(all.map((a) => a.id)).toEqual([funding.id]);
    for (const hidden of [root, expenseLeaf, income, placeholder, assetRoot]) {
      expect(await t.repos.accounts.get(hidden.id)).toBeNull();
      expect(all.some((a) => a.id === hidden.id)).toBe(false);
    }
    expect(await t.repos.accounts.archive(expenseLeaf.id)).toBe(false);
    expect(await t.repos.accounts.update(expenseLeaf.id, { name: "x" })).toBeNull();
    expect(await t.repos.accounts.delete(expenseLeaf.id)).toBe(false);
  });

  it("changing kind across asset/liability moves the account under the other root", async () => {
    const account = await t.repos.accounts.insert({ name: "Flip", kind: "checking" });
    const flipped = await t.repos.accounts.update(account.id, { kind: "credit" });
    const liabilityRoot = await t.repos.ledger.getSystemAccount("root_liability");
    expect(flipped).toMatchObject({
      kind: "credit",
      type: "LIABILITY",
      subtype: "credit_card",
      parent_id: liabilityRoot?.id,
    });
    const sameType = await t.repos.accounts.update(account.id, { kind: "loan" });
    expect(sameType).toMatchObject({ kind: "loan", subtype: "loan" });
  });

  it("refuses a cross-type kind change when the account has child accounts", async () => {
    const account = await t.repos.accounts.insert({ name: "Parent Bank", kind: "checking" });
    await t.repos.ledger.insertAccount({
      name: "Child Bank",
      type: "ASSET",
      parent_id: account.id,
    });

    await expect(t.repos.accounts.update(account.id, { kind: "credit" })).rejects.toThrow(
      ValidationError,
    );
    const after = await t.repos.accounts.get(account.id);
    expect(after?.type).toBe("ASSET");
    expect(after?.parent_id).toBe(account.parent_id);
    expect(after?.kind).toBe("checking");
  });

  it("blocks delete when a payee default or any split references the account", async () => {
    const account = await t.repos.accounts.insert({ name: "Main", kind: "checking" });
    await t.repos.payees.insert({ name: "Power Co", default_account_id: account.id });
    await expect(t.repos.accounts.delete(account.id)).rejects.toThrow(EntityInUseError);

    // A non-payment (transfer-shaped) split also blocks delete.
    const other = await t.repos.accounts.insert({ name: "Other", kind: "cash" });
    const income = (await t.repos.ledger.getSystemAccount("root_income"))!;
    const salary = await t.repos.ledger.insertAccount({
      name: "Salary",
      type: "INCOME",
      parent_id: income.id,
    });
    await createIncome(t.repos.ledger, {
      date: "2026-01-01",
      incomeAccountId: salary.id,
      depositAccountId: other.id,
      amount_cents: 100,
    });
    await expect(t.repos.accounts.delete(other.id)).rejects.toThrow(EntityInUseError);
  });
});
