// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EntityInUseError,
  PayeeMergeError,
  type Account,
  type Category,
  type Payee,
  type Repositories,
} from "../src/core";
import { EntityManagementPage } from "../src/pages/EntityManagementPage";

interface MockConfig {
  blockedAccountDeleteIds?: number[];
  mergeFailureMessage?: string;
}

function cloneAccount(account: Account): Account {
  return { ...account };
}

function clonePayee(payee: Payee): Payee {
  return { ...payee };
}

function cloneCategory(category: Category): Category {
  return { ...category };
}

function createMockRepos(config: MockConfig = {}): Repositories {
  let accounts: Account[] = [
    {
      id: 1,
      name: "Checking",
      kind: "checking",
      last4: "1111",
      gnucash_guid: null,
      archived: false,
    },
    {
      id: 2,
      name: "Cash Wallet",
      kind: "cash",
      last4: null,
      gnucash_guid: null,
      archived: false,
    },
  ];

  let categories: Category[] = [
    { id: 1, name: "Utilities", parent_id: null, gnucash_guid: null, archived: false },
    { id: 2, name: "Groceries", parent_id: null, gnucash_guid: null, archived: false },
  ];

  let payees: Payee[] = [
    {
      id: 1,
      name: "Acme Power",
      default_account_id: 1,
      default_category_id: 1,
      notes: null,
      archived: false,
    },
    {
      id: 2,
      name: "ACME Power LLC",
      default_account_id: 1,
      default_category_id: 1,
      notes: "legacy duplicate",
      archived: false,
    },
  ];

  let nextAccountId = 3;
  const blockedDeleteIds = new Set(config.blockedAccountDeleteIds ?? []);

  const repos = {
    accounts: {
      async list(options?: { includeArchived?: boolean }) {
        const includeArchived = options?.includeArchived ?? false;
        const rows = includeArchived ? accounts : accounts.filter((row) => !row.archived);
        return rows.map(cloneAccount);
      },
      async get(id: number) {
        const match = accounts.find((row) => row.id === id) ?? null;
        return match ? cloneAccount(match) : null;
      },
      async insert(input) {
        const account: Account = {
          id: nextAccountId,
          name: input.name,
          kind: input.kind,
          last4: input.last4 ?? null,
          gnucash_guid: input.gnucash_guid ?? null,
          archived: false,
        };
        nextAccountId += 1;
        accounts = [...accounts, account];
        return cloneAccount(account);
      },
      async update(id: number, patch) {
        const index = accounts.findIndex((row) => row.id === id);
        if (index < 0) return null;
        accounts[index] = {
          ...accounts[index],
          ...patch,
          last4: patch.last4 === undefined ? accounts[index].last4 : patch.last4,
        };
        return cloneAccount(accounts[index]);
      },
      async archive(id: number) {
        const index = accounts.findIndex((row) => row.id === id);
        if (index < 0) return false;
        accounts[index] = { ...accounts[index], archived: true };
        return true;
      },
      async delete(id: number) {
        if (blockedDeleteIds.has(id)) {
          throw new EntityInUseError(
            "Cannot delete this account because payment history references it. Archive the account instead.",
          );
        }
        const next = accounts.filter((row) => row.id !== id);
        if (next.length === accounts.length) return false;
        accounts = next;
        return true;
      },
    },
    categories: {
      async list(options?: { includeArchived?: boolean }) {
        const includeArchived = options?.includeArchived ?? false;
        const rows = includeArchived ? categories : categories.filter((row) => !row.archived);
        return rows.map(cloneCategory);
      },
      async get(id: number) {
        const match = categories.find((row) => row.id === id) ?? null;
        return match ? cloneCategory(match) : null;
      },
      async insert(input) {
        const nextId = Math.max(0, ...categories.map((row) => row.id)) + 1;
        const category: Category = {
          id: nextId,
          name: input.name,
          parent_id: input.parent_id ?? null,
          gnucash_guid: input.gnucash_guid ?? null,
          archived: false,
        };
        categories = [...categories, category];
        return cloneCategory(category);
      },
      async update(id: number, patch) {
        const index = categories.findIndex((row) => row.id === id);
        if (index < 0) return null;
        categories[index] = {
          ...categories[index],
          ...patch,
          parent_id: patch.parent_id === undefined ? categories[index].parent_id : patch.parent_id,
        };
        return cloneCategory(categories[index]);
      },
      async archive(id: number) {
        const index = categories.findIndex((row) => row.id === id);
        if (index < 0) return false;
        categories[index] = { ...categories[index], archived: true };
        return true;
      },
      async delete(id: number) {
        const next = categories.filter((row) => row.id !== id);
        if (next.length === categories.length) return false;
        categories = next;
        return true;
      },
    },
    payees: {
      async list(options?: { includeArchived?: boolean }) {
        const includeArchived = options?.includeArchived ?? false;
        const rows = includeArchived ? payees : payees.filter((row) => !row.archived);
        return rows.map(clonePayee);
      },
      async get(id: number) {
        const match = payees.find((row) => row.id === id) ?? null;
        return match ? clonePayee(match) : null;
      },
      async insert(input) {
        const nextId = Math.max(0, ...payees.map((row) => row.id)) + 1;
        const payee: Payee = {
          id: nextId,
          name: input.name,
          default_account_id: input.default_account_id ?? null,
          default_category_id: input.default_category_id ?? null,
          notes: input.notes ?? null,
          archived: false,
        };
        payees = [...payees, payee];
        return clonePayee(payee);
      },
      async update(id: number, patch) {
        const index = payees.findIndex((row) => row.id === id);
        if (index < 0) return null;
        payees[index] = {
          ...payees[index],
          ...patch,
          default_account_id:
            patch.default_account_id === undefined
              ? payees[index].default_account_id
              : patch.default_account_id,
          default_category_id:
            patch.default_category_id === undefined
              ? payees[index].default_category_id
              : patch.default_category_id,
          notes: patch.notes === undefined ? payees[index].notes : patch.notes,
        };
        return clonePayee(payees[index]);
      },
      async archive(id: number) {
        const index = payees.findIndex((row) => row.id === id);
        if (index < 0) return false;
        payees[index] = { ...payees[index], archived: true };
        return true;
      },
      async delete(id: number) {
        const next = payees.filter((row) => row.id !== id);
        if (next.length === payees.length) return false;
        payees = next;
        return true;
      },
      async merge(survivorId: number, sourceId: number) {
        if (config.mergeFailureMessage) {
          throw new PayeeMergeError(config.mergeFailureMessage);
        }

        if (survivorId === sourceId) {
          throw new PayeeMergeError("Cannot merge a payee into itself.");
        }

        const sourceIndex = payees.findIndex((row) => row.id === sourceId);
        if (sourceIndex < 0) {
          throw new PayeeMergeError("Cannot merge payees: source payee was not found.");
        }

        payees[sourceIndex] = { ...payees[sourceIndex], archived: true };
        return { reassignedPayments: 2 };
      },
    },
    importLog: {} as Repositories["importLog"],
    payments: {} as Repositories["payments"],
    recurringBills: {} as Repositories["recurringBills"],
    async withTransaction<T>(work: (txRepos: Repositories) => Promise<T>): Promise<T> {
      return work(repos as Repositories);
    },
  };

  return repos as Repositories;
}

