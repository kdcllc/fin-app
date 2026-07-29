// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppSettings } from "../src/settings";
import type { Repositories } from "../src/core";

const revealItemInDirMock = vi.fn(async () => {});
const reposStub: Repositories = {
  accounts: {} as Repositories["accounts"],
  categories: {} as Repositories["categories"],
  importLog: {} as Repositories["importLog"],
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
  withTransaction: vi.fn(async (work: (repos: Repositories) => Promise<unknown>) => work(reposStub)),
};
const openBookMock = vi.fn(async () => reposStub as never);
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

vi.mock("../src/settings", () => ({
  DEFAULT_BACKUPS: { enabled: false },
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

import App from "../src/App";

describe("app shell acceptance behavior", () => {
  beforeEach(() => {
    persistedSettings = {
      bookPath: "/tmp/fin-app/fin-app.db",
      defaultYear: null,
      backups: { enabled: false },
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

  it("navigates between placeholder pages", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    await user.click(screen.getByRole("button", { name: "Reports" }));
    await screen.findByRole("heading", { level: 1, name: "Reports" });

    await user.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("heading", { level: 1, name: "Import" });
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
      name: "Automatic backups (placeholder — arrives in a later milestone)",
    }) as HTMLInputElement;
    await user.click(backupsField);

    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalled();
      expect(persistedSettings.defaultYear).toBe(2031);
      expect(persistedSettings.backups.enabled).toBe(true);
    });

    firstSession.unmount();

    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    const restartedYearField = screen.getByLabelText("Default year") as HTMLInputElement;
    const restartedBackupsField = screen.getByRole("checkbox", {
      name: "Automatic backups (placeholder — arrives in a later milestone)",
    }) as HTMLInputElement;

    await waitFor(() => {
      expect(restartedYearField.value).toBe("2031");
      expect(restartedBackupsField.checked).toBe(true);
    });
  });
});