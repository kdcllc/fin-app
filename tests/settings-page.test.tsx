// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppSettings } from "../src/settings";
import type { BackupInfo } from "../src/backup";

const backupNowMock = vi.fn<
  (retention: number) => Promise<BackupInfo>
>();
const listBackupsMock = vi.fn<() => Promise<BackupInfo[]>>();
const restoreBackupMock = vi.fn<(backupPath: string) => Promise<void>>();
const checkForUpdateMock = vi.fn();
const downloadAndInstallMock = vi.fn();
const getAppVersionMock = vi.fn(async () => "0.1.1");
const relaunchMock = vi.fn(async () => ({ status: "ok" as const }));
const revealItemInDirMock = vi.fn(async () => {});

vi.mock("../src/backup", () => ({
  backupNow: (retention: number) => backupNowMock(retention),
  listBackups: () => listBackupsMock(),
  restoreBackup: (backupPath: string) => restoreBackupMock(backupPath),
}));

vi.mock("../src/updater", () => ({
  checkForUpdate: () => checkForUpdateMock(),
  downloadAndInstall: (onProgress: (progress: { downloaded: number; total: number | null }) => void) =>
    downloadAndInstallMock(onProgress),
  getAppVersion: () => getAppVersionMock(),
  relaunch: () => relaunchMock(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (path: string) => revealItemInDirMock(path),
}));

import { SettingsPage } from "../src/pages/SettingsPage";

const SAMPLE_BACKUP: BackupInfo = {
  fileName: "fin-app-20260101.db",
  path: "/tmp/fin-app/backups/fin-app-20260101.db",
  createdAt: "2026-01-01T00:00:00.000Z",
  sizeBytes: 4096,
};

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const baseBackups = {
    enabled: true,
    retention: 20,
    intervalDays: 7,
    lastBackupAt: null as string | null,
  };
  return {
    bookPath: "/tmp/fin-app/fin-app.db",
    defaultYear: null,
    ...overrides,
    backups: { ...baseBackups, ...overrides.backups },
  };
}

