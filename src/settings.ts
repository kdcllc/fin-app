/**
 * Typed access to persisted app settings, backed by `tauri-plugin-store`
 * (`settings.json` in the app data dir, e.g.
 * `~/.local/share/com.kdcllc.finapp/` on Linux). Settings survive restart;
 * the store file is created on first save.
 */
import { LazyStore } from "@tauri-apps/plugin-store";

export interface BackupPreferences {
  enabled: boolean;
  retention: number;
  intervalDays: number;
  lastBackupAt: string | null;
}

export interface AppSettings {
  /** Absolute path to the SQLite book file; null until first run completes. */
  bookPath: string | null;
  /** Year the bills grid opens on; null means the current year. */
  defaultYear: number | null;
  backups: BackupPreferences;
}

export const DEFAULT_BACKUPS: BackupPreferences = {
  enabled: true,
  retention: 20,
  intervalDays: 7,
  lastBackupAt: null,
};

const store = new LazyStore("settings.json");

/** Merge persisted backup fields with defaults; tolerates legacy `{ enabled }`-only stores. */
export function normalizeBackups(
  stored: Partial<BackupPreferences> | null | undefined,
): BackupPreferences {
  if (stored == null) {
    return { ...DEFAULT_BACKUPS };
  }
  return {
    enabled: stored.enabled ?? DEFAULT_BACKUPS.enabled,
    retention: stored.retention ?? DEFAULT_BACKUPS.retention,
    intervalDays: stored.intervalDays ?? DEFAULT_BACKUPS.intervalDays,
    lastBackupAt: stored.lastBackupAt ?? DEFAULT_BACKUPS.lastBackupAt,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const [bookPath, defaultYear, backups] = await Promise.all([
    store.get<string>("bookPath"),
    store.get<number>("defaultYear"),
    store.get<Partial<BackupPreferences>>("backups"),
  ]);
  return {
    bookPath: bookPath ?? null,
    defaultYear: defaultYear ?? null,
    backups: normalizeBackups(backups),
  };
}

/** Persist the given fields (null clears a field) and return fresh settings. */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (patch.bookPath !== undefined) {
    await setOrClear("bookPath", patch.bookPath);
  }
  if (patch.defaultYear !== undefined) {
    await setOrClear("defaultYear", patch.defaultYear);
  }
  if (patch.backups !== undefined) {
    await store.set("backups", patch.backups);
  }
  await store.save();
  return loadSettings();
}

async function setOrClear(key: string, value: string | number | null): Promise<void> {
  if (value === null) {
    await store.delete(key);
  } else {
    await store.set(key, value);
  }
}
