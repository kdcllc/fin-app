import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ForeignKeyViolationError } from "../../src/core";
import type { Payment } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/excel");

type XlsxImportFixture = {
  source_file: string;
  candidates: Array<{
    date: string;
    amount_cents: number;
    source_sheet: string;
    source_row: number;
    source_col: number;
    occurrence_index: number;
  }>;
};

function loadXlsxImportFixture(fileName: string): { hash: string; fixture: XlsxImportFixture } {
  const bytes = readFileSync(resolve(FIXTURES_DIR, fileName));
  const fixture = JSON.parse(bytes.toString("utf8")) as XlsxImportFixture;
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { hash, fixture };
}

describe("payments repository", () => {
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

  function pay(date: string, amount_cents: number, extra: Partial<Payment> = {}) {
    return t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date,
      amount_cents,
      source: "manual",
      ...extra,
    });
  }

  it("round-trips insert with exact integer cents", async () => {
    // 4005 cents = $40.05 — a value that would wobble as a float (40.05 * 100 = 4004.99…).
    const payment = await pay("2026-02-15", 4005, { memo: "Feb bill" });

    expect(payment).toEqual({
      id: payment.id,
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-15",
      amount_cents: 4005,
      memo: "Feb bill",
      source: "manual",
      external_ref: null,
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
    expect(Number.isInteger(payment.amount_cents)).toBe(true);

    const [listed] = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(listed.amount_cents).toBe(4005);
  });

  it("filters by inclusive date window", async () => {
    const jan = await pay("2026-01-31", 1000);
    const febFirst = await pay("2026-02-01", 2000);
    const febLast = await pay("2026-02-28", 3000);
    const mar = await pay("2026-03-01", 4000);

    const february = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(february.map((p) => p.id)).toEqual([febFirst.id, febLast.id]); // bounds inclusive

    const all = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(all.map((p) => p.id)).toEqual([jan.id, febFirst.id, febLast.id, mar.id]);
    expect(all.reduce((sum, p) => sum + p.amount_cents, 0)).toBe(10000); // exact cents
  });

  it("filters by payee, account, and category", async () => {
    const otherPayee = await t.repos.payees.insert({ name: "Water Co" });
    const otherAccount = await t.repos.accounts.insert({ name: "Visa", kind: "credit" });

    const mine = await pay("2026-02-10", 1500);
    await pay("2026-02-11", 2500, { payee_id: otherPayee.id, category_id: null });
    await pay("2026-02-12", 3500, { account_id: otherAccount.id });

    const window = { from: "2026-02-01", to: "2026-02-28" };
    expect(await t.repos.payments.list({ ...window, payeeId })).toHaveLength(2);
    expect(await t.repos.payments.list({ ...window, accountId: otherAccount.id })).toHaveLength(1);
    expect(
      (await t.repos.payments.list({ ...window, payeeId, accountId, categoryId })).map((p) => p.id),
    ).toEqual([mine.id]);
  });

  it("updates and deletes", async () => {
    const payment = await pay("2026-02-15", 4005);
    const updated = await t.repos.payments.update(payment.id, {
      amount_cents: 4105,
      memo: "corrected",
    });
    expect(updated).toEqual({ ...payment, amount_cents: 4105, memo: "corrected" });

    expect(await t.repos.payments.delete(payment.id)).toBe(true);
    expect(await t.repos.payments.get(payment.id)).toBeNull();
    expect(await t.repos.payments.delete(payment.id)).toBe(false);
  });

  it("keeps history intact when the payee is archived", async () => {
    const payment = await pay("2026-02-15", 4005);
    await t.repos.payees.archive(payeeId);

    const listed = await t.repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
    expect(listed.map((p) => p.id)).toEqual([payment.id]);
    expect((await t.repos.payees.get(payeeId))?.archived).toBe(true);
  });

  it("surfaces dangling foreign keys as ForeignKeyViolationError", async () => {
    await expect(pay("2026-02-15", 1000, { payee_id: 9999 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
    await expect(pay("2026-02-15", 1000, { account_id: 9999 })).rejects.toThrow(
      ForeignKeyViolationError,
    );
  });

  it("flags xlsx business-field collisions as potential duplicates", async () => {
    const existing = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-02-15",
      amount_cents: 4058,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 12,
      source_col: 2,
      occurrence_index: 1,
    });

    const dedup = await t.repos.payments.checkXlsxDedup({
      payee_id: payeeId,
      account_id: accountId,
      date: "2026-02-15",
      amount_cents: 4058,
      source_sheet: "2026",
      source_row: 12,
      source_col: 3,
      occurrence_index: 1,
    });

    expect(dedup.kind).toBe("potential_duplicate");
    if (dedup.kind === "potential_duplicate") {
      expect(dedup.matches.map((p) => p.id)).toEqual([existing.id]);
    }
  });

  it("treats identical xlsx identity as exact duplicate", async () => {
    const existing = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 20,
      source_col: 4,
      occurrence_index: 1,
    });

    const dedup = await t.repos.payments.checkXlsxDedup({
      payee_id: payeeId,
      account_id: accountId,
      date: "2026-03-01",
      amount_cents: 5000,
      source_sheet: "2026",
      source_row: 20,
      source_col: 4,
      occurrence_index: 1,
    });

    expect(dedup).toEqual({ kind: "exact_duplicate", existing });
  });

  it("rejects invalid xlsx writes before hitting sqlite", async () => {
    await expect(
      t.repos.payments.insert({
        payee_id: payeeId,
        account_id: accountId,
        category_id: categoryId,
        date: "2026-03-01",
        amount_cents: 5000,
        source: "xlsx",
        source_sheet: "2026",
        source_row: 20,
        source_col: 4,
        occurrence_index: 0,
      }),
    ).rejects.toThrow("occurrence_index must be >= 1");

    const seeded = await t.repos.payments.insert({
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
      date: "2026-03-01",
      amount_cents: 5000,
      source: "xlsx",
      source_sheet: "2026",
      source_row: 20,
      source_col: 4,
      occurrence_index: 1,
    });

    await expect(t.repos.payments.update(seeded.id, { source_col: null })).rejects.toThrow(
      "requires source coordinates",
    );
  });

  it("supports deterministic re-import: same file no-op, one-new-cell variant inserts one row", async () => {
    type Candidate = {
      payee_id: number;
      account_id: number;
      category_id: number;
      date: string;
      amount_cents: number;
      source_sheet: string;
      source_row: number;
      source_col: number;
      occurrence_index: number;
    };

    async function applyImport(contentHash: string, sourceFile: string, candidates: Candidate[]) {
      const prior = await t.repos.importLog.findLatestByContentHash(contentHash);
      const created: Payment[] = [];
      for (const candidate of candidates) {
        const dedup = await t.repos.payments.checkXlsxDedup(candidate);
        if (dedup.kind === "new") {
          created.push(
            await t.repos.payments.insert({
              ...candidate,
              source: "xlsx",
            }),
          );
        }
      }

      await t.repos.importLog.append({
        source_file: sourceFile,
        content_hash: contentHash,
        row_count: candidates.length,
      });

      return {
        alreadyImported: prior !== null,
        created,
      };
    }

    const base = loadXlsxImportFixture("base.json");
    const baseCandidates: Candidate[] = base.fixture.candidates.map((candidate) => ({
      ...candidate,
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
    }));

    const first = await applyImport(base.hash, base.fixture.source_file, baseCandidates);
    expect(first.alreadyImported).toBe(false);
    expect(first.created).toHaveLength(2);

    const second = await applyImport(base.hash, base.fixture.source_file, baseCandidates);
    expect(second.alreadyImported).toBe(true);
    expect(second.created).toHaveLength(0);

    const oneCellExtended = loadXlsxImportFixture("one-cell-extended.json");
    const oneNewCell: Candidate[] = oneCellExtended.fixture.candidates.map((candidate) => ({
      ...candidate,
      payee_id: payeeId,
      account_id: accountId,
      category_id: categoryId,
    }));

    const third = await applyImport(
      oneCellExtended.hash,
      oneCellExtended.fixture.source_file,
      oneNewCell,
    );
    expect(third.alreadyImported).toBe(false);
    expect(third.created).toHaveLength(1);

    const all = await t.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(all).toHaveLength(3);
  });
});