describe("SettingsPage backups section", () => {
  let onUpdate: ReturnType<typeof vi.fn<(patch: Partial<AppSettings>) => Promise<void>>>;

  beforeEach(() => {
    onUpdate = vi.fn(async () => {});
    backupNowMock.mockReset();
    listBackupsMock.mockReset();
    restoreBackupMock.mockReset();
    checkForUpdateMock.mockReset();
    downloadAndInstallMock.mockReset();
    getAppVersionMock.mockReset();
    relaunchMock.mockReset();
    revealItemInDirMock.mockReset();

    backupNowMock.mockResolvedValue(SAMPLE_BACKUP);
    listBackupsMock.mockResolvedValue([]);
    getAppVersionMock.mockResolvedValue("0.1.1");
    checkForUpdateMock.mockResolvedValue({ status: "up-to-date" });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders backup folder, retention, and Never for last backup", async () => {
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await screen.findByText("/tmp/fin-app/backups");
    expect((screen.getByLabelText("Retention (max backups)") as HTMLInputElement).value).toBe(
      "20",
    );
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("shows muted placeholder when book path is unset", async () => {
    render(
      <SettingsPage
        settings={makeSettings({ bookPath: null })}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByText("(set a book location first)")).toBeTruthy();
    expect(screen.queryByText("/tmp/fin-app/backups")).toBeNull();
  });

  it("backs up now, persists lastBackupAt, and shows success message", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Back up now" }));

    await waitFor(() => {
      expect(backupNowMock).toHaveBeenCalledWith(20);
      expect(onUpdate).toHaveBeenCalledWith({
        backups: expect.objectContaining({
          lastBackupAt: SAMPLE_BACKUP.createdAt,
        }),
      });
      expect(screen.getByText(`Backed up ${SAMPLE_BACKUP.fileName}`)).toBeTruthy();
    });
  });

  it("shows backup error and does not persist lastBackupAt on failure", async () => {
    backupNowMock.mockRejectedValueOnce(new Error("disk full"));
    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Back up now" }));

    await waitFor(() => {
      expect(screen.getByText("disk full").className).toContain("error");
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("SettingsPage restore flow", () => {
  let onUpdate: ReturnType<typeof vi.fn<(patch: Partial<AppSettings>) => Promise<void>>>;
  let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onUpdate = vi.fn(async () => {});
    onBusyChange = vi.fn();
    reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: reloadMock },
    });

    backupNowMock.mockReset();
    listBackupsMock.mockReset();
    restoreBackupMock.mockReset();
    getAppVersionMock.mockReset();
    checkForUpdateMock.mockReset();

    backupNowMock.mockResolvedValue(SAMPLE_BACKUP);
    listBackupsMock.mockResolvedValue([SAMPLE_BACKUP]);
    getAppVersionMock.mockResolvedValue("0.1.1");
    checkForUpdateMock.mockResolvedValue({ status: "up-to-date" });
    restoreBackupMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens confirmation naming the selected backup file", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPage settings={makeSettings()} onUpdate={onUpdate} onBusyChange={onBusyChange} />,
    );

    await screen.findByText(SAMPLE_BACKUP.fileName);
    await user.click(screen.getByRole("button", { name: "Restore" }));

    const confirmRestore = screen.getByRole("button", { name: "Confirm restore" });
    const confirmSection = confirmRestore.closest("div");
    expect(confirmSection).not.toBeNull();
    expect(within(confirmSection!).getByText(SAMPLE_BACKUP.fileName)).toBeTruthy();
  });

  it("confirms restore with the selected backup path", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPage settings={makeSettings()} onUpdate={onUpdate} onBusyChange={onBusyChange} />,
    );

    await screen.findByText(SAMPLE_BACKUP.fileName);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => {
      expect(restoreBackupMock).toHaveBeenCalledWith(SAMPLE_BACKUP.path);
      expect(onBusyChange).toHaveBeenCalledWith(true);
    });
  });

  it("shows restore error, clears busy, and does not reload on failure", async () => {
    restoreBackupMock.mockRejectedValueOnce(new Error("restore failed"));
    const user = userEvent.setup();
    render(
      <SettingsPage settings={makeSettings()} onUpdate={onUpdate} onBusyChange={onBusyChange} />,
    );

    await screen.findByText(SAMPLE_BACKUP.fileName);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => {
      expect(screen.getByText("restore failed").className).toContain("error");
      expect(onBusyChange).toHaveBeenCalledWith(false);
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("cancel dismisses confirmation without restoring", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPage settings={makeSettings()} onUpdate={onUpdate} onBusyChange={onBusyChange} />,
    );

    await screen.findByText(SAMPLE_BACKUP.fileName);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm restore" })).toBeNull();
  });
});

describe("SettingsPage updates section", () => {
  let onUpdate: ReturnType<typeof vi.fn<(patch: Partial<AppSettings>) => Promise<void>>>;

  beforeEach(() => {
    onUpdate = vi.fn(async () => {});
    backupNowMock.mockReset();
    listBackupsMock.mockReset();
    checkForUpdateMock.mockReset();
    downloadAndInstallMock.mockReset();
    getAppVersionMock.mockReset();
    relaunchMock.mockReset();

    listBackupsMock.mockResolvedValue([]);
    getAppVersionMock.mockResolvedValue("0.1.1");
    checkForUpdateMock.mockResolvedValue({ status: "up-to-date" });
    downloadAndInstallMock.mockResolvedValue({ status: "installed" });
    relaunchMock.mockResolvedValue({ status: "ok" });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows current version and check button in idle state", async () => {
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await screen.findByText("0.1.1");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  });

  it("shows checking state while update check is pending", async () => {
    let resolveCheck!: (value: unknown) => void;
    checkForUpdateMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );

    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(screen.getByRole("button", { name: "Checking…" })).toBeTruthy();

    resolveCheck({ status: "up-to-date" });
    await waitFor(() => {
      expect(screen.getByText("You're up to date.")).toBeTruthy();
    });
  });

  it("shows up-to-date message after check", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByText("You're up to date.")).toBeTruthy();
    });
  });

  it("shows available update with notes and download button", async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      status: "available",
      version: "0.2.0",
      notes: "Important fixes",
      date: "2026-01-15T00:00:00.000Z",
    });

    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByText("0.2.0")).toBeTruthy();
      expect(screen.getByText("Important fixes")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download and install" })).toBeTruthy();
    });
  });

  it("shows download progress while installing", async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      status: "available",
      version: "0.2.0",
      notes: "Notes",
      date: "2026-01-15T00:00:00.000Z",
    });
    downloadAndInstallMock.mockImplementationOnce(async (onProgress) => {
      onProgress({ downloaded: 50, total: 100 });
      await new Promise(() => {});
      return { status: "installed" };
    });

    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Download and install" });
    await user.click(screen.getByRole("button", { name: "Download and install" }));

    await waitFor(() => {
      const progress = screen.getByLabelText("Download progress") as HTMLProgressElement;
      expect(progress.value).toBe(50);
      expect(progress.max).toBe(100);
    });
  });

  it("shows restart prompt after install when not busy", async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      status: "available",
      version: "0.2.0",
      notes: "",
      date: "",
    });

    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} appBusy={false} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Download and install" });
    await user.click(screen.getByRole("button", { name: "Download and install" }));

    await waitFor(() => {
      expect(screen.getByText("Update installed. Restart the app to finish.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
    });
  });

  it("shows check error inline", async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      status: "error",
      kind: "offline",
      message: "offline now",
    });

    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByText("offline now").className).toContain("error");
    });
  });

  it("shows download error inline", async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      status: "available",
      version: "0.2.0",
      notes: "",
      date: "",
    });
    downloadAndInstallMock.mockResolvedValueOnce({
      status: "error",
      kind: "unknown",
      message: "download failed",
    });

    const user = userEvent.setup();
    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Download and install" });
    await user.click(screen.getByRole("button", { name: "Download and install" }));

    await waitFor(() => {
      expect(screen.getByText("download failed").className).toContain("error");
    });
  });
});

