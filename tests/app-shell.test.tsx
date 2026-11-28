// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppSettings } from "../src/settings";
import type { Database, LedgerAccount, Repositories } from "../src/core";

const revealItemInDirMock = vi.fn(async () => {});
const reposStub: Repositories = {
  accounts: {} as Repositories["accounts"],
  categories: {} as Repositories["categories"],
  importLog: {} as Repositories["importLog"],
  ledger: {
    listAccounts: vi.fn(async () => []),
    sumSplitsByAccount: vi.fn(async () => []),
  } as unknown as Repositories["ledger"],
  payees: {
    list: vi.fn(async () => []),
  } as Repositories["payees"],
  payments: {
    list: vi.fn(async () => []),
  } as Repositories["payments"],
  recurringBills: {
    list: vi.fn(async () => []),
    listSuggestionDismissals: vi.fn(async () => []),
  } as Repositories["recurringBills"],
  batch: vi.fn(async () => []),
  withTransaction: vi.fn(async (work: (repos: Repositories) => Promise<unknown>) =>
    work(reposStub),
  ),
};
const dbStub = {} as Database;
const openBookMock = vi.fn(async () => ({ db: dbStub, repos: reposStub }));
const dialogOpenMock = vi.fn(async () => null as string | null);
const appConfigDirMock = vi.fn(async () => "/home/test/.config/fin-app/");
const joinPathMock = vi.fn(async (a: string, b: string) => `${a}/${b}`);

let persistedSettings: AppSettings;

const loadSettingsMock = vi.fn(async () => ({
  ...persistedSettings,
  backups: { ...persistedSettings.backups },
}));

const updateSettingsMock = vi.fn(async (patch: Partial<AppSettings>) => {
  persistedSettings = {
    ...persistedSettings,
    ...patch,
    backups: patch.backups ?? persistedSettings.backups,
  };
  return {
    ...persistedSettings,
    backups: { ...persistedSettings.backups },
  };
});

vi.mock("../src/book", () => ({
  BOOK_FILE_NAME: "fin-app.db",
  openBook: (path: string) => openBookMock(path),
}));

vi.mock("../src/backup", () => ({
  backupNow: vi.fn(async () => ({
    fileName: "fin-app-20260101.db",
    path: "/tmp/fin-app/backups/fin-app-20260101.db",
    createdAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: 4096,
  })),
  listBackups: vi.fn(async () => []),
  restoreBackup: vi.fn(async () => {}),
  runScheduledBackupIfDue: vi.fn(async () => ({ status: "skipped", reason: "disabled" })),
}));

vi.mock("../src/settings", () => ({
  DEFAULT_BACKUPS: {
    enabled: true,
    retention: 20,
    intervalDays: 7,
    lastBackupAt: null,
  },
  loadSettings: () => loadSettingsMock(),
  updateSettings: (patch: Partial<AppSettings>) => updateSettingsMock(patch),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (options: unknown) => dialogOpenMock(options),
}));

vi.mock("@tauri-apps/api/path", () => ({
  appConfigDir: () => appConfigDirMock(),
  join: (a: string, b: string) => joinPathMock(a, b),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (path: string) => revealItemInDirMock(path),
}));

vi.mock("../src/pages/PaymentsPage", () => ({
  PaymentsPage: () => (
    <section className="page">
      <h1>Payments</h1>
      <button type="button">Quick add (N)</button>
    </section>
  ),
}));

vi.mock("../src/pages/ReportsPage", () => ({
  ReportsPage: () => (
    <section className="page">
      <h1>Reports</h1>
    </section>
  ),
}));

import App from "../src/App";

