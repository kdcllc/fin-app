// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { postTransaction, type LedgerAccount } from "../src/core";
import { AccountsPage } from "../src/pages/AccountsPage";
import { openTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
let checking: LedgerAccount;
let card: LedgerAccount;
let groceries: LedgerAccount;
let bank: LedgerAccount;
const onOpenRegister = vi.fn();

async function sys(role: "root_asset" | "root_liability" | "root_expense") {
  const account = await t.repos.ledger.getSystemAccount(role);
  if (account === null) throw new Error(`missing ${role}`);
  return account;
}

beforeEach(async () => {
  onOpenRegister.mockClear();
  t = openTestDb();
  const ledger = t.repos.ledger;
  const rootAsset = await sys("root_asset");
  bank = await ledger.insertAccount({ name: "Bank Group", type: "ASSET", parent_id: rootAsset.id });
  checking = await ledger.insertAccount({
    name: "Checking X",
    type: "ASSET",
    subtype: "bank",
    parent_id: bank.id,
  });
  card = await ledger.insertAccount({
    name: "Card X",
    type: "LIABILITY",
    subtype: "credit_card",
    last4: "4321",
    parent_id: (await sys("root_liability")).id,
  });
  groceries = await ledger.insertAccount({
    name: "Groceries",
    type: "EXPENSE",
    parent_id: (await sys("root_expense")).id,
  });
  // $500.00 into checking via opening balance, then $120.50 of groceries on the card.
  await postTransaction(ledger, {
    date: "2020-01-02",
    splits: [
      { account_id: checking.id, amount_cents: 50000 },
      { account_id: (await ledger.getSystemAccount("opening_balances"))!.id, amount_cents: -50000 },
    ],
  });
  await postTransaction(ledger, {
    date: "2020-01-03",
    splits: [
      { account_id: groceries.id, amount_cents: 12050 },
      { account_id: card.id, amount_cents: -12050 },
    ],
  });
});

afterEach(() => {
  cleanup();
  t.close();
});

function renderPage() {
  return render(<AccountsPage repos={t.repos} onOpenRegister={onOpenRegister} />);
}

async function ownCell(id: number) {
  return (await screen.findByTestId(`own-${id}`)).textContent;
}

describe("AccountsPage", () => {
  it("shows natural-sign balances and parent roll-ups", async () => {
    renderPage();
    expect(await ownCell(card.id)).toBe("$120.50"); // owed, positive
    expect(await ownCell(groceries.id)).toBe("$120.50");
    expect(await ownCell(checking.id)).toBe("$500.00");
    // Parent has no own balance but rolls up its child.
    expect(screen.getByTestId(`own-${bank.id}`).textContent).toBe("$0.00");
    expect(screen.getByTestId(`rolled-${bank.id}`).textContent).toBe("$500.00");
    const liabilitiesRoot = (await sys("root_liability")).id;
    expect(screen.getByTestId(`rolled-${liabilitiesRoot}`).textContent).toBe("$120.50");
    // type, subtype and last4 are shown on the row
    const cardRow = screen.getByTestId(`own-${card.id}`).closest("tr") as HTMLElement;
    expect(within(cardRow).getByText("LIABILITY")).toBeTruthy();
    expect(within(cardRow).getByText("credit card")).toBeTruthy();
    expect(within(cardRow).getByText("4321")).toBeTruthy();
  });

  it("defaults As of to today and re-queries balances when it changes", async () => {
    const user = userEvent.setup();
    renderPage();
    const asOf = (await screen.findByLabelText("As of")) as HTMLInputElement;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(asOf.value).toBe(today);
    expect((screen.getByLabelText("Show archived") as HTMLInputElement).checked).toBe(false);

    await ownCell(checking.id);
    await user.clear(asOf);
    await user.type(asOf, "2020-01-02");
    await waitFor(() => expect(screen.getByTestId(`own-${card.id}`).textContent).toBe("$0.00"));
    expect(screen.getByTestId(`own-${checking.id}`).textContent).toBe("$500.00");
  });

  it("opens the register when an account name is clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Checking X" }));
    expect(onOpenRegister).toHaveBeenCalledWith(checking.id);
  });

  it("adds an account under a chosen parent", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add account" }));
    await user.type(screen.getByLabelText("Name"), "Rainy Day");
    await user.selectOptions(screen.getByLabelText("Parent"), String(bank.id));
    await user.selectOptions(screen.getByLabelText("Subtype"), "savings");
    await user.type(screen.getByLabelText("Last 4 digits"), "9876");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("button", { name: "Rainy Day" })).toBeTruthy();
    const accounts = await t.repos.ledger.listAccounts();
    const created = accounts.find((a) => a.name === "Rainy Day");
    expect(created).toMatchObject({
      type: "ASSET",
      subtype: "savings",
      last4: "9876",
      parent_id: bank.id,
    });
  });

  it("offers only valid parents (no non-root placeholders)", async () => {
    const user = userEvent.setup();
    const ledger = t.repos.ledger;
    const placeholder = await ledger.insertAccount({
      name: "Placeholder Bucket",
      type: "EXPENSE",
      placeholder: true,
      parent_id: (await sys("root_expense")).id,
    });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add account" }));
    const parent = screen.getByLabelText("Parent") as HTMLSelectElement;
    const values = Array.from(parent.options).map((o) => o.value);
    expect(values).not.toContain(String(placeholder.id));
    expect(values).toContain(String((await sys("root_expense")).id));
    expect(values).toContain(String(groceries.id));
  });

  it("archives an account only after in-page confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Archive Groceries" }));
    // Nothing is archived yet.
    expect((await t.repos.ledger.getAccount(groceries.id))!.archived).toBe(false);
    expect(screen.getByText("Archive Groceries?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Confirm archive" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Groceries" })).toBeNull());
    expect((await t.repos.ledger.getAccount(groceries.id))!.archived).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByRole("button", { name: "Groceries" })).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it("cancelling the archive confirmation leaves the account active", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Archive Groceries" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect((await t.repos.ledger.getAccount(groceries.id))!.archived).toBe(false);
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeTruthy();
  });

  it("shows no edit or archive actions on roots or system accounts", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Assets" });
    expect(screen.queryByRole("button", { name: "Edit Assets" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive Assets" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Uncategorized" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive Opening Balances" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Groceries" })).toBeTruthy();
  });

  it("edits an account name", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit Groceries" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Food");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("button", { name: "Food" })).toBeTruthy();
    expect((await t.repos.ledger.getAccount(groceries.id))!.name).toBe("Food");
  });

  it("sets an opening balance (date defaults to today) and updates the tree", async () => {
    const user = userEvent.setup();
    renderPage();
    await ownCell(card.id);
    const date = screen.getByLabelText("Opening balance date") as HTMLInputElement;
    const now = new Date();
    expect(date.value).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    );
    await user.selectOptions(
      screen.getByLabelText("Opening balance account"),
      String((await t.repos.ledger.getAccount(card.id))!.id),
    );
    await user.type(screen.getByLabelText("Opening balance amount"), "$1,000.05");
    await user.click(screen.getByRole("button", { name: "Set opening balance" }));
    // owed 120.50 + 1000.05 opening balance owed
    await waitFor(() => expect(screen.getByTestId(`own-${card.id}`).textContent).toBe("$1120.55"));
  });

  it("rejects invalid input inline and writes nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    await ownCell(card.id);
    const before = (await t.repos.ledger.listAccounts()).length;
    const batchesBefore = t.calls.filter((c) => c.kind === "batch").length;

    // empty name
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.selectOptions(screen.getByLabelText("Parent"), String(bank.id));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/name is required/i);

    // bad last4
    await user.type(screen.getByLabelText("Name"), "Oops");
    await user.type(screen.getByLabelText("Last 4 digits"), "12a4");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/four digits/i));

    // non-numeric opening amount
    await user.selectOptions(screen.getByLabelText("Opening balance account"), String(checking.id));
    await user.type(screen.getByLabelText("Opening balance amount"), "12.345x");
    await user.click(screen.getByRole("button", { name: "Set opening balance" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/dollar amount/i));

    expect((await t.repos.ledger.listAccounts()).length).toBe(before);
    expect(t.calls.filter((c) => c.kind === "batch").length).toBe(batchesBefore);
    expect(screen.getByTestId(`own-${checking.id}`).textContent).toBe("$500.00");
  });

  it("shows core validation errors inline without a stack trace", async () => {
    const user = userEvent.setup();
    renderPage();
    // Equity-less check: opening balance on a system-adjacent placeholder is not offered,
    // so provoke a core ValidationError with an unreal calendar date.
    await ownCell(card.id);
    await user.selectOptions(screen.getByLabelText("Opening balance account"), String(checking.id));
    const date = screen.getByLabelText("Opening balance date");
    await user.clear(date);
    await user.type(date, "2021-02-30").catch(() => undefined);
    await user.type(screen.getByLabelText("Opening balance amount"), "5");
    await user.click(screen.getByRole("button", { name: "Set opening balance" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/date/i);
    expect(alert.textContent).not.toMatch(/\bat\b.*\.(ts|tsx):\d+/);
  });
});