function findSectionByHeading(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name });
  const section = heading.closest("section");
  if (!section) throw new Error(`Section not found for heading: ${name}`);
  return section;
}

function findRowInSection(section: HTMLElement, text: string): HTMLElement {
  const rows = within(section).getAllByRole("row");
  const row = rows.find((candidate) => within(candidate).queryByText(text, { selector: "td" }) !== null) ?? null;
  if (!row) throw new Error(`Could not locate row with text: ${text}`);
  return row;
}

describe("EntityManagementPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("supports create/edit flow for accounts", async () => {
    const user = userEvent.setup();
    render(<EntityManagementPage repos={createMockRepos()} />);

    await screen.findByRole("heading", { level: 1, name: "Manage Entities" });

    const accountsSection = findSectionByHeading("Accounts");
    await user.type(within(accountsSection).getByLabelText("Name"), "Travel Card");
    await user.selectOptions(within(accountsSection).getByLabelText("Kind"), "credit");
    await user.type(within(accountsSection).getByLabelText("Last 4 (optional)"), "1111");
    await user.click(within(accountsSection).getByRole("button", { name: "Create account" }));

    await screen.findByText("Account created.");

    const accountRow = findRowInSection(accountsSection, "Travel Card");
    expect(within(accountRow).getByText("credit")).toBeTruthy();

    await user.click(within(accountRow).getByRole("button", { name: "Edit" }));
    const last4Input = within(accountsSection).getByLabelText("Last 4 (optional)") as HTMLInputElement;
    await user.clear(last4Input);
    await user.type(last4Input, "2222");
    await user.click(within(accountsSection).getByRole("button", { name: "Save account" }));

    await screen.findByText("Account updated.");

    await user.click(within(findRowInSection(accountsSection, "Travel Card")).getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect((within(accountsSection).getByLabelText("Last 4 (optional)") as HTMLInputElement).value).toBe("2222");
    });
  });

  it("archives an account and hides it from the default account picker", async () => {
    const user = userEvent.setup();
    render(<EntityManagementPage repos={createMockRepos()} />);

    await screen.findByRole("heading", { level: 1, name: "Manage Entities" });

    const payeesSection = findSectionByHeading("Payees");
    const defaultAccountSelect = within(payeesSection).getByLabelText("Default account");
    expect(within(defaultAccountSelect).getByRole("option", { name: "Cash Wallet" })).toBeTruthy();

    const accountsSection = findSectionByHeading("Accounts");
    const accountRow = findRowInSection(accountsSection, "Cash Wallet");
    await user.click(within(accountRow).getByRole("button", { name: "Archive" }));

    await screen.findByText("Account archived.");
    expect(within(findRowInSection(accountsSection, "Cash Wallet")).getByText("Archived")).toBeTruthy();

    await waitFor(() => {
      const refreshedSelect = within(findSectionByHeading("Payees")).getByLabelText("Default account");
      expect(within(refreshedSelect).queryByRole("option", { name: "Cash Wallet" })).toBeNull();
    });
  });

  it("shows user-facing delete-blocked error when account delete throws EntityInUseError", async () => {
    const user = userEvent.setup();
    render(
      <EntityManagementPage repos={createMockRepos({ blockedAccountDeleteIds: [1] })} />,
    );

    await screen.findByRole("heading", { level: 1, name: "Manage Entities" });

    const accountsSection = findSectionByHeading("Accounts");
    const accountRow = findRowInSection(accountsSection, "Checking");
    await user.click(within(accountRow).getByRole("button", { name: "Delete" }));

    await screen.findByText(
      "Cannot delete this account because payment history references it. Archive the account instead.",
    );
  });

  it("merges payees and archives the source payee", async () => {
    const user = userEvent.setup();
    render(<EntityManagementPage repos={createMockRepos()} />);

    await screen.findByRole("heading", { level: 1, name: "Manage Entities" });

    const payeesSection = findSectionByHeading("Payees");
    await user.selectOptions(within(payeesSection).getByLabelText("Survivor"), "1");
    await user.selectOptions(within(payeesSection).getByLabelText("Source to merge"), "2");
    await user.click(within(payeesSection).getByRole("button", { name: "Merge payees" }));

    await screen.findByText("Payees merged. Reassigned 2 payments and archived the source payee.");
    expect(within(findRowInSection(payeesSection, "ACME Power LLC")).getByText("Archived")).toBeTruthy();

    await waitFor(() => {
      const survivorSelect = within(findSectionByHeading("Payees")).getByLabelText("Survivor");
      const sourceSelect = within(findSectionByHeading("Payees")).getByLabelText("Source to merge");
      expect(within(survivorSelect).queryByRole("option", { name: "ACME Power LLC" })).toBeNull();
      expect(within(sourceSelect).queryByRole("option", { name: "ACME Power LLC" })).toBeNull();
    });
  });

  it("shows merge failure message when payee merge throws", async () => {
    const user = userEvent.setup();
    render(
      <EntityManagementPage
        repos={createMockRepos({ mergeFailureMessage: "Cannot merge into an archived payee." })}
      />,
    );

    await screen.findByRole("heading", { level: 1, name: "Manage Entities" });

    const payeesSection = findSectionByHeading("Payees");
    await user.selectOptions(within(payeesSection).getByLabelText("Survivor"), "1");
    await user.selectOptions(within(payeesSection).getByLabelText("Source to merge"), "2");
    await user.click(within(payeesSection).getByRole("button", { name: "Merge payees" }));

    await screen.findByText("Cannot merge into an archived payee.");
  });
});