describe("app shell acceptance behavior", () => {
  beforeEach(() => {
    persistedSettings = {
      bookPath: "/tmp/fin-app/fin-app.db",
      defaultYear: null,
      backups: {
        enabled: false,
        retention: 20,
        intervalDays: 7,
        lastBackupAt: null,
      },
    };
    revealItemInDirMock.mockClear();
    openBookMock.mockClear();
    dialogOpenMock.mockClear();
    appConfigDirMock.mockClear();
    joinPathMock.mockClear();
    loadSettingsMock.mockClear();
    updateSettingsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("navigates between feature pages", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    await user.click(screen.getByRole("button", { name: "Reports" }));
    await screen.findByRole("heading", { level: 1, name: "Reports" });

    await user.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("heading", { level: 1, name: "Import" });
  });

  it("navigates to the accounts page", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    const labels = screen.getAllByRole("navigation")[0].querySelectorAll("button");
    expect(
      Array.from(labels)
        .map((b) => b.textContent)
        .slice(0, 2),
    ).toEqual(["Dashboard", "Accounts"]);

    await user.click(screen.getByRole("button", { name: "Accounts" }));
    await screen.findByRole("heading", { level: 1, name: "Accounts" });
    expect(screen.getByText("Your account tree and balances.")).toBeTruthy();
  });

  it("lists Register right after Accounts and shows its page", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    const labels = screen.getAllByRole("navigation")[0].querySelectorAll("button");
    expect(
      Array.from(labels)
        .map((b) => b.textContent)
        .slice(0, 3),
    ).toEqual(["Dashboard", "Accounts", "Register"]);

    await user.click(screen.getByRole("button", { name: "Register" }));
    await screen.findByRole("heading", { level: 1, name: "Register" });
    expect(screen.getByText("Account register with running balance.")).toBeTruthy();
  });

  describe("Accounts to Register navigation", () => {
    const ledgerStub = reposStub.ledger as unknown as Record<string, unknown>;
    const account = (
      patch: Partial<LedgerAccount> & { id: number; name: string },
    ): LedgerAccount => ({
      type: "ASSET",
      subtype: null,
      parent_id: null,
      placeholder: false,
      system_role: null,
      last4: null,
      gnucash_guid: null,
      archived: false,
      ...patch,
    });
    const assets = account({ id: 1, name: "Assets", placeholder: true, system_role: "root_asset" });
    const checking = account({ id: 2, name: "Checking Z", parent_id: 1, subtype: "bank" });
    const savings = account({ id: 3, name: "Savings Z", parent_id: 1, subtype: "savings" });
    const originalList = ledgerStub.listAccounts;

    beforeEach(() => {
      const all = [assets, checking, savings];
      ledgerStub.listAccounts = vi.fn(async () => all);
      ledgerStub.getAccount = vi.fn(async (id: number) => all.find((a) => a.id === id) ?? null);
      ledgerStub.listSplitsForAccount = vi.fn(async () => []);
    });
    afterEach(() => {
      ledgerStub.listAccounts = originalList;
      delete ledgerStub.getAccount;
      delete ledgerStub.listSplitsForAccount;
    });

    async function openAccounts(user: ReturnType<typeof userEvent.setup>) {
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Dashboard" });
      await user.click(screen.getByRole("button", { name: "Accounts" }));
      await screen.findByRole("heading", { level: 1, name: "Accounts" });
    }

    it("opens the clicked account's register with that account selected", async () => {
      const user = userEvent.setup();
      await openAccounts(user);

      await user.click(await screen.findByRole("button", { name: "Savings Z" }));
      await screen.findByRole("heading", { level: 1, name: "Register" });
      const select = (await screen.findByLabelText("Register account")) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe("3"));
    });

    it("falls back to the first funding account when a placeholder row is clicked", async () => {
      const user = userEvent.setup();
      await openAccounts(user);

      await user.click(await screen.findByRole("button", { name: "Assets" }));
      await screen.findByRole("heading", { level: 1, name: "Register" });
      const select = (await screen.findByLabelText("Register account")) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe("2"));
    });
  });

  it("navigates to payments page", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    await user.click(screen.getByRole("button", { name: "Payments" }));
    await screen.findByRole("heading", { level: 1, name: "Payments" });
    expect(screen.getByRole("button", { name: "Quick add (N)" })).toBeTruthy();
  });

  it("first run prompts for a book location, persists the chosen path, and opens the book", async () => {
    persistedSettings.bookPath = null;
    dialogOpenMock.mockResolvedValueOnce("/home/test/Documents");

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Welcome to fin-app" });

    await user.click(screen.getByRole("button", { name: "Choose a folder…" }));

    await waitFor(() => {
      expect(dialogOpenMock).toHaveBeenCalledWith({
        directory: true,
        title: "Choose a folder for your book",
      });
    });

    await waitFor(() => {
      expect(joinPathMock).toHaveBeenCalledWith("/home/test/Documents", "fin-app.db");
      expect(updateSettingsMock).toHaveBeenCalledWith({
        bookPath: "/home/test/Documents/fin-app.db",
      });
      expect(openBookMock).toHaveBeenCalledWith("/home/test/Documents/fin-app.db");
    });

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
  });

  it("subsequent runs open the configured book path without showing first-run prompt", async () => {
    persistedSettings.bookPath = "/tmp/fin-app/existing.db";

    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    await waitFor(() => {
      expect(openBookMock).toHaveBeenCalledWith("/tmp/fin-app/existing.db");
    });
    expect(screen.queryByRole("heading", { level: 1, name: "Welcome to fin-app" })).toBeNull();
  });

  it("dispatches open-book-folder to opener with the configured book path", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    await user.click(screen.getByRole("button", { name: "Open book folder" }));

    await waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith("/tmp/fin-app/fin-app.db");
    });
  });

  it("persists settings changes across app restart", async () => {
    const user = userEvent.setup();
    const firstSession = render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    const yearField = screen.getByLabelText("Default year") as HTMLInputElement;
    await user.clear(yearField);
    await user.type(yearField, "2031");

    const backupsField = screen.getByRole("checkbox", {
      name: "Enable automatic backups",
    }) as HTMLInputElement;
    await user.click(backupsField);

    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalled();
      expect(persistedSettings.defaultYear).toBe(2031);
      expect(persistedSettings.backups.enabled).toBe(true);
      expect(persistedSettings.backups.retention).toBe(20);
      expect(persistedSettings.backups.intervalDays).toBe(7);
    });

    firstSession.unmount();

    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    const restartedYearField = screen.getByLabelText("Default year") as HTMLInputElement;
    const restartedBackupsField = screen.getByRole("checkbox", {
      name: "Enable automatic backups",
    }) as HTMLInputElement;

    await waitFor(() => {
      expect(restartedYearField.value).toBe("2031");
      expect(restartedBackupsField.checked).toBe(true);
    });
  });
});
