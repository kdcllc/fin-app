import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EntityInUseError,
  ForeignKeyViolationError,
  ReconciledTransactionError,
  UnbalancedTransactionError,
  ValidationError,
  balanceAsOf,
  createIncome,
  createTransfer,
  deleteTransaction,
  getAccountTree,
  getRegister,
  getTransaction,
  naturalBalance,
  postTransaction,
  setOpeningBalance,
  updateTransaction,
  type AccountType,
  type LedgerAccount,
  type LedgerRepo,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

let t: TestDb;
let ledger: LedgerRepo;
let checking: LedgerAccount;
let credit: LedgerAccount;
let savings: LedgerAccount;
let groceries: LedgerAccount;
let salary: LedgerAccount;
let rootAsset: LedgerAccount;
let payeeId: number;

async function root(role: "root_asset" | "root_liability" | "root_income" | "root_expense") {
  const account = await ledger.getSystemAccount(role);
  if (account === null) throw new Error(`missing ${role}`);
  return account;
}

async function counts(): Promise<{ tx: number; splits: number }> {
  const [tx] = await t.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM transactions");
  const [splits] = await t.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM splits");
  return { tx: tx.n, splits: splits.n };
}

beforeEach(async () => {
  t = openTestDb();
  ledger = t.repos.ledger;
  rootAsset = await root("root_asset");
  checking = await ledger.insertAccount({
    name: "Checking A",
    type: "ASSET",
    subtype: "bank",
    parent_id: rootAsset.id,
  });
  savings = await ledger.insertAccount({
    name: "Savings A",
    type: "ASSET",
    subtype: "savings",
    parent_id: rootAsset.id,
  });
  credit = await ledger.insertAccount({
    name: "Card A",
    type: "LIABILITY",
    subtype: "credit_card",
    parent_id: (await root("root_liability")).id,
  });
  groceries = await ledger.insertAccount({
    name: "Groceries",
    type: "EXPENSE",
    parent_id: (await root("root_expense")).id,
  });
  salary = await ledger.insertAccount({
    name: "Salary",
    type: "INCOME",
    parent_id: (await root("root_income")).id,
  });
  const payee = await t.db.execute("INSERT INTO payees (name) VALUES (?)", ["Payee One"]);
  payeeId = payee.lastInsertId;
});

afterEach(() => t.close());

function pay(date: string, cents: number, extra: object = {}) {
  return {
    date,
    splits: [
      { account_id: groceries.id, amount_cents: cents },
      { account_id: checking.id, amount_cents: -cents },
    ],
    ...extra,
  };
}

