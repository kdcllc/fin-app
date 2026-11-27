import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GnucashAccount, GnucashTransactionList } from "../../src/core/gnucash-types";
import {
  applyAccountMapping,
  applyCategoryMapping,
  buildCsv,
  buildQif,
  commitGnucashImport,
  planGnucashImport,
  reconcile,
  recordExport,
  setManualMatch,
  summarize,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/gnucash/reader-output.json",
);

const CHECKING_GUID = "a0000000000000000000000000000002";
const ELECTRIC_GUID = "a0000000000000000000000000000007";
const GROCERIES_GUID = "a0000000000000000000000000000008";
const VISA_GUID = "a0000000000000000000000000000004";

const ELECTRIC_JAN_GUID = "t00000000000000000000000000000001";
const PENNY_GUID = "t00000000000000000000000000000005";
const INEXACT_GUID = "t0000000000000000000000000000000d";
const GROCERIES_FEB_GUID = "t0000000000000000000000000000000a";

interface ReaderFixture {
  probe: { status: string; schemaVersion: number };
  accounts: GnucashAccount[];
  transactionList: GnucashTransactionList;
}

function loadFixture(): ReaderFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ReaderFixture;
}

interface DbSnapshot {
  payments: number;
  paymentExports: number;
  gnucashMatches: number;
}