async function newAsset(name: string, parentId?: number, extra: object = {}) {
  return t.repos.ledger.insertAccount({
    name,
    type: "ASSET",
    parent_id: parentId ?? (await sys("root_asset")).id,
    ...extra,
  });
}

async function setOpening(
  user: ReturnType<typeof userEvent.setup>,
  accountId: number,
  amount: string,
) {
  await user.selectOptions(screen.getByLabelText("Opening balance account"), String(accountId));
  const field = screen.getByLabelText("Opening balance amount");
  await user.clear(field);
  await user.type(field, amount);
  await user.click(screen.getByRole("button", { name: "Set opening balance" }));
}

describe("AccountsPage opening-balance parse rules", () => {
  it("rejects three decimals inline and writes nothing", async () => {
    const user = userEvent.setup();
    const target = await newAsset("Blank One");
    renderPage();
    await ownCell(target.id);
    const batches = t.calls.filter((c) => c.kind === "batch").length;
    await setOpening(user, target.id, "12.345");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/dollar amount/i));
    expect(t.calls.filter((c) => c.kind === "batch").length).toBe(batches);
    expect(screen.getByTestId(`own-${target.id}`).textContent).toBe("$0.00");
  });

  it("keeps the minus sign: -250.00 shows -$250.00", async () => {
    const user = userEvent.setup();
    const target = await newAsset("Blank Two");
    renderPage();
    await ownCell(target.id);
    await setOpening(user, target.id, "-250.00");
    await waitFor(() =>
      expect(screen.getByTestId(`own-${target.id}`).textContent).toBe("-$250.00"),
    );
  });

  it("clears an opening balance when 0 is entered", async () => {
    const user = userEvent.setup();
    const target = await newAsset("Blank Three");
    renderPage();
    await ownCell(target.id);
    await setOpening(user, target.id, "75.00");
    await waitFor(() => expect(screen.getByTestId(`own-${target.id}`).textContent).toBe("$75.00"));
    await setOpening(user, target.id, "0");
    await waitFor(() => expect(screen.getByTestId(`own-${target.id}`).textContent).toBe("$0.00"));
    expect(screen.getByRole("status").textContent).toBe("Opening balance cleared.");
  });
});

