import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

const storeMocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(),
  set: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  delete: vi.fn<(key: string) => Promise<void>>(),
  save: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn(function LazyStoreMock() {
    return storeMocks;
  }),
}));

import {
  backupNow,
  isBackupDue,
  listBackups,
  restoreBackup,
  runScheduledBackupIfDue,
  type BackupInfo,
} from "../src/backup";
import {
  DEFAULT_BACKUPS,
  loadSettings,
  normalizeBackups,
  updateSettings,
  type AppSettings,
} from "../src/settings";

const SAMPLE_BACKUP: BackupInfo = {
  fileName: "fin-app-20260101.db",
  path: "/tmp/fin-app/backups/fin-app-20260101.db",
  createdAt: "2026-01-01T00:00:00.000Z",
  sizeBytes: 4096,
};

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    bookPath: "/tmp/fin-app/fin-app.db",
    defaultYear: null,
    backups: { ...DEFAULT_BACKUPS },
    ...overrides,
  };
}

describe("normalizeBackups", () => {
  it("returns DEFAULT_BACKUPS for null", () => {
    expect(normalizeBackups(null)).toEqual(DEFAULT_BACKUPS);
  });

  it("returns DEFAULT_BACKUPS for undefined", () => {
    expect(normalizeBackups(undefined)).toEqual(DEFAULT_BACKUPS);
  });

  it("merges legacy enabled-only store shape with defaults", () => {
    expect(normalizeBackups({ enabled: false })).toEqual({
      enabled: false,
      retention: 20,
      intervalDays: 7,
      lastBackupAt: null,
    });
  });

  it("keeps defaults for missing keys on partial overrides", () => {
    expect(normalizeBackups({ enabled: true, retention: 5 })).toEqual({
      enabled: true,
      retention: 5,
      intervalDays: 7,
      lastBackupAt: null,
    });
  });
});

describe("loadSettings", () => {
  beforeEach(() => {
    storeMocks.get.mockReset();
    storeMocks.set.mockReset();
    storeMocks.delete.mockReset();
    storeMocks.save.mockReset();
  });

  it("merges partial persisted backups with defaults", async () => {
    storeMocks.get.mockImplementation(async (key: string) => {
      if (key === "bookPath") return "/tmp/book.db";
      if (key === "defaultYear") return null;
      if (key === "backups") return { enabled: true };
      return null;
    });

    const settings = await loadSettings();

    expect(settings.backups).toEqual({
      enabled: true,
      retention: 20,
      intervalDays: 7,
      lastBackupAt: null,
    });
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    storeMocks.get.mockReset();
    storeMocks.set.mockReset();
    storeMocks.delete.mockReset();
    storeMocks.save.mockReset();
    storeMocks.get.mockResolvedValue(null);
  });

  it("persists backup patches and reloads settings", async () => {
    storeMocks.get.mockImplementation(async (key: string) => {
      if (key === "backups") {
        return { enabled: true, retention: 5, intervalDays: 7, lastBackupAt: null };
      }
      return null;
    });

    const result = await updateSettings({
      backups: { enabled: true, retention: 5, intervalDays: 7, lastBackupAt: null },
    });

    expect(storeMocks.set).toHaveBeenCalledWith("backups", {
      enabled: true,
      retention: 5,
      intervalDays: 7,
      lastBackupAt: null,
    });
    expect(storeMocks.save).toHaveBeenCalled();
    expect(result.backups.retention).toBe(5);
  });

  it("persists bookPath patches", async () => {
    storeMocks.get.mockResolvedValue(null);

    await updateSettings({ bookPath: "/tmp/new-book.db" });

    expect(storeMocks.set).toHaveBeenCalledWith("bookPath", "/tmp/new-book.db");
    expect(storeMocks.save).toHaveBeenCalled();
  });
});