describe("postTransaction", () => {
  it("stores header and splits in one batch with defaults", async () => {
    const before = t.calls.filter((c) => c.kind === "batch").length;
    const stored = await postTransaction(ledger, pay("2025-03-01", 1250));
    expect(t.calls.filter((c) => c.kind === "batch").length - before).toBe(1);
    expect(stored).toMatchObject({
      date: "2025-03-01",
      payee_id: null,
      memo: null,
      source: "manual",
      external_ref: null,
    });
    expect(
      stored.splits.map((s) => [s.account_id, s.amount_cents, s.memo, s.reconcile_state]),
    ).toEqual([
      [groceries.id, 1250, null, "n"],
      [checking.id, -1250, null, "n"],
    ]);
  });

  it("rejects an unbalanced post with the imbalance and writes nothing", async () => {
    const error = await postTransaction(ledger, {
      date: "2025-03-01",
      splits: [
        { account_id: groceries.id, amount_cents: 1000 },
        { account_id: checking.id, amount_cents: -900 },
      ],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnbalancedTransactionError);
    expect((error as UnbalancedTransactionError).imbalanceCents).toBe(100);
    expect(await counts()).toEqual({ tx: 0, splits: 0 });
  });

  it("rejects a single split, non-integer amounts and bad dates with no writes", async () => {
    await expect(
      postTransaction(ledger, {
        date: "2025-03-01",
        splits: [{ account_id: checking.id, amount_cents: 0 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      postTransaction(ledger, {
        date: "2025-03-01",
        splits: [
          { account_id: groceries.id, amount_cents: 10.5 },
          { account_id: checking.id, amount_cents: -10.5 },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(postTransaction(ledger, pay("03/01/2025", 100))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(postTransaction(ledger, pay("2025-02-30", 100))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await counts()).toEqual({ tx: 0, splits: 0 });
  });

  it("rejects placeholder accounts and unknown account/payee ids with no writes", async () => {
    await expect(
      postTransaction(ledger, {
        date: "2025-03-01",
        splits: [
          { account_id: rootAsset.id, amount_cents: 100 },
          { account_id: groceries.id, amount_cents: -100 },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const unknownAccount = await postTransaction(ledger, {
      date: "2025-03-01",
      splits: [
        { account_id: 99999, amount_cents: 100 },
        { account_id: groceries.id, amount_cents: -100 },
      ],
    }).catch((e: unknown) => e);
    expect(unknownAccount).toBeInstanceOf(ForeignKeyViolationError);
    expect((unknownAccount as Error).message).toContain("99999");
    const unknownPayee = await postTransaction(
      ledger,
      pay("2025-03-01", 100, { payee_id: 4242 }),
    ).catch((e: unknown) => e);
    expect(unknownPayee).toBeInstanceOf(ForeignKeyViolationError);
    expect((unknownPayee as Error).message).toContain("4242");
    expect(await counts()).toEqual({ tx: 0, splits: 0 });
  });

  it("accepts a zero-amount balanced post and archived accounts", async () => {
    const zero = await postTransaction(ledger, pay("2025-03-01", 0));
    expect(zero.splits.map((s) => s.amount_cents)).toEqual([0, 0]);
    await ledger.archiveAccount(groceries.id);
    const archived = await postTransaction(ledger, pay("2025-03-02", 500, { payee_id: payeeId }));
    expect(archived.payee_id).toBe(payeeId);
  });

  it("fills the xlsx import snapshot for a payment-shaped xlsx post", async () => {
    const stored = await postTransaction(
      ledger,
      pay("2025-03-01", 700, {
        payee_id: payeeId,
        source: "xlsx",
        source_sheet: "S",
        source_row: 1,
        source_col: 2,
        occurrence_index: 1,
      }),
    );
    expect(stored.import_account_id).toBe(checking.id);
    expect(stored.import_amount_cents).toBe(700);
  });
});

describe("updateTransaction / deleteTransaction", () => {
  it("replaces header and splits atomically and keeps the id", async () => {
    const original = await postTransaction(ledger, pay("2025-03-01", 1000));
    const updated = await updateTransaction(
      ledger,
      original.id,
      pay("2025-03-05", 2000, { memo: "edited", payee_id: payeeId }),
    );
    expect(updated).toMatchObject({
      id: original.id,
      date: "2025-03-05",
      memo: "edited",
      payee_id: payeeId,
    });
    expect(updated?.splits.map((s) => s.amount_cents)).toEqual([2000, -2000]);
    expect((await counts()).splits).toBe(2);
  });

  it("returns null / false for unknown ids", async () => {
    expect(await updateTransaction(ledger, 777, pay("2025-03-01", 1))).toBeNull();
    expect(await deleteTransaction(ledger, 777)).toBe(false);
  });

  it("leaves the transaction unchanged when the update is invalid", async () => {
    const original = await postTransaction(ledger, pay("2025-03-01", 1000));
    await expect(
      updateTransaction(ledger, original.id, {
        date: "2025-03-01",
        splits: [
          { account_id: groceries.id, amount_cents: 1 },
          { account_id: checking.id, amount_cents: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError);
    expect(await getTransaction(ledger, original.id)).toEqual(original);
  });

  it("refuses to update or delete a transaction with a reconciled split", async () => {
    const original = await postTransaction(ledger, pay("2025-03-01", 1000));
    await t.db.execute("UPDATE splits SET reconcile_state = 'y' WHERE id = ?", [
      original.splits[0].id,
    ]);
    await expect(
      updateTransaction(ledger, original.id, pay("2025-03-02", 5)),
    ).rejects.toBeInstanceOf(ReconciledTransactionError);
    await expect(deleteTransaction(ledger, original.id)).rejects.toBeInstanceOf(
      ReconciledTransactionError,
    );
    expect((await getTransaction(ledger, original.id))?.date).toBe("2025-03-01");
    // A cleared ('c') split does not lock.
    await t.db.execute("UPDATE splits SET reconcile_state = 'c' WHERE transaction_id = ?", [
      original.id,
    ]);
    expect(await deleteTransaction(ledger, original.id)).toBe(true);
    expect(await counts()).toEqual({ tx: 0, splits: 0 });
  });

  it("preserves xlsx provenance and refreshes the snapshot while payment-shaped", async () => {
    const posted = await postTransaction(
      ledger,
      pay("2025-03-01", 700, {
        payee_id: payeeId,
        source: "xlsx",
        source_sheet: "S",
        source_row: 4,
        source_col: 5,
        occurrence_index: 1,
        external_ref: "ref-1",
      }),
    );
    const updated = await updateTransaction(ledger, posted.id, {
      date: "2025-03-01",
      payee_id: payeeId,
      splits: [
        { account_id: groceries.id, amount_cents: 900 },
        { account_id: savings.id, amount_cents: -900 },
      ],
    });
    expect(updated).toMatchObject({
      source: "xlsx",
      source_sheet: "S",
      source_row: 4,
      source_col: 5,
      occurrence_index: 1,
      external_ref: "ref-1",
      import_account_id: savings.id,
      import_amount_cents: 900,
    });
    // Three splits: no longer payment-shaped, so the snapshot is left as it was.
    const multi = await updateTransaction(ledger, posted.id, {
      date: "2025-03-01",
      payee_id: payeeId,
      splits: [
        { account_id: groceries.id, amount_cents: 600 },
        { account_id: groceries.id, amount_cents: 300 },
        { account_id: checking.id, amount_cents: -900 },
      ],
    });
    expect(multi).toMatchObject({ import_account_id: savings.id, import_amount_cents: 900 });
  });

  async function postXlsx() {
    return postTransaction(
      ledger,
      pay("2025-03-01", 700, {
        payee_id: payeeId,
        source: "xlsx",
        source_sheet: "S",
        source_row: 4,
        source_col: 5,
        occurrence_index: 1,
        external_ref: "ref-1",
      }),
    );
  }

  it("keeps stored provenance when the fields are omitted", async () => {
    const posted = await postXlsx();
    const updated = await updateTransaction(
      ledger,
      posted.id,
      pay("2025-03-02", 700, { payee_id: payeeId }),
    );
    expect(updated).toMatchObject({
      source: "xlsx",
      source_sheet: "S",
      source_row: 4,
      source_col: 5,
      occurrence_index: 1,
      external_ref: "ref-1",
    });
  });

  it("clears external_ref when it is null", async () => {
    const posted = await postXlsx();
    const updated = await updateTransaction(
      ledger,
      posted.id,
      pay("2025-03-01", 700, { payee_id: payeeId, external_ref: null }),
    );
    expect(updated?.external_ref).toBeNull();
  });

  it("NULLs the import snapshot when the resulting source is not xlsx", async () => {
    const posted = await postXlsx();
    expect(posted.import_account_id).toBe(checking.id);
    const updated = await updateTransaction(ledger, posted.id, {
      date: "2025-03-01",
      payee_id: payeeId,
      source: "manual",
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
      splits: [
        { account_id: groceries.id, amount_cents: 700 },
        { account_id: checking.id, amount_cents: -700 },
      ],
    });
    expect(updated).toMatchObject({
      source: "manual",
      import_account_id: null,
      import_amount_cents: null,
    });
  });

  it("rejects NULL xlsx provenance on a direct update and leaves the transaction unchanged", async () => {
    const posted = await postXlsx();
    await expect(
      updateTransaction(
        ledger,
        posted.id,
        pay("2025-03-01", 700, { payee_id: payeeId, source_sheet: null }),
      ),
    ).rejects.toThrow();
    expect(await getTransaction(ledger, posted.id)).toEqual(posted);
  });
});

describe("balanceAsOf and getRegister", () => {
  beforeEach(async () => {
    await postTransaction(ledger, pay("2025-01-10", 1000));
    await postTransaction(ledger, pay("2025-02-10", 2000));
    await postTransaction(ledger, pay("2025-03-10", 3000));
  });

  it("sums raw splits up to the inclusive date and optionally descendants", async () => {
    expect(await balanceAsOf(ledger, checking.id, "2025-02-09")).toBe(-1000);
    expect(await balanceAsOf(ledger, checking.id, "2025-02-10")).toBe(-3000);
    expect(await balanceAsOf(ledger, groceries.id, "2025-12-31")).toBe(6000);
    expect(await balanceAsOf(ledger, rootAsset.id, "2025-12-31")).toBe(0);
    expect(
      await balanceAsOf(ledger, rootAsset.id, "2025-12-31", { includeDescendants: true }),
    ).toBe(-6000);
  });

  it("is unbounded by default, ordered, and the last running balance equals balanceAsOf", async () => {
    const rows = await getRegister(ledger, checking.id);
    expect(rows.map((r) => r.date)).toEqual(["2025-01-10", "2025-02-10", "2025-03-10"]);
    expect(rows.map((r) => r.running_balance_cents)).toEqual([-1000, -3000, -6000]);
    expect(rows[2].running_balance_cents).toBe(
      await balanceAsOf(ledger, checking.id, rows[2].date),
    );
    expect(rows[0].counterpart).toBe("Groceries");
    expect(rows[0].transaction.splits).toHaveLength(2);
  });

  it("starts the running balance from the balance before `from` and honors `to`", async () => {
    const rows = await getRegister(ledger, checking.id, { from: "2025-02-10", to: "2025-02-28" });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(-2000);
    expect(rows[0].running_balance_cents).toBe(-3000);
    const open = await getRegister(ledger, checking.id, { from: "2025-03-10" });
    expect(open.map((r) => r.running_balance_cents)).toEqual([-6000]);
  });

  it("labels multi-split rows, sums repeated account splits and orders by transaction id within a date", async () => {
    await postTransaction(ledger, {
      date: "2025-03-10",
      splits: [
        { account_id: groceries.id, amount_cents: 400 },
        { account_id: savings.id, amount_cents: 600 },
        { account_id: checking.id, amount_cents: -600 },
        { account_id: checking.id, amount_cents: -400 },
      ],
    });
    const rows = await getRegister(ledger, checking.id, { from: "2025-03-10" });
    expect(rows.map((r) => r.amount_cents)).toEqual([-3000, -1000]);
    expect(rows[1].counterpart).toBe("— Split —");
    expect(rows[0].transaction_id).toBeLessThan(rows[1].transaction_id);
    expect(rows[1].running_balance_cents).toBe(-7000);
  });
});

describe("getAccountTree", () => {
  it("nests by name with own and rolled-up raw balances; archived roll up but are hidden", async () => {
    const sub = await ledger.insertAccount({
      name: "Aaa Sub",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    const hidden = await ledger.insertAccount({
      name: "Zzz Hidden",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    await postTransaction(ledger, {
      date: "2025-01-01",
      splits: [
        { account_id: sub.id, amount_cents: 300 },
        { account_id: hidden.id, amount_cents: 200 },
        { account_id: checking.id, amount_cents: -500 },
      ],
    });
    await postTransaction(ledger, pay("2025-01-02", 100));
    await ledger.archiveAccount(hidden.id);

    const tree = await getAccountTree(ledger, { asOf: "2025-12-31" });
    const expenses = tree.find((n) => n.account.system_role === "root_expense");
    const groceriesNode = expenses?.children.find((n) => n.account.id === groceries.id);
    expect(groceriesNode?.own_balance_cents).toBe(100);
    expect(groceriesNode?.rolled_up_balance_cents).toBe(600);
    expect(groceriesNode?.children.map((c) => c.account.name)).toEqual(["Aaa Sub"]);
    expect(expenses?.rolled_up_balance_cents).toBe(600);
    expect(expenses?.children.map((c) => c.account.name)).toEqual(["Groceries", "Uncategorized"]);

    const all = await getAccountTree(ledger, { asOf: "2025-12-31", includeArchived: true });
    const names = all
      .find((n) => n.account.system_role === "root_expense")
      ?.children.find((n) => n.account.id === groceries.id)
      ?.children.map((c) => c.account.name);
    expect(names).toEqual(["Aaa Sub", "Zzz Hidden"]);
  });

  it("respects asOf and defaults to today", async () => {
    await postTransaction(ledger, pay("2000-01-01", 100));
    await postTransaction(ledger, pay("2999-01-01", 900));
    const early = await getAccountTree(ledger, { asOf: "2000-06-01" });
    const today = await getAccountTree(ledger);
    const find = (tree: typeof early) =>
      tree.find((n) => n.account.system_role === "root_expense")?.rolled_up_balance_cents;
    expect(find(early)).toBe(100);
    expect(find(today)).toBe(100); // the 2999 transaction is in the future
  });
});

describe("transfer, income, opening balance", () => {
  it("createTransfer posts -amount from and +amount to with null defaults", async () => {
    const tx = await createTransfer(ledger, {
      date: "2025-04-01",
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount_cents: 5000,
    });
    expect(tx).toMatchObject({ memo: null, payee_id: null });
    expect(tx.splits.map((s) => [s.account_id, s.amount_cents])).toEqual([
      [checking.id, -5000],
      [savings.id, 5000],
    ]);
    await expect(
      createTransfer(ledger, {
        date: "2025-04-01",
        fromAccountId: checking.id,
        toAccountId: checking.id,
        amount_cents: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createTransfer(ledger, {
        date: "2025-04-01",
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount_cents: 0,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await counts()).tx).toBe(1);
  });

  it("createIncome posts +deposit and -income and checks account types", async () => {
    const tx = await createIncome(ledger, {
      date: "2025-04-01",
      incomeAccountId: salary.id,
      depositAccountId: checking.id,
      amount_cents: 12345,
      payee_id: payeeId,
      memo: "pay",
    });
    expect(tx).toMatchObject({ payee_id: payeeId, memo: "pay" });
    expect(tx.splits.map((s) => [s.account_id, s.amount_cents])).toEqual([
      [checking.id, 12345],
      [salary.id, -12345],
    ]);
    await expect(
      createIncome(ledger, {
        date: "2025-04-01",
        incomeAccountId: groceries.id,
        depositAccountId: checking.id,
        amount_cents: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createIncome(ledger, {
        date: "2025-04-01",
        incomeAccountId: salary.id,
        depositAccountId: groceries.id,
        amount_cents: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await counts()).tx).toBe(1);
  });

  it("setOpeningBalance creates, replaces with the same id, and deletes on 0", async () => {
    const first = await setOpeningBalance(ledger, checking.id, "2025-01-01", 10000);
    expect(first).not.toBeNull();
    const second = await setOpeningBalance(ledger, checking.id, "2025-01-05", 25000);
    expect(second?.id).toBe(first?.id);
    expect((await counts()).tx).toBe(1);
    expect(naturalBalance("ASSET", await balanceAsOf(ledger, checking.id, "2025-01-05"))).toBe(
      25000,
    );
    expect(await balanceAsOf(ledger, checking.id, "2025-01-04")).toBe(0);
    expect(await setOpeningBalance(ledger, checking.id, "2025-01-05", 0)).toBeNull();
    expect(await counts()).toEqual({ tx: 0, splits: 0 });
  });

  it("setOpeningBalance on a liability uses natural sign and ignores other transactions", async () => {
    await postTransaction(ledger, pay("2025-01-02", 300));
    await setOpeningBalance(ledger, credit.id, "2025-01-01", 40000);
    const raw = await balanceAsOf(ledger, credit.id, "2025-01-01");
    expect(raw).toBe(-40000);
    expect(naturalBalance("LIABILITY", raw)).toBe(40000);
    expect((await counts()).tx).toBe(2);
  });

  it("setOpeningBalance is refused for placeholder, system and EQUITY accounts", async () => {
    const opening = await ledger.getSystemAccount("opening_balances");
    const uncategorized = await ledger.getSystemAccount("uncategorized");
    for (const id of [rootAsset.id, opening?.id, uncategorized?.id]) {
      await expect(
        setOpeningBalance(ledger, id as number, "2025-01-01", 100),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    const equity = await ledger.insertAccount({
      name: "Equity Child",
      type: "EQUITY",
      parent_id: (await ledger.getSystemAccount("root_equity"))!.id,
    });
    await expect(setOpeningBalance(ledger, equity.id, "2025-01-01", 100)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await counts()).toEqual({ tx: 0, splits: 0 });
  });
});

describe("naturalBalance", () => {
  it.each<[AccountType, number, number]>([
    ["ASSET", 500, 500],
    ["EXPENSE", 500, 500],
    ["LIABILITY", 500, -500],
    ["INCOME", -500, 500],
    ["EQUITY", 500, -500],
    ["LIABILITY", 0, 0],
  ])("%s raw %i -> natural %i", (type, raw, expected) => {
    expect(naturalBalance(type, raw)).toBe(expected);
  });
});

describe("account management", () => {
  it("enforces parent type, subtype validity and unknown parents", async () => {
    await expect(
      ledger.insertAccount({ name: "Bad", type: "ASSET", parent_id: groceries.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      ledger.insertAccount({
        name: "Bad",
        type: "ASSET",
        subtype: "loan",
        parent_id: rootAsset.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      ledger.insertAccount({ name: "Bad", type: "ASSET", parent_id: 98765 }),
    ).rejects.toBeInstanceOf(ForeignKeyViolationError);
    expect((await ledger.listAccounts()).some((a) => a.name === "Bad")).toBe(false);
  });

  it("prevents cycles and re-parenting or archiving system accounts", async () => {
    const parent = await ledger.insertAccount({
      name: "P",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    const child = await ledger.insertAccount({ name: "C", type: "EXPENSE", parent_id: parent.id });
    await expect(
      ledger.updateAccount(groceries.id, { parent_id: child.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(ledger.updateAccount(parent.id, { parent_id: parent.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      ledger.updateAccount(groceries.id, { parent_id: checking.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    const uncategorized = (await ledger.getSystemAccount("uncategorized"))!;
    await expect(
      ledger.updateAccount(uncategorized.id, { parent_id: groceries.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(ledger.updateAccount(rootAsset.id, { archived: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(ledger.archiveAccount(uncategorized.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(ledger.deleteAccount(rootAsset.id)).rejects.toBeInstanceOf(ValidationError);
    const moved = await ledger.updateAccount(child.id, { parent_id: groceries.id, name: "C2" });
    expect(moved).toMatchObject({ parent_id: groceries.id, name: "C2" });
    expect(await ledger.updateAccount(55555, { name: "x" })).toBeNull();
  });

  it("deletes only unreferenced accounts", async () => {
    await postTransaction(ledger, pay("2025-01-01", 100));
    await expect(ledger.deleteAccount(groceries.id)).rejects.toBeInstanceOf(EntityInUseError);
    const parent = await ledger.insertAccount({
      name: "P",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    await ledger.insertAccount({ name: "C", type: "EXPENSE", parent_id: parent.id });
    await expect(ledger.deleteAccount(parent.id)).rejects.toBeInstanceOf(EntityInUseError);
    const withDefault = await ledger.insertAccount({
      name: "D",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    await t.db.execute("UPDATE payees SET default_category_id = ? WHERE id = ?", [
      withDefault.id,
      payeeId,
    ]);
    await expect(ledger.deleteAccount(withDefault.id)).rejects.toBeInstanceOf(EntityInUseError);
    const free = await ledger.insertAccount({
      name: "F",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    expect(await ledger.deleteAccount(free.id)).toBe(true);
    expect(await ledger.getAccount(free.id)).toBeNull();
    expect(await ledger.deleteAccount(free.id)).toBe(false);
  });
});

describe("fix cycle 1 coverage", () => {
  async function snapshot(id: number) {
    return getTransaction(ledger, id);
  }

  it("updateTransaction rejects invalid input and leaves the transaction unchanged", async () => {
    const original = await postTransaction(ledger, pay("2025-03-01", 1000));
    const bad: Array<[string, unknown]> = [
      ["placeholder", ValidationError],
      ["unknown account", ForeignKeyViolationError],
      ["unknown payee", ForeignKeyViolationError],
      ["bad date", ValidationError],
      ["one split", ValidationError],
    ];
    const inputs = [
      {
        date: "2025-03-02",
        splits: [
          { account_id: rootAsset.id, amount_cents: 5 },
          { account_id: groceries.id, amount_cents: -5 },
        ],
      },
      {
        date: "2025-03-02",
        splits: [
          { account_id: 99999, amount_cents: 5 },
          { account_id: groceries.id, amount_cents: -5 },
        ],
      },
      pay("2025-03-02", 5, { payee_id: 4242 }),
      pay("2025-13-45", 5),
      { date: "2025-03-02", splits: [{ account_id: checking.id, amount_cents: 0 }] },
    ];
    for (const [index, [, errorClass]] of bad.entries()) {
      await expect(updateTransaction(ledger, original.id, inputs[index])).rejects.toBeInstanceOf(
        errorClass as typeof ValidationError,
      );
    }
    expect(await snapshot(original.id)).toEqual(original);
  });

  it("updateAccount rejects an invalid subtype and leaves rows unchanged on every failure", async () => {
    const before = await ledger.getAccount(checking.id);
    await expect(ledger.updateAccount(checking.id, { subtype: "loan" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      ledger.updateAccount(checking.id, { parent_id: groceries.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await ledger.getAccount(checking.id)).toEqual(before);
    const parent = await ledger.insertAccount({
      name: "P",
      type: "EXPENSE",
      parent_id: groceries.id,
    });
    const child = await ledger.insertAccount({ name: "C", type: "EXPENSE", parent_id: parent.id });
    const parentBefore = await ledger.getAccount(parent.id);
    await expect(ledger.updateAccount(parent.id, { parent_id: child.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await ledger.getAccount(parent.id)).toEqual(parentBefore);
    const uncategorized = (await ledger.getSystemAccount("uncategorized"))!;
    const sysBefore = await ledger.getAccount(uncategorized.id);
    await expect(ledger.updateAccount(uncategorized.id, { archived: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await ledger.getAccount(uncategorized.id)).toEqual(sysBefore);
  });

  it("refuses to change the placeholder flag of roots and system accounts", async () => {
    const uncategorized = (await ledger.getSystemAccount("uncategorized"))!;
    await expect(ledger.updateAccount(rootAsset.id, { placeholder: false })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      ledger.updateAccount(uncategorized.id, { placeholder: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await ledger.getAccount(rootAsset.id))?.placeholder).toBe(true);
    expect((await ledger.getAccount(uncategorized.id))?.placeholder).toBe(false);
  });

  it("listAccounts includes placeholder roots; system accounts cannot be deleted", async () => {
    const all = await ledger.listAccounts();
    expect(
      all
        .filter((a) => a.placeholder)
        .map((a) => a.system_role)
        .sort(),
    ).toEqual(["root_asset", "root_equity", "root_expense", "root_income", "root_liability"]);
    for (const role of ["uncategorized", "opening_balances"] as const) {
      const account = (await ledger.getSystemAccount(role))!;
      await expect(ledger.deleteAccount(account.id)).rejects.toBeInstanceOf(ValidationError);
      expect(await ledger.getAccount(account.id)).not.toBeNull();
    }
  });

  it("createIncome with an unknown account id raises ForeignKeyViolationError", async () => {
    await expect(
      createIncome(ledger, {
        date: "2025-04-01",
        incomeAccountId: 99999,
        depositAccountId: checking.id,
        amount_cents: 1,
      }),
    ).rejects.toBeInstanceOf(ForeignKeyViolationError);
    await expect(
      createIncome(ledger, {
        date: "2025-04-01",
        incomeAccountId: salary.id,
        depositAccountId: 99999,
        amount_cents: 1,
      }),
    ).rejects.toBeInstanceOf(ForeignKeyViolationError);
    expect((await counts()).tx).toBe(0);
  });

  it("keeps name order when children of an archived account are hoisted", async () => {
    const expenseRoot = await root("root_expense");
    const alpha = await ledger.insertAccount({
      name: "Alpha",
      type: "EXPENSE",
      parent_id: expenseRoot.id,
    });
    await ledger.insertAccount({ name: "Zeta", type: "EXPENSE", parent_id: alpha.id });
    await ledger.insertAccount({ name: "Beta", type: "EXPENSE", parent_id: expenseRoot.id });
    await ledger.archiveAccount(alpha.id);
    const tree = await getAccountTree(ledger, { asOf: "2025-12-31" });
    const names = tree
      .find((n) => n.account.id === expenseRoot.id)!
      .children.map((c) => c.account.name);
    expect(names).toEqual(["Beta", "Groceries", "Uncategorized", "Zeta"]);
  });

  it("setOpeningBalance with several matching transactions is all-or-nothing and one batch", async () => {
    const opening = (await ledger.getSystemAccount("opening_balances"))!;
    const mk = (date: string, cents: number) =>
      postTransaction(ledger, {
        date,
        splits: [
          { account_id: checking.id, amount_cents: cents },
          { account_id: opening.id, amount_cents: -cents },
        ],
      });
    const first = await mk("2025-01-01", 100);
    const second = await mk("2025-01-02", 200);
    await t.db.execute("UPDATE splits SET reconcile_state = 'y' WHERE transaction_id = ?", [
      second.id,
    ]);
    const before = [await snapshot(first.id), await snapshot(second.id)];
    await expect(setOpeningBalance(ledger, checking.id, "2025-02-01", 0)).rejects.toBeInstanceOf(
      ReconciledTransactionError,
    );
    await expect(setOpeningBalance(ledger, checking.id, "2025-02-01", 999)).rejects.toBeInstanceOf(
      ReconciledTransactionError,
    );
    expect([await snapshot(first.id), await snapshot(second.id)]).toEqual(before);

    // Unlock: two candidates collapse to one transaction in exactly one batch.
    await t.db.execute("UPDATE splits SET reconcile_state = 'n' WHERE transaction_id = ?", [
      second.id,
    ]);
    const batchesBefore = t.calls.filter((c) => c.kind === "batch").length;
    const result = await setOpeningBalance(ledger, checking.id, "2025-02-01", 999);
    expect(t.calls.filter((c) => c.kind === "batch").length - batchesBefore).toBe(1);
    expect(result?.id).toBe(first.id);
    expect((await counts()).tx).toBe(1);
    expect(await balanceAsOf(ledger, checking.id, "2025-12-31")).toBe(999);
  });
});

describe("any-shape identity reads (task 05a)", () => {
  async function postXlsx(row: number) {
    return postTransaction(ledger, {
      date: "2026-03-01",
      payee_id: payeeId,
      source: "xlsx",
      source_sheet: "2026",
      source_row: row,
      source_col: 2,
      occurrence_index: 1,
      splits: [
        { account_id: groceries.id, amount_cents: 4858 },
        { account_id: checking.id, amount_cents: -4858 },
      ],
    });
  }

  async function editIntoThreeSplits(id: number, payee: number | null) {
    await updateTransaction(ledger, id, {
      date: "2026-03-01",
      payee_id: payee,
      splits: [
        { account_id: groceries.id, amount_cents: 3000 },
        { account_id: groceries.id, amount_cents: 1858 },
        { account_id: checking.id, amount_cents: -4858 },
      ],
    });
  }

  it("listXlsxIdentities returns a matching xlsx transaction after it is edited into three splits", async () => {
    const intact = await postXlsx(2);
    const edited = await postXlsx(3);
    await editIntoThreeSplits(edited.id, payeeId);
    // Not xlsx: must never be returned.
    await postTransaction(ledger, {
      date: "2026-03-01",
      payee_id: payeeId,
      splits: [
        { account_id: groceries.id, amount_cents: 4858 },
        { account_id: checking.id, amount_cents: -4858 },
      ],
    });

    const rows = await ledger.listXlsxIdentities([
      { payee_id: payeeId, account_id: checking.id, date: "2026-03-01", amount_cents: 4858 },
      { payee_id: payeeId, account_id: checking.id, date: "2026-03-01", amount_cents: 4858 },
    ]);
    expect(rows).toEqual([
      {
        id: intact.id,
        payee_id: payeeId,
        import_account_id: checking.id,
        date: "2026-03-01",
        import_amount_cents: 4858,
        source_sheet: "2026",
        source_row: 2,
        source_col: 2,
        occurrence_index: 1,
      },
      {
        id: edited.id,
        payee_id: payeeId,
        import_account_id: checking.id,
        date: "2026-03-01",
        import_amount_cents: 4858,
        source_sheet: "2026",
        source_row: 3,
        source_col: 2,
        occurrence_index: 1,
      },
    ]);
    expect(await ledger.listXlsxIdentities([])).toEqual([]);
  });

  it("listTransactionsByExternalRef flags payment shape exactly like the payments facade", async () => {
    const mk = (ref: string, payee: number | null) =>
      postTransaction(ledger, {
        date: "2026-03-01",
        payee_id: payee,
        source: "gnucash",
        external_ref: ref,
        splits: [
          { account_id: groceries.id, amount_cents: 4858 },
          { account_id: checking.id, amount_cents: -4858 },
        ],
      });
    const intact = await mk("g-intact", payeeId);
    const edited = await mk("g-edited", payeeId);
    const noPayee = await mk("g-nopayee", null);
    await editIntoThreeSplits(edited.id, payeeId);

    const rows = await ledger.listTransactionsByExternalRef("gnucash", [
      "g-intact",
      "g-edited",
      "g-nopayee",
      "g-absent",
    ]);
    expect(rows).toEqual([
      { id: intact.id, external_ref: "g-intact", payment_shaped: true },
      { id: edited.id, external_ref: "g-edited", payment_shaped: false },
      { id: noPayee.id, external_ref: "g-nopayee", payment_shaped: false },
    ]);
    // Facade agreement: only the intact one is a payment.
    for (const row of rows) {
      expect((await t.repos.payments.get(row.id)) !== null).toBe(row.payment_shaped);
    }
    expect(await ledger.listTransactionsByExternalRef("xlsx", ["g-intact"])).toEqual([]);
  });
});
