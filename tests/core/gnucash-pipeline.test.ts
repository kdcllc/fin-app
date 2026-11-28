import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GnucashAccount, GnucashTransactionList } from "../../src/core/gnucash-types";
import {
  applyAccountMapping,
  applyCategoryMapping,
  commitGnucashImport,
  planGnucashImport,
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
  transactions: number;
  splits: number;
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
      transactions: await tableCount("transactions"),
      splits: await tableCount("splits"),
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

  it("runs mapping → import → re-import with per-step DB assertions", async () => {
    let snap = await dbSnapshot();
    expect(snap).toEqual({ transactions: 0, splits: 0 });

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
    expect(snap.transactions).toBe(0);

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
      `SELECT t.external_ref AS external_ref, s.amount_cents AS amount_cents, t.source AS source
       FROM transactions t
       JOIN splits s ON s.transaction_id = t.id
       JOIN accounts a ON a.id = s.account_id AND a.type = 'EXPENSE'
       ORDER BY t.id`,
    );
    expect(paymentsAfterCommit).toHaveLength(3);
    expect(paymentsAfterCommit.every((row) => row.source === "gnucash")).toBe(true);
    expect(paymentsAfterCommit.find((row) => row.external_ref === PENNY_GUID)?.amount_cents).toBe(1);
    expect(
      paymentsAfterCommit.find((row) => row.external_ref === ELECTRIC_JAN_GUID)?.amount_cents,
    ).toBe(4858);
    expect(paymentsAfterCommit.some((row) => row.external_ref === INEXACT_GUID)).toBe(false);

    snap = await dbSnapshot();
    expect(snap.transactions).toBe(preCommit.transactions + 3);
    expect(snap.splits).toBe(preCommit.splits + 6);

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
    expect(await tableCount("transactions")).toBe(3);

    const allPayments = await t.repos.payments.list({ from: "2026-01-01", to: "2026-03-31" });
    const pennyPayment = allPayments.find((payment) => payment.external_ref === PENNY_GUID);
    const electricPayment = allPayments.find((payment) => payment.external_ref === ELECTRIC_JAN_GUID);
    expect(pennyPayment).toBeDefined();
    expect(electricPayment).toBeDefined();

  });
});
