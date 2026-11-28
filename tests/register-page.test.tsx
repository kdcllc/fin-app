// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SPLIT_COUNTERPART_LABEL,
  getRegister,
  postTransaction,
  type LedgerAccount,
  type Payee,
  type Transaction,
} from "../src/core";
import { RegisterPage } from "../src/pages/RegisterPage";
import { openTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
let checking: LedgerAccount;
let savings: LedgerAccount;
let card: LedgerAccount;
let groceries: LedgerAccount;
let fuel: LedgerAccount;
let salary: LedgerAccount;
let store: Payee;
let employer: Payee;
let opening: Transaction;
let shop1: Transaction;
let shop2: Transaction;
let cardSpend: Transaction;
let cardPayment: Transaction;

async function sys(
  role: "root_asset" | "root_liability" | "root_expense" | "root_income" | "opening_balances",
) {
  const account = await t.repos.ledger.getSystemAccount(role);
  if (account === null) throw new Error(`missing ${role}`);
  return account;
}

beforeEach(async () => {
  t = openTestDb();
  const ledger = t.repos.ledger;
  checking = await ledger.insertAccount({
    name: "Checking R",
    type: "ASSET",
    subtype: "bank",
    parent_id: (await sys("root_asset")).id,
  });
  savings = await ledger.insertAccount({
    name: "Savings R",
    type: "ASSET",
    subtype: "savings",
    parent_id: (await sys("root_asset")).id,
  });
  card = await ledger.insertAccount({
    name: "Card R",
    type: "LIABILITY",
    subtype: "credit_card",
    parent_id: (await sys("root_liability")).id,
  });
  groceries = await ledger.insertAccount({
    name: "Groceries R",
    type: "EXPENSE",
    parent_id: (await sys("root_expense")).id,
  });
  fuel = await ledger.insertAccount({
    name: "Fuel R",
    type: "EXPENSE",
    parent_id: (await sys("root_expense")).id,
  });
  salary = await ledger.insertAccount({
    name: "Salary R",
    type: "INCOME",
    parent_id: (await sys("root_income")).id,
  });
  store = await t.repos.payees.insert({ name: "Corner Store" });
  employer = await t.repos.payees.insert({ name: "Example Employer" });
  const equity = (await sys("opening_balances")).id;

  // checking: +500.00, -30.00, -20.00 -> 500.00, 470.00, 450.00
  opening = await postTransaction(ledger, {
    date: "2020-01-02",
    memo: "Opening",
    splits: [
      { account_id: checking.id, amount_cents: 50000 },
      { account_id: equity, amount_cents: -50000 },
    ],
  });
  shop1 = await postTransaction(ledger, {
    date: "2020-02-01",
    payee_id: store.id,
    memo: "Food",
    splits: [
      { account_id: groceries.id, amount_cents: 3000 },
      { account_id: checking.id, amount_cents: -3000 },
    ],
  });
  shop2 = await postTransaction(ledger, {
    date: "2020-03-01",
    memo: "More food",
    splits: [
      { account_id: groceries.id, amount_cents: 2000 },
      { account_id: checking.id, amount_cents: -2000 },
    ],
  });
  // card (liability): owes 40.00 after the spend, 30.00 after the payment
  cardSpend = await postTransaction(ledger, {
    date: "2020-02-05",
    memo: "Card food",
    splits: [
      { account_id: groceries.id, amount_cents: 4000 },
      { account_id: card.id, amount_cents: -4000 },
    ],
  });
  cardPayment = await postTransaction(ledger, {
    date: "2020-03-02",
    memo: "Card payment",
    splits: [
      { account_id: card.id, amount_cents: 1000 },
      { account_id: checking.id, amount_cents: -1000 },
    ],
  });
});

afterEach(() => {
  cleanup();
  t.close();
});

function renderPage(initialAccountId?: number) {
  return render(<RegisterPage repos={t.repos} initialAccountId={initialAccountId} />);
}

type User = ReturnType<typeof userEvent.setup>;

function cell(kind: "balance" | "increase" | "decrease", tx: Transaction): string {
  return screen.getByTestId(`${kind}-${tx.id}`).textContent ?? "";
}

function selector(): HTMLSelectElement {
  return screen.getByLabelText("Register account") as HTMLSelectElement;
}

async function waitForRow(tx: Transaction) {
  return screen.findByTestId(`balance-${tx.id}`);
}

async function typeInto(user: User, label: string, value: string) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  if (value !== "") await user.type(field, value);
}

