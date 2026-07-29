import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Database, type Repositories, type SqlValue } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

function wrapWithBrokenLastInsertId(db: Database): Database {
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      const result = await db.execute(sql, params);
      if (/^\s*insert\s+into\s+/i.test(sql)) {
        return { ...result, lastInsertId: 0 };
      }
      return result;
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return db.select<T>(sql, params);
    },
    async transaction<T>(work: (tx: Database) => Promise<T>) {
      return db.transaction((txDb) => work(wrapWithBrokenLastInsertId(txDb)));
    },
  };
}

function wrapWithFixedLastInsertId(db: Database, fixedId: number): Database {
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      const result = await db.execute(sql, params);
      if (/^\s*insert\s+into\s+/i.test(sql)) {
        return { ...result, lastInsertId: fixedId };
      }
      return result;
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return db.select<T>(sql, params);
    },
    async transaction<T>(work: (tx: Database) => Promise<T>) {
      return db.transaction((txDb) => work(wrapWithFixedLastInsertId(txDb, fixedId)));
    },
  };
}

describe("repository insert fallback when lastInsertId is unreliable", () => {
  let t: TestDb;
  let repos: Repositories;

  beforeEach(() => {
    t = openTestDb();
    repos = createRepositories(wrapWithBrokenLastInsertId(t.db));
  });

  afterEach(() => t.close());

  it("accounts.insert returns the created row via payload fallback", async () => {
    const created = await repos.accounts.insert({
      name: "Fallback Checking",
      kind: "checking",
      last4: "2211",
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe("Fallback Checking");
    expect(created.last4).toBe("2211");
  });

  it("categories.insert returns the created row via payload fallback", async () => {
    const parent = await repos.categories.insert({ name: "Fallback Parent" });
    const child = await repos.categories.insert({
      name: "Fallback Child",
      parent_id: parent.id,
    });

    expect(parent.id).toBeGreaterThan(0);
    expect(child.id).toBeGreaterThan(0);
    expect(child.parent_id).toBe(parent.id);
  });

  it("payees.insert returns the created row via payload fallback", async () => {
    const account = await repos.accounts.insert({ name: "Fallback Debit", kind: "checking" });
    const category = await repos.categories.insert({ name: "Fallback Utilities" });

    const payee = await repos.payees.insert({
      name: "Fallback Power Co",
      default_account_id: account.id,
      default_category_id: category.id,
      notes: "autopay",
    });

    expect(payee.id).toBeGreaterThan(0);
    expect(payee.default_account_id).toBe(account.id);
    expect(payee.default_category_id).toBe(category.id);
  });

  it("payments.insert returns the created row via payload fallback", async () => {
    const account = await repos.accounts.insert({ name: "Fallback Visa", kind: "credit" });
    const payee = await repos.payees.insert({ name: "Fallback Telecom" });

    const payment = await repos.payments.insert({
      payee_id: payee.id,
      account_id: account.id,
      date: "2026-07-01",
      amount_cents: 4999,
      source: "manual",
    });

    expect(payment.id).toBeGreaterThan(0);
    expect(payment.payee_id).toBe(payee.id);
    expect(payment.account_id).toBe(account.id);
    expect(payment.amount_cents).toBe(4999);
  });

  it("import_log.append returns the created row via payload fallback", async () => {
    const entry = await repos.importLog.append({
      source_file: "fallback-fixture.xlsx",
      content_hash: "fallback-hash-001",
      row_count: 12,
    });

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.content_hash).toBe("fallback-hash-001");
  });

  it("recovers when lastInsertId points to an existing row with mismatched payload", async () => {
    const seeded = await t.repos.accounts.insert({
      name: "Seeded Account",
      kind: "checking",
      last4: "0000",
    });

    const mismatchRepos = createRepositories(wrapWithFixedLastInsertId(t.db, seeded.id));
    const created = await mismatchRepos.accounts.insert({
      name: "Recovered Account",
      kind: "checking",
      last4: "9999",
    });

    expect(created.id).not.toBe(seeded.id);
    expect(created.name).toBe("Recovered Account");
    expect(created.last4).toBe("9999");
  });

  it("fails when payload fallback is ambiguous", async () => {
    await t.repos.importLog.append({
      source_file: "different.xlsx",
      content_hash: "different-hash",
      row_count: 1,
    });

    await t.repos.importLog.append({
      source_file: "ambiguous.xlsx",
      content_hash: "ambiguous-hash",
      row_count: 7,
    });

    await t.repos.importLog.append({
      source_file: "ambiguous.xlsx",
      content_hash: "ambiguous-hash",
      row_count: 7,
    });

    const ambiguousRepos = createRepositories(wrapWithFixedLastInsertId(t.db, 1));

    await expect(
      ambiguousRepos.importLog.append({
        source_file: "ambiguous.xlsx",
        content_hash: "ambiguous-hash",
        row_count: 7,
      }),
    ).rejects.toThrow(/payload query is ambiguous/i);
  });
});