describe("gnucash pipeline", () => {
  let t: TestDb;
  let fixture: ReaderFixture;
  let checkingAccountId: number;
  let electricCategoryId: number;
  let groceriesCategoryId: number;
  let existingPayeeId: number;

  async function tableCount(table: string): Promise<number> {
    const rows = await t.db.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    return rows[0].count;
  }

  async function dbSnapshot(): Promise<DbSnapshot> {
    return {
      payments: await tableCount("payments"),
      paymentExports: await tableCount("payment_exports"),
      gnucashMatches: await tableCount("gnucash_matches"),
    };
  }

  beforeEach(async () => {
    fixture = loadFixture();
    t = openTestDb();

    checkingAccountId = (
      await t.repos.accounts.insert({
        name: "Checking …9002",
        kind: "checking",
        last4: "9002",
      })
    ).id;
    electricCategoryId = (await t.repos.categories.insert({ name: "Electric" })).id;
    groceriesCategoryId = (await t.repos.categories.insert({ name: "Groceries" })).id;
    existingPayeeId = (await t.repos.payees.insert({ name: "Electric bill Jan" })).id;
  });

  afterEach(() => t.close());

  it("runs mapping → import → re-import → export → reconcile with per-step DB assertions", async () => {
    let snap = await dbSnapshot();
    expect(snap).toEqual({ payments: 0, paymentExports: 0, gnucashMatches: 0 });

    await applyAccountMapping(t.repos, checkingAccountId, CHECKING_GUID);
    await applyCategoryMapping(t.repos, electricCategoryId, ELECTRIC_GUID);
    await applyCategoryMapping(t.repos, groceriesCategoryId, GROCERIES_GUID);

    const mappedChecking = await t.repos.accounts.get(checkingAccountId);
    const mappedElectric = await t.repos.categories.get(electricCategoryId);
    const mappedGroceries = await t.repos.categories.get(groceriesCategoryId);
    expect(mappedChecking?.gnucash_guid).toBe(CHECKING_GUID);
    expect(mappedElectric?.gnucash_guid).toBe(ELECTRIC_GUID);
    expect(mappedGroceries?.gnucash_guid).toBe(GROCERIES_GUID);

    snap = await dbSnapshot();
    expect(snap.payments).toBe(0);

    const { transactionList: fullList } = fixture;
    expect(fullList.transactions).toHaveLength(12);
    expect(fullList.errors).toHaveLength(1);

    const importList: GnucashTransactionList = {
      transactions: fullList.transactions.filter((txn) =>
        [ELECTRIC_JAN_GUID, PENNY_GUID, GROCERIES_FEB_GUID].includes(txn.txn_guid),
      ),
      errors: fullList.errors,
    };

    const importOptions = { accountGuids: [CHECKING_GUID] };
    const plan = await planGnucashImport(t.repos, importList, importOptions);

    const electricNew = plan.new.find((row) => row.txnGuid === ELECTRIC_JAN_GUID);
    expect(electricNew).toMatchObject({ amount_cents: 4858, accountId: checkingAccountId });

    const pennyNew = plan.new.find((row) => row.txnGuid === PENNY_GUID);
    expect(pennyNew?.amount_cents).toBe(1);

    const unreadable = plan.unreadable.find((row) => row.error.txn_guid === INEXACT_GUID);
    expect(unreadable?.error.reason).toContain("inexact rational");

    const approvedNew = plan.new
      .filter((row) => [ELECTRIC_JAN_GUID, PENNY_GUID, GROCERIES_FEB_GUID].includes(row.txnGuid))
      .map((row) => row.txnGuid);

    const preCommit = await dbSnapshot();
    const commitResult = await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: approvedNew,
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      confirmedPayeeIds: {
        [ELECTRIC_JAN_GUID]: existingPayeeId,
        [PENNY_GUID]: existingPayeeId,
        [GROCERIES_FEB_GUID]: existingPayeeId,
      },
      list: importList,
      options: importOptions,
    });
    expect(commitResult.inserted).toBe(3);

    const paymentsAfterCommit = await t.db.select<{ external_ref: string | null; amount_cents: number; source: string }>(
      "SELECT external_ref, amount_cents, source FROM payments ORDER BY id",
    );
    expect(paymentsAfterCommit).toHaveLength(3);
    expect(paymentsAfterCommit.every((row) => row.source === "gnucash")).toBe(true);
    expect(paymentsAfterCommit.find((row) => row.external_ref === PENNY_GUID)?.amount_cents).toBe(1);
    expect(
      paymentsAfterCommit.find((row) => row.external_ref === ELECTRIC_JAN_GUID)?.amount_cents,
    ).toBe(4858);
    expect(paymentsAfterCommit.some((row) => row.external_ref === INEXACT_GUID)).toBe(false);

    snap = await dbSnapshot();
    expect(snap.payments).toBe(3);
    expect(snap.paymentExports).toBe(preCommit.paymentExports);
    expect(snap.gnucashMatches).toBe(preCommit.gnucashMatches);

    const replan = await planGnucashImport(t.repos, importList, importOptions);
    expect(replan.new).toHaveLength(0);
    expect(replan.updated).toHaveLength(0);
    expect(replan.mergeCandidates).toHaveLength(0);
    expect(replan.unchanged).toHaveLength(approvedNew.length);

    const noopCommit = await commitGnucashImport(t.db, t.repos, {
      approvedNewTxnGuids: [],
      approvedUpdateTxnGuids: [],
      approvedMergeTxnGuids: [],
      list: importList,
      options: importOptions,
    });
    expect(noopCommit).toEqual({ inserted: 0, merged: 0, skipped: 0 });
    expect(await tableCount("payments")).toBe(3);

    const allPayments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-03-31" });
    const pennyPayment = allPayments.find((payment) => payment.external_ref === PENNY_GUID);
    const electricPayment = allPayments.find((payment) => payment.external_ref === ELECTRIC_JAN_GUID);
    expect(pennyPayment).toBeDefined();
    expect(electricPayment).toBeDefined();

    const largePayment = await t.repos.payments.insert({
      payee_id: existingPayeeId,
      account_id: checkingAccountId,
      category_id: groceriesCategoryId,
      date: "2026-02-05",
      amount_cents: 1067391,
      memo: "Large purchase",
      source: "manual",
    });

    const exportPayments = [pennyPayment!, electricPayment!, largePayment];

    const [accounts, categories, payees] = await Promise.all([
      t.repos.accounts.list({ includeArchived: true }),
      t.repos.categories.list({ includeArchived: true }),
      t.repos.payees.list({ includeArchived: true }),
    ]);

    const buildInput = {
      payments: exportPayments,
      accounts,
      categories,
      gnucashAccounts: fixture.accounts,
      payees,
    };

    const qif = buildQif(buildInput);
    const csv = buildCsv(buildInput);
    expect(qif).toContain("D01/20/2026");
    expect(qif).toContain("T-0.01");
    expect(qif).toContain("D01/08/2026");
    expect(qif).toContain("T-48.58");
    expect(qif).toContain("T-10673.91");
    expect(csv).toContain("2026-01-20");
    expect(csv).toContain("-0.01");
    expect(csv).toContain("-48.58");
    expect(csv).toContain("-10673.91");

    const exportIds = exportPayments.map((payment) => payment.id);
    await recordExport(t.db, exportIds, "qif");
    snap = await dbSnapshot();
    expect(snap.paymentExports).toBe(exportIds.length);
    expect(snap.payments).toBe(4);

    const finAppOnly = await t.repos.payments.insert({
      payee_id: existingPayeeId,
      account_id: checkingAccountId,
      category_id: electricCategoryId,
      date: "2026-02-01",
      amount_cents: 999,
      memo: "Manual fin-app only",
      source: "manual",
    });

    const checkingTxns = fullList.transactions.filter((txn) =>
      txn.splits.some((split) => split.account_guid === CHECKING_GUID),
    );
    const reconcileList: GnucashTransactionList = {
      transactions: checkingTxns,
      errors: fullList.errors,
    };

    const reconcilePayments = (
      await t.repos.payments.list({
        accountId: checkingAccountId,
        from: "2026-01-01",
        to: "2026-02-28",
      })
    ).filter((payment) => payment.id !== largePayment.id);

    let result = await reconcile(t.db, reconcilePayments, reconcileList, { toleranceDays: 3 });
    expect(result.finAppOnly.some((payment) => payment.id === finAppOnly.id)).toBe(true);
    expect(result.gnucashOnly.some((txn) => txn.txn_guid === "t00000000000000000000000000000002")).toBe(
      true,
    );
    expect(result.readerErrors).toHaveLength(1);
    expect(result.readerErrors[0].txn_guid).toBe(INEXACT_GUID);
    expect(result.readerErrors[0].reason).toContain("inexact rational");

    const summary = summarize(result).find((entry) => entry.accountId === checkingAccountId);
    expect(summary?.finAppOnlyTotalCents).toBe(999);
    expect(Number.isInteger(summary?.matchedTotalCents ?? 0)).toBe(true);

    const gnucashOnlyTxn = result.gnucashOnly[0];
    await setManualMatch(t.db, finAppOnly.id, gnucashOnlyTxn.txn_guid);

    result = await reconcile(t.db, reconcilePayments, reconcileList, { toleranceDays: 3 });
    expect(result.matched.some(
      (pair) => pair.payment.id === finAppOnly.id && pair.transaction.txn_guid === gnucashOnlyTxn.txn_guid,
    )).toBe(true);

    const matches = await t.db.select<{ payment_id: number; txn_guid: string; status: string }>(
      "SELECT payment_id, txn_guid, status FROM gnucash_matches",
    );
    expect(matches).toContainEqual({
      payment_id: finAppOnly.id,
      txn_guid: gnucashOnlyTxn.txn_guid,
      status: "matched",
    });

    snap = await dbSnapshot();
    expect(snap.gnucashMatches).toBe(1);
    expect(snap.payments).toBe(5);
  });
});
