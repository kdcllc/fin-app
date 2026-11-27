import { invoke } from "@tauri-apps/api/core";
import { updateSettings, type AppSettings } from "./settings";

export interface BackupInfo {
  fileName: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

/** Invoke Rust backup creation; `retention` is the max backups to keep (≥ 1). */
export async function backupNow(retention: number): Promise<BackupInfo> {
  return invoke<BackupInfo>("backup_now", { retention });
}

/** List backups for the open book session, newest first. */
export async function listBackups(): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups");
}

/** Restore the open book from a backup file under the book's `backups/` folder. */
export async function restoreBackup(backupPath: string): Promise<void> {
  return invoke<void>("restore_backup", { backupPath });
}

const MS_PER_DAY = 86_400_000;

/** True when no prior backup exists or the interval has elapsed (UTC whole-day math). */
export function isBackupDue(
  lastBackupAt: string | null,
  intervalDays: number,
  nowMs: number = Date.now(),
): boolean {
  if (lastBackupAt === null) {
    return true;
  }
  const lastMs = Date.parse(lastBackupAt);
  if (Number.isNaN(lastMs)) {
    return true;
  }
  return nowMs - lastMs >= intervalDays * MS_PER_DAY;
}

export type ScheduledBackupOutcome =
  | { status: "skipped"; reason: "disabled" }
  | { status: "skipped"; reason: "not_due" }
  | { status: "ran"; backup: BackupInfo }
  | { status: "failed"; error: string };

export interface ScheduledBackupDeps {
  backupNow: (retention: number) => Promise<BackupInfo>;
  updateSettings: typeof updateSettings;
  now?: () => number;
}

const defaultDeps: ScheduledBackupDeps = {
  backupNow,
  updateSettings,
};

/** Run a scheduled backup when enabled and due; never throws to callers. */
export async function runScheduledBackupIfDue(
  settings: AppSettings,
  deps: ScheduledBackupDeps = defaultDeps,
): Promise<ScheduledBackupOutcome> {
  if (!settings.backups.enabled) {
    return { status: "skipped", reason: "disabled" };
  }
  const nowMs = deps.now?.() ?? Date.now();
  if (!isBackupDue(settings.backups.lastBackupAt, settings.backups.intervalDays, nowMs)) {
    return { status: "skipped", reason: "not_due" };
  }
  try {
    const backup = await deps.backupNow(settings.backups.retention);
    const lastBackupAt = new Date(nowMs).toISOString();
    await deps.updateSettings({
      backups: { ...settings.backups, lastBackupAt },
    });
    return { status: "ran", backup };
  } catch (e) {
    return {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