describe("isBackupDue", () => {
  const intervalDays = 7;
  const lastBackupAt = "2026-01-01T00:00:00.000Z";
  const lastMs = Date.parse(lastBackupAt);
  const boundaryMs = lastMs + intervalDays * 86_400_000;

  it("returns true when lastBackupAt is null", () => {
    expect(isBackupDue(null, intervalDays, boundaryMs)).toBe(true);
  });

  it("returns true exactly at the interval boundary", () => {
    expect(isBackupDue(lastBackupAt, intervalDays, boundaryMs)).toBe(true);
  });

  it("returns false one millisecond before the boundary", () => {
    expect(isBackupDue(lastBackupAt, intervalDays, boundaryMs - 1)).toBe(false);
  });

  it("returns false when the interval has not elapsed", () => {
    expect(isBackupDue(lastBackupAt, intervalDays, lastMs + 86_400_000)).toBe(false);
  });
});

describe("runScheduledBackupIfDue", () => {
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");

  it("skips when backups are disabled without calling backupNow", async () => {
    const backupNowDep = vi.fn();
    const updateSettingsDep = vi.fn();

    const outcome = await runScheduledBackupIfDue(
      baseSettings({ backups: { ...DEFAULT_BACKUPS, enabled: false } }),
      { backupNow: backupNowDep, updateSettings: updateSettingsDep, now: () => nowMs },
    );

    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(backupNowDep).not.toHaveBeenCalled();
  });

  it("runs backup when due with null lastBackupAt and updates settings", async () => {
    const backupNowDep = vi.fn(async () => SAMPLE_BACKUP);
    const updateSettingsDep = vi.fn(async () => baseSettings());

    const settings = baseSettings({
      backups: { ...DEFAULT_BACKUPS, retention: 12, lastBackupAt: null },
    });

    const outcome = await runScheduledBackupIfDue(settings, {
      backupNow: backupNowDep,
      updateSettings: updateSettingsDep,
      now: () => nowMs,
    });

    expect(backupNowDep).toHaveBeenCalledWith(12);
    expect(updateSettingsDep).toHaveBeenCalledWith({
      backups: {
        ...settings.backups,
        lastBackupAt: new Date(nowMs).toISOString(),
      },
    });
    expect(outcome).toEqual({ status: "ran", backup: SAMPLE_BACKUP });
  });

  it("skips when not due without calling backupNow", async () => {
    const backupNowDep = vi.fn();
    const updateSettingsDep = vi.fn();
    const recentBackupAt = new Date(nowMs - 86_400_000).toISOString();

    const outcome = await runScheduledBackupIfDue(
      baseSettings({
        backups: { ...DEFAULT_BACKUPS, lastBackupAt: recentBackupAt },
      }),
      { backupNow: backupNowDep, updateSettings: updateSettingsDep, now: () => nowMs },
    );

    expect(outcome).toEqual({ status: "skipped", reason: "not_due" });
    expect(backupNowDep).not.toHaveBeenCalled();
  });

  it("returns failed outcome when backupNow rejects without throwing", async () => {
    const backupNowDep = vi.fn(async () => {
      throw new Error("disk full");
    });
    const updateSettingsDep = vi.fn();

    const outcome = await runScheduledBackupIfDue(baseSettings(), {
      backupNow: backupNowDep,
      updateSettings: updateSettingsDep,
      now: () => nowMs,
    });

    expect(outcome).toEqual({ status: "failed", error: "disk full" });
    expect(updateSettingsDep).not.toHaveBeenCalled();
  });
});

describe("invoke wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("backupNow invokes backup_now with retention payload", async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_BACKUP);

    const result = await backupNow(15);

    expect(invokeMock).toHaveBeenCalledWith("backup_now", { retention: 15 });
    expect(result).toEqual(SAMPLE_BACKUP);
  });

  it("restoreBackup invokes restore_backup with backupPath", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const backupPath = "/tmp/fin-app/backups/fin-app-20260101.db";

    await restoreBackup(backupPath);

    expect(invokeMock).toHaveBeenCalledWith("restore_backup", { backupPath });
  });

  it("listBackups invokes list_backups with no extra args", async () => {
    const listed = [SAMPLE_BACKUP];
    invokeMock.mockResolvedValueOnce(listed);

    const result = await listBackups();

    expect(invokeMock).toHaveBeenCalledWith("list_backups");
    expect(result).toEqual(listed);
  });
});
