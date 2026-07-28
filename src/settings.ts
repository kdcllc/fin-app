/**
 * Typed access to persisted app settings, backed by `tauri-plugin-store`
 * (`settings.json` in the app data dir, e.g.
 * `~/.local/share/com.kdcllc.finapp/` on Linux). Settings survive restart;
 * the store file is created on first save.
 */
import { LazyStore } from "@tauri-apps/plugin-store";

/** Placeholder — automatic backups arrive in a later milestone. */
export interface BackupPreferences {
  enabled: boolean;
}

export interface AppSettings {
  /** Absolute path to the SQLite book file; null until first run completes. */
  bookPath: string | null;
  /** Year the bills grid opens on; null means the current year. */
  defaultYear: number | null;
  /** Backup preferences (placeholder for a later milestone). */
  backups: BackupPreferences;
}

export const DEFAULT_BACKUPS: BackupPreferences = { enabled: false };

const store = new LazyStore("settings.json");

export async function loadSettings(): Promise<AppSettings> {
  const [bookPath, defaultYear, backups] = await Promise.all([
    store.get<string>("bookPath"),
    store.get<number>("defaultYear"),
    store.get<BackupPreferences>("backups"),
  ]);
  return {
    bookPath: bookPath ?? null,
    defaultYear: defaultYear ?? null,
    backups: backups ?? { ...DEFAULT_BACKUPS },
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