describe("AccountsPage local-date defaults", () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"] });
    // 22:30 on 14 March local (EDT) is already 15 March in UTC.
    vi.setSystemTime(new Date("2026-03-15T02:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("uses the local date, not the UTC date, for As of and Opening balance date", async () => {
    const now = new Date();
    expect(now.toISOString().slice(0, 10)).toBe("2026-03-15");
    expect(now.getDate()).toBe(14); // precondition: local and UTC dates differ
    renderPage();
    expect(((await screen.findByLabelText("As of")) as HTMLInputElement).value).toBe("2026-03-14");
    expect((screen.getByLabelText("Opening balance date") as HTMLInputElement).value).toBe(
      "2026-03-14",
    );
  });
});

describe("AccountsPage subtype and parent rules", () => {
  it("offers Subtype for an ASSET parent but not EXPENSE or INCOME parents", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add account" }));
    const parent = screen.getByLabelText("Parent");
    await user.selectOptions(parent, String(bank.id));
    expect(screen.queryByLabelText("Subtype")).not.toBeNull();
    await user.selectOptions(parent, String((await sys("root_expense")).id));
    expect(screen.queryByLabelText("Subtype")).toBeNull();
    const incomeRoot = (await t.repos.ledger.getSystemAccount("root_income"))!;
    await user.selectOptions(parent, String(incomeRoot.id));
    expect(screen.queryByLabelText("Subtype")).toBeNull();
  });

  it("edit form lists only same-type parents, never the account or its descendants", async () => {
    const user = userEvent.setup();
    const other = await newAsset("Other Bank");
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit Bank Group" }));
    const labels = Array.from((screen.getByLabelText("Parent") as HTMLSelectElement).options).map(
      (o) => o.textContent ?? "",
    );
    expect(labels.some((l) => l.includes("Other Bank"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Assets"))).toBe(true);
    for (const forbidden of [
      "Card X",
      "Groceries",
      "Liabilities",
      "Expenses",
      "Income",
      "Equity",
    ]) {
      expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    }
    expect(labels.some((l) => l.includes("Bank Group"))).toBe(false); // itself
    expect(labels.some((l) => l.includes("Checking X"))).toBe(false); // descendant
    expect(other.id).toBeGreaterThan(0);
  });

  it("keeps a placeholder or archived current parent selected in the edit form", async () => {
    const user = userEvent.setup();
    const hold = await newAsset("Hold", undefined, { placeholder: true });
    const kid = await newAsset("Kid", hold.id);
    const old = await newAsset("Old Parent");
    const kid2 = await newAsset("Kid Two", old.id);
    await t.repos.ledger.archiveAccount(old.id);
    renderPage();
    for (const [account, parent] of [
      [kid, hold],
      [kid2, old],
    ] as const) {
      await user.click(await screen.findByRole("button", { name: `Edit ${account.name}` }));
      const select = screen.getByLabelText("Parent") as HTMLSelectElement;
      expect(select.value).toBe(String(parent.id));
      expect(select.selectedOptions[0].textContent).toMatch(/\(current\)$/);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }
  });

  it("keeps the subtype when the parent changes in the edit form", async () => {
    const user = userEvent.setup();
    const other = await newAsset("Other Bank");
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit Checking X" }));
    expect((screen.getByLabelText("Subtype") as HTMLSelectElement).value).toBe("bank");
    await user.selectOptions(screen.getByLabelText("Parent"), String(other.id));
    expect((screen.getByLabelText("Subtype") as HTMLSelectElement).value).toBe("bank");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () => {
      const saved = await t.repos.ledger.getAccount(checking.id);
      expect(saved).toMatchObject({ parent_id: other.id, subtype: "bank" });
    });
  });
});
