// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Account, Category, Payment, Payee, Repositories } from "../src/core";
import { PaymentsPage } from "../src/pages/PaymentsPage";
import { openTestDb, type TestDb } from "./support/test-db";

function clonePayee(payee: Payee): Payee {
  return { ...payee };
}

function cloneAccount(account: Account): Account {
  return { ...account };
}

function cloneCategory(category: Category): Category {
  return { ...category };
}

function clonePayment(payment: Payment): Payment {
  return { ...payment };
}

function createMockRepos(): Repositories {
  let payees: Payee[] = [
    {
      id: 1,
      name: "Power Co",
      default_account_id: 1,
      default_category_id: 1,
      notes: null,
      archived: false,
    },
    {
      id: 2,
      name: "Grocer",
      default_account_id: 2,
      default_category_id: 2,
      notes: null,
      archived: false,
    },
  ];

  const accounts: Account[] = [
    {
      id: 1,
      name: "Checking",
      kind: "checking",
      type: "ASSET",
      subtype: "bank",
      parent_id: 100,
      last4: null,
      gnucash_guid: null,
      archived: false,
    },
    {
      id: 2,
      name: "Rewards Card",
      kind: "credit",
      type: "LIABILITY",
      subtype: "credit_card",
      parent_id: 101,
      last4: null,
      gnucash_guid: null,
      archived: false,
    },
  ];

  const categories: Category[] = [
    { id: 1, name: "Utilities", parent_id: null, gnucash_guid: null, archived: false },
    { id: 2, name: "Groceries", parent_id: null, gnucash_guid: null, archived: false },
  ];

  let payments: Payment[] = [
    {
      id: 1,
      payee_id: 1,
      account_id: 1,
      category_id: 1,
      date: "2026-02-10",
      amount_cents: 4005,
      memo: "monthly",
      source: "manual",
      external_ref: null,
      source_sheet: null,
      source_row: null,
      source_col: null,
      occurrence_index: null,
      created_at: "2026-02-10 10:00:00",
    },
  ];

  let nextPaymentId = 2;

  const repos = {
    accounts: {
      async list(options?: { includeArchived?: boolean }) {
        const includeArchived = options?.includeArchived ?? false;
        const rows = includeArchived ? accounts : accounts.filter((row) => !row.archived);
        return rows.map(cloneAccount);
      },
      async get(id: number) {
        const row = accounts.find((item) => item.id === id) ?? null;
        return row ? cloneAccount(row) : null;
      },
      insert: async (_input: Parameters<Repositories["accounts"]["insert"]>[0]) => {
        throw new Error("not used in this test");
      },
      update: async (_id: number, _patch: Parameters<Repositories["accounts"]["update"]>[1]) => {
        throw new Error("not used in this test");
      },
      archive: async (_id: number) => {
        throw new Error("not used in this test");
      },
      delete: async (_id: number) => {
        throw new Error("not used in this test");
      },
    },
    categories: {
      async list(options?: { includeArchived?: boolean }) {
        const includeArchived = options?.includeArchived ?? false;
        const rows = includeArchived ? categories : categories.filter((row) => !row.archived);
        return rows.map(cloneCategory);
      },
      async get(id: number) {
        const row = categories.find((item) => item.id === id) ?? null;
        return row ? cloneCategory(row) : null;
      },
      insert: async (_input: Parameters<Repositories["categories"]["insert"]>[0]) => {
        throw new Error("not used in this test");
      },
      update: async (_id: number, _patch: Parameters<Repositories["categories"]["update"]>[1]) => {
        throw new Error("not used in this test");
      },
      archive: async (_id: number) => {
        throw new Error("not used in this test");
      },
      delete: async (_id: number) => {
        throw new Error("not used in this test");
      },
    },
    payees: {
      async list(options?: { includeArchived?: boolean }) {
        const includeArchived = options?.includeArchived ?? false;
        const rows = includeArchived ? payees : payees.filter((row) => !row.archived);
        return rows.map(clonePayee);
      },
      async get(id: number) {
        const row = payees.find((item) => item.id === id) ?? null;
        return row ? clonePayee(row) : null;
      },
      insert: async (_input: Parameters<Repositories["payees"]["insert"]>[0]) => {
        throw new Error("not used in this test");
      },
      update: async (_id: number, _patch: Parameters<Repositories["payees"]["update"]>[1]) => {
        throw new Error("not used in this test");
      },
      archive: async (_id: number) => {
        throw new Error("not used in this test");
      },
      delete: async (_id: number) => {
        throw new Error("not used in this test");
      },
      merge: async (_survivorId: number, _sourceId: number) => {
        throw new Error("not used in this test");
      },
    },
    payments: {
      async list(filter: Parameters<Repositories["payments"]["list"]>[0]) {
        const rows = payments.filter((row) => row.date >= filter.from && row.date <= filter.to);
        return rows.map(clonePayment);
      },
      async listXlsxByBusinessKeys(
        _keys: Parameters<Repositories["payments"]["listXlsxByBusinessKeys"]>[0],
      ) {
        throw new Error("not used in this test");
      },
      async get(id: number) {
        const row = payments.find((item) => item.id === id) ?? null;
        return row ? clonePayment(row) : null;
      },
      async insert(input: Parameters<Repositories["payments"]["insert"]>[0]) {
        const payment: Payment = {
          id: nextPaymentId,
          payee_id: input.payee_id,
          account_id: input.account_id,
          category_id: input.category_id ?? null,
          date: input.date,
          amount_cents: input.amount_cents,
          memo: input.memo ?? null,
          source: input.source,
          external_ref: input.external_ref ?? null,
          source_sheet: input.source_sheet ?? null,
          source_row: input.source_row ?? null,
          source_col: input.source_col ?? null,
          occurrence_index: input.occurrence_index ?? null,
          created_at: "2026-02-11 10:00:00",
        };
        nextPaymentId += 1;
        payments = [...payments, payment];
        return clonePayment(payment);
      },
      async update(id: number, patch: Parameters<Repositories["payments"]["update"]>[1]) {
        const index = payments.findIndex((item) => item.id === id);
        if (index < 0) return null;
        payments[index] = {
          ...payments[index],
          ...patch,
          category_id:
            patch.category_id === undefined ? payments[index].category_id : patch.category_id,
          memo: patch.memo === undefined ? payments[index].memo : patch.memo,
        };
        return clonePayment(payments[index]);
      },
      async delete(id: number) {
        const next = payments.filter((item) => item.id !== id);
        if (next.length === payments.length) return false;
        payments = next;
        return true;
      },
    },
    importLog: {} as Repositories["importLog"],
    ledger: {} as Repositories["ledger"],
    recurringBills: {} as Repositories["recurringBills"],
    async withTransaction<T>(work: (txRepos: Repositories) => Promise<T>): Promise<T> {
      return work(repos as Repositories);
    },
  };

  return repos as Repositories;
}