describe("RegisterPage rows", () => {
  it("shows running balances, honoring From/To; the running balance starts before From", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    expect(cell("balance", opening)).toBe("$500.00");
    expect(cell("balance", shop1)).toBe("$470.00");
    expect(cell("balance", shop2)).toBe("$450.00");
    // the filters default to empty (unbounded)
    expect((screen.getByLabelText("From date") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("");

    await user.type(screen.getByLabelText("From date"), "2020-02-15");
    await waitFor(() => expect(screen.queryByTestId(`balance-${shop1.id}`)).toBeNull());
    expect(cell("balance", shop2)).toBe("$450.00"); // still carries the earlier balance
    expect(screen.queryByTestId(`balance-${opening.id}`)).toBeNull();

    await user.type(screen.getByLabelText("To date"), "2020-03-01");
    await waitFor(() => expect(screen.queryByTestId(`balance-${cardPayment.id}`)).toBeNull());
    expect(cell("balance", shop2)).toBe("$450.00");
  });

  it("shows date, payee, memo, counterpart and cents-formatted amounts", async () => {
    renderPage(checking.id);
    const rowCell = await waitForRow(shop1);
    const row = rowCell.closest("tr") as HTMLElement;
    expect(within(row).getByText("2020-02-01")).toBeTruthy();
    expect(within(row).getByText("Corner Store")).toBeTruthy();
    expect(within(row).getByText("Food")).toBeTruthy();
    expect(within(row).getByText("Groceries R")).toBeTruthy();
    expect(cell("decrease", shop1)).toBe("$30.00");
    expect(cell("increase", shop1)).toBe("");
  });

  it("uses the account's natural sign for increase/decrease/balance (liability)", async () => {
    renderPage(card.id);
    await waitForRow(cardSpend);
    expect(cell("increase", cardSpend)).toBe("$40.00");
    expect(cell("decrease", cardSpend)).toBe("");
    expect(cell("balance", cardSpend)).toBe("$40.00");
    expect(cell("decrease", cardPayment)).toBe("$10.00");
    expect(cell("balance", cardPayment)).toBe("$30.00");
  });

  it("selector lists only non-placeholder accounts", async () => {
    renderPage(checking.id);
    await waitForRow(opening);
    const values = Array.from(selector().options).map((o) => o.value);
    for (const role of [
      "root_asset",
      "root_liability",
      "root_expense",
      "root_income",
      "root_equity",
    ] as const) {
      const root = (await t.repos.ledger.getSystemAccount(role))!;
      expect(values).not.toContain(String(root.id));
    }
    expect(values).toContain(String(checking.id));
    expect(values).toContain(String(salary.id));
  });
});

describe("RegisterPage archived accounts", () => {
  it("lists an archived non-placeholder account with the (archived) marker", async () => {
    await t.repos.ledger.archiveAccount(fuel.id);
    renderPage(checking.id);
    await waitForRow(opening);
    const option = Array.from(selector().options).find((o) => o.value === String(fuel.id));
    expect(option?.textContent).toMatch(/Fuel R.*\(archived\)$/);
  });
});

describe("RegisterPage initial account", () => {
  it("selects initialAccountId when it is a real account", async () => {
    renderPage(card.id);
    await waitFor(() => expect(selector().value).toBe(String(card.id)));
  });

  it("falls back to the first funding account when the id is a placeholder", async () => {
    const root = await sys("root_expense");
    renderPage(root.id);
    await waitForRow(opening);
    expect(selector().value).toBe(String(checking.id));
  });

  it("falls back to the first funding account when the id is missing or unknown", async () => {
    const view = renderPage(undefined);
    await waitForRow(opening);
    expect(selector().value).toBe(String(checking.id));
    view.unmount();
    renderPage(987654);
    await waitForRow(opening);
    expect(selector().value).toBe(String(checking.id));
  });
});

describe("RegisterPage transaction editor", () => {
  it("keeps Save disabled until a three-split transaction balances, then shows it as a split", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    await user.click(screen.getByRole("button", { name: "Add transaction" }));
    await user.click(screen.getByRole("button", { name: "Add split" }));
    // a fourth split is added then removed again: it must not be saved
    await user.click(screen.getByRole("button", { name: "Add split" }));
    expect(screen.getByLabelText("Split 4 account")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove split 4" }));
    expect(screen.queryByLabelText("Split 4 account")).toBeNull();

    const save = () =>
      screen.getByRole("button", { name: "Save transaction" }) as HTMLButtonElement;
    await user.selectOptions(screen.getByLabelText("Split 2 account"), String(groceries.id));
    await user.selectOptions(screen.getByLabelText("Split 3 account"), String(fuel.id));
    await typeInto(user, "Transaction date", "2020-04-10");
    await user.type(screen.getByLabelText("Transaction memo"), "Weekly shop");
    await user.type(screen.getByLabelText("Split 2 memo"), "Veg");
    await user.type(screen.getByLabelText("Split 1 amount"), "-100");
    await user.type(screen.getByLabelText("Split 2 amount"), "60");
    await user.type(screen.getByLabelText("Split 3 amount"), "30");
    expect(screen.getByTestId("imbalance").textContent).toBe("Imbalance: -$10.00");
    expect(save().disabled).toBe(true);

    await user.clear(screen.getByLabelText("Split 3 amount"));
    await user.type(screen.getByLabelText("Split 3 amount"), "40");
    expect(screen.getByTestId("imbalance").textContent).toBe("Imbalance: $0.00");
    expect(save().disabled).toBe(false);
    await user.click(save());

    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Transaction form" })).toBeNull(),
    );
    const rows = await getRegister(t.repos.ledger, checking.id);
    const saved = rows.find((r) => r.date === "2020-04-10")!;
    expect(saved.counterpart).toBe(SPLIT_COUNTERPART_LABEL);
    expect(saved.amount_cents).toBe(-10000);
    const stored = (await t.repos.ledger.getTransaction(saved.transaction_id))!;
    expect(stored.memo).toBe("Weekly shop");
    expect(stored.splits).toHaveLength(3);
    expect(stored.splits.find((x) => x.account_id === groceries.id)!.memo).toBe("Veg");
    const row = (await screen.findByTestId(`balance-${saved.transaction_id}`)).closest("tr")!;
    expect(within(row as HTMLElement).getByText("— Split —")).toBeTruthy();
    expect(cell("decrease", saved.transaction)).toBe("$100.00");
    expect(cell("balance", saved.transaction)).toBe("$340.00");
  });

  it("rejects bad amounts without writing: 3 decimals disable Save, minus is kept, 0 is accepted", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    await user.click(screen.getByRole("button", { name: "Add transaction" }));
    await user.selectOptions(screen.getByLabelText("Split 2 account"), String(groceries.id));
    const save = () =>
      screen.getByRole("button", { name: "Save transaction" }) as HTMLButtonElement;

    await user.type(screen.getByLabelText("Split 1 amount"), "12.345");
    await user.type(screen.getByLabelText("Split 2 amount"), "-12.345");
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId("imbalance").textContent).toMatch(/dollar amount/);

    await typeInto(user, "Split 1 amount", "-5.25");
    await typeInto(user, "Split 2 amount", "5.25");
    expect(screen.getByTestId("imbalance").textContent).toBe("Imbalance: $0.00");
    expect(save().disabled).toBe(false);

    await typeInto(user, "Split 1 amount", "0");
    await typeInto(user, "Split 2 amount", "0");
    expect(save().disabled).toBe(false);
    const before = (await getRegister(t.repos.ledger, checking.id)).length;
    await typeInto(user, "Transaction date", "2020-05-01");
    await user.click(save());
    await waitFor(async () =>
      expect((await getRegister(t.repos.ledger, checking.id)).length).toBe(before + 1),
    );
  });

  it("shows a core ValidationError inline without a stack trace", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    await user.click(screen.getByRole("button", { name: "Add transaction" }));
    await user.selectOptions(screen.getByLabelText("Split 2 account"), String(groceries.id));
    await user.type(screen.getByLabelText("Split 1 amount"), "-5");
    await user.type(screen.getByLabelText("Split 2 amount"), "5");
    await typeInto(user, "Transaction date", "");
    await user.click(screen.getByRole("button", { name: "Save transaction" }));
    const alert = await screen.findByTestId("editor-error");
    expect(alert.textContent).toMatch(/ISO date/);
    expect(alert.textContent).not.toMatch(/\.(ts|tsx):\d+/);
    expect(screen.getByRole("form", { name: "Transaction form" })).toBeTruthy();
  });

  it("defaults new transaction, transfer and income dates to the LOCAL date", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"] });
    // 22:30 on 14 March local (EDT) is already 15 March in UTC.
    vi.setSystemTime(new Date("2026-03-15T02:30:00Z"));
    try {
      const now = new Date();
      expect(now.toISOString().slice(0, 10)).toBe("2026-03-15");
      expect(now.getDate()).toBe(14); // precondition: local and UTC dates differ
      const user = userEvent.setup({ advanceTimers: () => {} });
      renderPage(checking.id);
      await waitForRow(opening);
      expect((screen.getByLabelText("Transfer date") as HTMLInputElement).value).toBe("2026-03-14");
      expect((screen.getByLabelText("Income date") as HTMLInputElement).value).toBe("2026-03-14");
      await user.click(screen.getByRole("button", { name: "Add transaction" }));
      expect((screen.getByLabelText("Transaction date") as HTMLInputElement).value).toBe(
        "2026-03-14",
      );
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("edits a row's amounts and the running balances follow", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(shop1);
    await user.click(screen.getByRole("button", { name: `Edit transaction ${shop1.id}` }));
    expect((screen.getByLabelText("Transaction memo") as HTMLInputElement).value).toBe("Food");
    const amounts = [1, 2].map(
      (n) => (screen.getByLabelText(`Split ${n} amount`) as HTMLInputElement).value,
    );
    expect(new Set(amounts)).toEqual(new Set(["30.00", "-30.00"]));
    for (const n of [1, 2]) {
      const field = screen.getByLabelText(`Split ${n} amount`) as HTMLInputElement;
      await typeInto(user, `Split ${n} amount`, field.value.startsWith("-") ? "-35" : "35");
    }
    await user.click(screen.getByRole("button", { name: "Save transaction" }));
    await waitFor(() => expect(cell("balance", shop1)).toBe("$465.00"));
    expect(cell("balance", shop2)).toBe("$445.00");
    expect(cell("decrease", shop1)).toBe("$35.00");
    expect((await t.repos.ledger.getTransaction(shop1.id))!.payee_id).toBe(store.id);
    expect((await t.repos.ledger.getTransaction(shop1.id))!.memo).toBe("Food");
  });

  it("keeps a cleared (c) split cleared when its transaction is edited", async () => {
    const user = userEvent.setup();
    const cleared = await postTransaction(t.repos.ledger, {
      date: "2020-04-05",
      memo: "Cleared one",
      splits: [
        { account_id: groceries.id, amount_cents: 900 },
        { account_id: checking.id, amount_cents: -900, reconcile_state: "c" },
      ],
    });
    renderPage(checking.id);
    await waitForRow(cleared);
    await user.click(screen.getByRole("button", { name: `Edit transaction ${cleared.id}` }));
    await typeInto(user, "Transaction memo", "Cleared edited");
    await user.click(screen.getByRole("button", { name: "Save transaction" }));
    await waitFor(async () =>
      expect((await t.repos.ledger.getTransaction(cleared.id))!.memo).toBe("Cleared edited"),
    );
    const stored = (await t.repos.ledger.getTransaction(cleared.id))!;
    expect(stored.splits.find((x) => x.account_id === checking.id)!.reconcile_state).toBe("c");
  });

  it("deletes a row only after in-page confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    renderPage(checking.id);
    await waitForRow(shop1);

    await user.click(screen.getByRole("button", { name: `Delete transaction ${shop1.id}` }));
    expect(await t.repos.ledger.getTransaction(shop1.id)).not.toBeNull();
    expect(screen.getByText(/Delete this transaction\?/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(await t.repos.ledger.getTransaction(shop1.id)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: `Delete transaction ${shop1.id}` }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.queryByTestId(`balance-${shop1.id}`)).toBeNull());
    expect(await t.repos.ledger.getTransaction(shop1.id)).toBeNull();
    expect(cell("balance", shop2)).toBe("$480.00");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it("shows the reconciled-transaction error inline and keeps the row", async () => {
    const user = userEvent.setup();
    const locked = await postTransaction(t.repos.ledger, {
      date: "2020-04-01",
      memo: "Locked",
      splits: [
        { account_id: groceries.id, amount_cents: 700 },
        { account_id: checking.id, amount_cents: -700, reconcile_state: "y" },
      ],
    });
    renderPage(checking.id);
    await waitForRow(locked);
    await user.click(screen.getByRole("button", { name: `Delete transaction ${locked.id}` }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/reconciled/i);
    expect(await t.repos.ledger.getTransaction(locked.id)).not.toBeNull();
    expect(screen.getByTestId(`balance-${locked.id}`)).toBeTruthy();
  });
});

describe("RegisterPage quick forms", () => {
  it("records a transfer that both accounts' registers reflect", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    await user.selectOptions(screen.getByLabelText("Transfer from"), String(checking.id));
    await user.selectOptions(screen.getByLabelText("Transfer to"), String(savings.id));
    await typeInto(user, "Transfer amount", "25.50");
    await typeInto(user, "Transfer date", "2020-04-02");
    await user.type(screen.getByLabelText("Transfer memo"), "Rainy day");
    await user.click(screen.getByRole("button", { name: "Record transfer" }));

    await waitFor(async () => {
      const rows = await getRegister(t.repos.ledger, checking.id);
      expect(rows.find((r) => r.date === "2020-04-02")).toMatchObject({
        amount_cents: -2550,
        memo: "Rainy day",
        counterpart: "Savings R",
      });
    });
    const checkingRows = await getRegister(t.repos.ledger, checking.id);
    const out = checkingRows.find((r) => r.date === "2020-04-02")!;
    expect((await screen.findByTestId(`decrease-${out.transaction_id}`)).textContent).toBe(
      "$25.50",
    );

    await user.selectOptions(selector(), String(savings.id));
    const inbound = (await getRegister(t.repos.ledger, savings.id))[0];
    expect((await screen.findByTestId(`increase-${inbound.transaction_id}`)).textContent).toBe(
      "$25.50",
    );
    expect(cell("balance", inbound.transaction)).toBe("$25.50");
  });

  it("rejects a 3-decimal transfer amount inline and writes nothing", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    const before = t.calls.filter((c) => c.kind === "batch").length;
    await user.selectOptions(screen.getByLabelText("Transfer from"), String(checking.id));
    await user.selectOptions(screen.getByLabelText("Transfer to"), String(savings.id));
    await user.type(screen.getByLabelText("Transfer amount"), "12.345");
    await user.click(screen.getByRole("button", { name: "Record transfer" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/dollar amount/i);
    expect(t.calls.filter((c) => c.kind === "batch").length).toBe(before);
  });

  it("shows a core error for a zero-amount transfer inline", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    await user.selectOptions(screen.getByLabelText("Transfer from"), String(checking.id));
    await user.selectOptions(screen.getByLabelText("Transfer to"), String(savings.id));
    await user.type(screen.getByLabelText("Transfer amount"), "0");
    await user.click(screen.getByRole("button", { name: "Record transfer" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/positive/i);
  });

  it("records income that both the deposit and income registers reflect", async () => {
    const user = userEvent.setup();
    renderPage(checking.id);
    await waitForRow(opening);
    await user.selectOptions(screen.getByLabelText("Income account"), String(salary.id));
    await user.selectOptions(screen.getByLabelText("Deposit account"), String(checking.id));
    await typeInto(user, "Income amount", "1,000.00");
    await typeInto(user, "Income date", "2020-04-15");
    await user.selectOptions(screen.getByLabelText("Income payee"), String(employer.id));
    await user.type(screen.getByLabelText("Income memo"), "Pay day");
    await user.click(screen.getByRole("button", { name: "Record income" }));

    await waitFor(async () => {
      const rows = await getRegister(t.repos.ledger, checking.id);
      expect(rows.find((r) => r.date === "2020-04-15")).toMatchObject({
        amount_cents: 100000,
        payee_id: employer.id,
        memo: "Pay day",
        counterpart: "Salary R",
      });
    });
    const deposit = (await getRegister(t.repos.ledger, checking.id)).find(
      (r) => r.date === "2020-04-15",
    )!;
    const depositRow = (await screen.findByTestId(`increase-${deposit.transaction_id}`)).closest(
      "tr",
    )!;
    expect(screen.getByTestId(`increase-${deposit.transaction_id}`).textContent).toBe("$1000.00");
    expect(within(depositRow as HTMLElement).getByText("Example Employer")).toBeTruthy();
    expect(cell("balance", deposit.transaction)).toBe("$1440.00");

    await user.selectOptions(selector(), String(salary.id));
    const incomeRow = (await getRegister(t.repos.ledger, salary.id))[0];
    expect((await screen.findByTestId(`increase-${incomeRow.transaction_id}`)).textContent).toBe(
      "$1000.00",
    );
    expect(cell("balance", incomeRow.transaction)).toBe("$1000.00");
  });

  it("shows an empty-state hint and disables Record income when no income account exists", async () => {
    await t.repos.ledger.archiveAccount(salary.id);
    renderPage(checking.id);
    await waitForRow(opening);
    const hint = await screen.findByTestId("income-empty-hint");
    expect(hint.textContent).toBe(
      "No income accounts yet — add one under Income on the Accounts page.",
    );
    expect(
      (screen.getByRole("button", { name: "Record income" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("hides the hint and enables Record income once an income account exists", async () => {
    const user = userEvent.setup();
    await t.repos.ledger.archiveAccount(salary.id);
    const bonus = await t.repos.ledger.insertAccount({
      name: "Bonus R",
      type: "INCOME",
      parent_id: (await sys("root_income")).id,
    });
    renderPage(checking.id);
    await waitForRow(opening);
    expect(screen.queryByTestId("income-empty-hint")).toBeNull();
    const button = screen.getByRole("button", { name: "Record income" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await user.selectOptions(screen.getByLabelText("Income account"), String(bonus.id));
    await user.selectOptions(screen.getByLabelText("Deposit account"), String(checking.id));
    await typeInto(user, "Income amount", "10.00");
    await typeInto(user, "Income date", "2020-04-16");
    await user.click(button);
    await waitFor(async () => {
      const rows = await getRegister(t.repos.ledger, checking.id);
      expect(rows.find((r) => r.date === "2020-04-16")).toMatchObject({
        amount_cents: 1000,
        counterpart: "Bonus R",
      });
    });
  });
});