describe("SettingsPage retention and busy-guard", () => {
  let onUpdate: ReturnType<typeof vi.fn<(patch: Partial<AppSettings>) => Promise<void>>>;

  beforeEach(() => {
    onUpdate = vi.fn(async () => {});
    listBackupsMock.mockResolvedValue([]);
    getAppVersionMock.mockResolvedValue("0.1.1");
    checkForUpdateMock.mockResolvedValue({ status: "up-to-date" });
    downloadAndInstallMock.mockResolvedValue({ status: "installed" });
    relaunchMock.mockResolvedValue({ status: "ok" });
  });

  afterEach(() => {
    cleanup();
  });

  it("persists retention edits through onUpdate", async () => {
    const { rerender } = render(
      <SettingsPage settings={makeSettings()} onUpdate={onUpdate} />,
    );

    const retentionField = screen.getByLabelText("Retention (max backups)") as HTMLInputElement;
    fireEvent.change(retentionField, { target: { value: "8" } });

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        backups: expect.objectContaining({ retention: 8 }),
      });
    });

    rerender(
      <SettingsPage
        settings={makeSettings({ backups: { enabled: true, retention: 8, intervalDays: 7, lastBackupAt: null } })}
        onUpdate={onUpdate}
      />,
    );

    expect((screen.getByLabelText("Retention (max backups)") as HTMLInputElement).value).toBe(
      "8",
    );
  });

  async function reachPostInstallState(user: ReturnType<typeof userEvent.setup>) {
    checkForUpdateMock.mockResolvedValueOnce({
      status: "available",
      version: "0.2.0",
      notes: "",
      date: "",
    });

    render(<SettingsPage settings={makeSettings()} onUpdate={onUpdate} appBusy={false} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Download and install" });
    await user.click(screen.getByRole("button", { name: "Download and install" }));

    await waitFor(() => {
      expect(screen.getByText("Update installed. Restart the app to finish.")).toBeTruthy();
    });
  }

  it("shows busy-guard instead of restart when appBusy is true", async () => {
    const user = userEvent.setup();
    const settings = makeSettings();

    checkForUpdateMock.mockResolvedValueOnce({
      status: "available",
      version: "0.2.0",
      notes: "",
      date: "",
    });

    const { rerender } = render(
      <SettingsPage settings={settings} onUpdate={onUpdate} appBusy={false} />,
    );

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Download and install" });
    await user.click(screen.getByRole("button", { name: "Download and install" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
    });

    rerender(<SettingsPage settings={settings} onUpdate={onUpdate} appBusy={true} />);

    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    expect(
      screen.getByText("Finish current work first, then restart to apply the update."),
    ).toBeTruthy();
  });

  it("calls relaunch when restart is clicked and app is not busy", async () => {
    const user = userEvent.setup();
    await reachPostInstallState(user);

    await user.click(screen.getByRole("button", { name: "Restart now" }));

    await waitFor(() => {
      expect(relaunchMock).toHaveBeenCalled();
    });
  });
});