describe("PaymentsPage", () => {
  let fixtureDb: TestDb | null = null;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    fixtureDb?.close();
    fixtureDb = null;
    cleanup();
  });

  it("opens quick-add from keyboard and pre-fills payee defaults", async () => {
    const repos = createMockRepos();
    const user = userEvent.setup();
    render(<PaymentsPage repos={repos} />);

    await screen.findByRole("heading", { level: 1, name: "Payments" });
    await user.keyboard("n");

    const payeeSelect = await screen.findByLabelText("Payee");
    await waitFor(() => {
      expect((payeeSelect as HTMLSelectElement).value).toBe("1");
      expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("1");
      expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("1");
      expect((screen.getByLabelText("Date") as HTMLInputElement).value).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    await user.selectOptions(payeeSelect, "2");

    await waitFor(() => {
      expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("2");
      expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("2");
    });
  });

  it("shows explicit validation when amount is invalid", async () => {
    const repos = createMockRepos();
    const user = userEvent.setup();
    render(<PaymentsPage repos={repos} />);

    await screen.findByRole("heading", { level: 1, name: "Payments" });
    await user.click(screen.getByRole("button", { name: "Quick add (N)" }));

    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "abc");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Enter amount as currency (for example: 45.67).");
  });

  it("creates, edits, and deletes payments from list context without changing payee defaults", async () => {
    const repos = createMockRepos();
    const user = userEvent.setup();
    render(<PaymentsPage repos={repos} />);

    await screen.findByRole("heading", { level: 1, name: "Payments" });

    await user.click(screen.getByRole("button", { name: "Quick add (N)" }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "40.05");
    await user.type(screen.getByLabelText("Memo (optional)"), "new payment");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Payment saved.");

    const rowsAfterSave = screen.getAllByRole("row");
    const newRow =
      rowsAfterSave.find((row) => within(row).queryByText("new payment") !== null) ?? null;
    expect(newRow).toBeTruthy();

    await user.click(within(newRow as HTMLElement).getByRole("button", { name: "Edit" }));
    const amountField = await screen.findByLabelText("Amount");
    await user.clear(amountField);
    await user.type(amountField, "41.05");
    await user.click(screen.getByRole("button", { name: "Save payment" }));

    await screen.findByText("Payment updated.");
    expect(screen.getByText("41.05")).toBeTruthy();

    const rowsAfterEdit = screen.getAllByRole("row");
    const editedRow =
      rowsAfterEdit.find((row) => within(row).queryByText("new payment") !== null) ?? null;
    expect(editedRow).toBeTruthy();
    await user.click(within(editedRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await screen.findByText("Payment deleted.");
    await waitFor(() => {
      expect(screen.queryByText("new payment")).toBeNull();
    });

    const payee = await repos.payees.get(1);
    expect(payee?.default_account_id).toBe(1);
    expect(payee?.default_category_id).toBe(1);
  });

  it("persists keyboard-only quick-add with overridden fields using fixture-backed repos", async () => {
    fixtureDb = openTestDb();
    const checking = await fixtureDb.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const utilities = await fixtureDb.repos.categories.insert({ name: "Utilities" });
    const powerCo = await fixtureDb.repos.payees.insert({
      name: "Power Co",
      default_account_id: checking.id,
      default_category_id: utilities.id,
    });

    const user = userEvent.setup();
    render(<PaymentsPage repos={fixtureDb.repos} />);

    await screen.findByRole("heading", { level: 1, name: "Payments" });

    await user.keyboard("n");
    const payeeSelect = await screen.findByLabelText("Payee");
    await waitFor(() => {
      expect((payeeSelect as HTMLSelectElement).value).toBe(String(powerCo.id));
      expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe(
        String(checking.id),
      );
      expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe(
        String(utilities.id),
      );
      expect((screen.getByLabelText("Date") as HTMLInputElement).value).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    await user.keyboard("{Tab}");
    await user.keyboard("{Tab}");
    await user.keyboard("{Tab}");
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await user.keyboard("2026-04-18");
    await user.keyboard("{Tab}");
    await user.keyboard("45.67");
    await user.keyboard("{Tab}");
    await user.keyboard("keyboard override memo");
    await user.keyboard("{Tab}");
    await user.keyboard("{Enter}");

    await screen.findByText("Payment saved.");

    const persisted = await fixtureDb.repos.payments.list({ from: "2026-04-01", to: "2026-04-30" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      payee_id: powerCo.id,
      account_id: checking.id,
      category_id: utilities.id,
      date: "2026-04-18",
      amount_cents: 4567,
      memo: "keyboard override memo",
      source: "manual",
    });

    const payeeAfter = await fixtureDb.repos.payees.get(powerCo.id);
    expect(payeeAfter?.default_account_id).toBe(checking.id);
    expect(payeeAfter?.default_category_id).toBe(utilities.id);
  });

  it("proves known-payee quick-add stays keyboard-only within <=5 field actions plus one amount entry", async () => {
    fixtureDb = openTestDb();
    const checking = await fixtureDb.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const rewards = await fixtureDb.repos.accounts.insert({ name: "Rewards Card", kind: "credit" });
    const utilities = await fixtureDb.repos.categories.insert({ name: "Utilities" });
    const groceries = await fixtureDb.repos.categories.insert({ name: "Groceries" });

    await fixtureDb.repos.payees.insert({
      name: "Power Co",
      default_account_id: checking.id,
      default_category_id: utilities.id,
    });

    const grocer = await fixtureDb.repos.payees.insert({
      name: "Grocer",
      default_account_id: rewards.id,
      default_category_id: groceries.id,
    });

    const user = userEvent.setup();
    render(<PaymentsPage repos={fixtureDb.repos} />);

    await screen.findByRole("heading", { level: 1, name: "Payments" });

    let fieldActions = 0;
    let amountEntryActions = 0;

    fieldActions += 1;
    await user.keyboard("n");

    const payeeSelect = await screen.findByLabelText("Payee");

    await waitFor(() => {
      expect(document.activeElement).toBe(payeeSelect);
    });

    fieldActions += 1;
    await user.keyboard("{ArrowDown}");

    const accountSelect = screen.getByLabelText("Account") as HTMLSelectElement;
    const categorySelect = screen.getByLabelText("Category") as HTMLSelectElement;
    const dateInput = screen.getByLabelText("Date") as HTMLInputElement;
    const amountInput = screen.getByLabelText("Amount") as HTMLInputElement;

    fieldActions += 1;
    await waitFor(() => {
      expect((payeeSelect as HTMLSelectElement).value).toBe(String(grocer.id));
      expect(accountSelect.value).toBe(String(rewards.id));
      expect(categorySelect.value).toBe(String(groceries.id));
      expect(dateInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    fieldActions += 1;
    await user.keyboard("{Tab}{Tab}{Tab}{Tab}");
    expect(document.activeElement).toBe(amountInput);

    amountEntryActions += 1;
    await user.keyboard("12.34");

    fieldActions += 1;
    await user.keyboard("{Tab}{Tab}{Enter}");

    await screen.findByText("Payment saved.");

    expect(fieldActions).toBeLessThanOrEqual(5);
    expect(amountEntryActions).toBe(1);

    const persisted = await fixtureDb.repos.payments.list({ from: "2026-01-01", to: "2026-12-31" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      payee_id: grocer.id,
      account_id: rewards.id,
      category_id: groceries.id,
      amount_cents: 1234,
      source: "manual",
    });
    expect(persisted[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("edits and deletes from list context with deterministic fixture-backed persistence", async () => {
    fixtureDb = openTestDb();
    const checking = await fixtureDb.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const power = await fixtureDb.repos.categories.insert({ name: "Power" });
    const payee = await fixtureDb.repos.payees.insert({
      name: "Power Co",
      default_account_id: checking.id,
      default_category_id: power.id,
    });
    const seeded = await fixtureDb.repos.payments.insert({
      payee_id: payee.id,
      account_id: checking.id,
      category_id: power.id,
      date: "2026-06-05",
      amount_cents: 4005,
      memo: "before edit",
      source: "manual",
    });

    const user = userEvent.setup();
    render(<PaymentsPage repos={fixtureDb.repos} />);

    await screen.findByRole("heading", { level: 1, name: "Payments" });
    const paymentRow = (await screen.findByText("before edit")).closest("tr");
    expect(paymentRow).not.toBeNull();

    await user.click(within(paymentRow as HTMLElement).getByRole("button", { name: "Edit" }));
    const amountField = await screen.findByLabelText("Amount");
    await user.clear(amountField);
    await user.type(amountField, "41.05");
    await user.clear(screen.getByLabelText("Memo (optional)"));
    await user.type(screen.getByLabelText("Memo (optional)"), "after edit");
    await user.click(screen.getByRole("button", { name: "Save payment" }));

    await screen.findByText("Payment updated.");

    const updated = await fixtureDb.repos.payments.get(seeded.id);
    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({
      id: seeded.id,
      amount_cents: 4105,
      memo: "after edit",
      date: "2026-06-05",
      payee_id: payee.id,
      account_id: checking.id,
      category_id: power.id,
      source: "manual",
    });

    const editedRow = (await screen.findByText("after edit")).closest("tr");
    expect(editedRow).not.toBeNull();
    await user.click(within(editedRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await screen.findByText("Payment deleted.");
    expect(await fixtureDb.repos.payments.get(seeded.id)).toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("after edit")).toBeNull();
    });
  });
});
