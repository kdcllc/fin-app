import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityInUseError, ValidationError } from "../../src/core";
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
      last4: "1234",
      gnucash_guid: null,
      archived: false,
    });
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
});
