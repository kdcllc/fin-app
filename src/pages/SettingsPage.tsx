/**
 * Settings page: book location (with "Open book folder"), default year, and
 * backup preferences. All values persist via the settings store and survive
 * restart.
 */
import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  backupNow,
  listBackups,
  restoreBackup,
  type BackupInfo,
} from "../backup";
import {
  checkForUpdate,
  downloadAndInstall,
  getAppVersion,
  relaunch,
  type CheckForUpdateResult,
  type DownloadProgress,
} from "../updater";
import type { AppSettings, BackupPreferences } from "../settings";

interface SettingsPageProps {
  settings: AppSettings;
  /** Persist a partial settings update. */
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
  /** True while import commit or backup restore is in progress. */
  appBusy?: boolean;
  /** Optional hook for app-level busy-guard during backup restore. */
  onBusyChange?: (busy: boolean) => void;
}

function backupsFolderPath(bookPath: string | null): string | null {
  if (bookPath === null) {
    return null;
  }
  const lastSlash = Math.max(bookPath.lastIndexOf("/"), bookPath.lastIndexOf("\\"));
  if (lastSlash === -1) {
    return null;
  }
  const sep = bookPath.includes("\\") ? "\\" : "/";
  return `${bookPath.slice(0, lastSlash)}${sep}backups`;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatBackupTime(iso: string | null): string {
  if (iso === null) {
    return "Never";
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleString();
}

function mergeBackups(
  current: BackupPreferences,
  patch: Partial<BackupPreferences>,
): BackupPreferences {
  return { ...current, ...patch };
}

function formatUpdateDate(iso: string): string {
  if (iso.trim().length === 0) {
    return "Unknown date";
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleString();
}

export function SettingsPage({
  settings,
  onUpdate,
  appBusy = false,
  onBusyChange,
}: SettingsPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("…");
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<CheckForUpdateResult | null>(
    null,
  );
  const [updateDownloadBusy, setUpdateDownloadBusy] = useState(false);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<DownloadProgress | null>(
    null,
  );
  const [updateInstalled, setUpdateInstalled] = useState(false);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);
  const [relaunchBusy, setRelaunchBusy] = useState(false);

  const folderPath = backupsFolderPath(settings.bookPath);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const refreshBackupList = useCallback(async () => {
    if (settings.bookPath === null) {
      setBackups([]);
      return;
    }
    setBackupsLoading(true);
    try {
      const listed = await listBackups();
      setBackups(listed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupsLoading(false);
    }
  }, [settings.bookPath]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void refreshBackupList();
    }, 0);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [refreshBackupList]);

  useEffect(() => {
    let cancelled = false;
    void getAppVersion()
      .then((version) => {
        if (!cancelled) {
          setCurrentVersion(version);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setCurrentVersion("Unknown");
          console.warn("Could not read app version:", e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCheckForUpdates() {
    setUpdateActionError(null);
    setUpdateCheckResult(null);
    setUpdateInstalled(false);
    setUpdateDownloadProgress(null);
    setUpdateCheckBusy(true);
    try {
      const result = await checkForUpdate();
      setUpdateCheckResult(result);
      if (result.status === "error") {
        setUpdateActionError(result.message);
      }
    } finally {
      setUpdateCheckBusy(false);
    }
  }

  async function handleDownloadAndInstall() {
    setUpdateActionError(null);
    setUpdateDownloadBusy(true);
    setUpdateDownloadProgress({ downloaded: 0, total: null });
    try {
      const result = await downloadAndInstall((progress) => {
        setUpdateDownloadProgress(progress);
      });
      if (result.status === "installed") {
        setUpdateInstalled(true);
        return;
      }
      setUpdateActionError(result.message);
    } finally {
      setUpdateDownloadBusy(false);
    }
  }

  async function handleRelaunch() {
    setUpdateActionError(null);
    setRelaunchBusy(true);
    try {
      const result = await relaunch();
      if (result.status === "error") {
        setUpdateActionError(result.message);
      }
    } finally {
      setRelaunchBusy(false);
    }
  }

  async function handleBackupNow() {
    setBackupMessage(null);
    setError(null);
    setBackupBusy(true);
    try {
      const info = await backupNow(settings.backups.retention);
      await onUpdate({
        backups: mergeBackups(settings.backups, { lastBackupAt: info.createdAt }),
      });
      setBackupMessage(`Backed up ${info.fileName}`);
      await refreshBackupList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreConfirm() {
    if (restoreTarget === null) {
      return;
    }
    setRestoreError(null);
    setRestoreBusy(true);
    onBusyChange?.(true);
    try {
      await restoreBackup(restoreTarget.path);
      window.location.reload();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
      setRestoreBusy(false);
      onBusyChange?.(false);
    }
  }

  function handleRestoreCancel() {
    if (restoreBusy) {
      return;
    }
    setRestoreTarget(null);
    setRestoreError(null);
  }

  return (
    <section className="page">
      <h1>Settings</h1>

      <h2>Book</h2>
      <p>
        Location: <code>{settings.bookPath ?? "(not set)"}</code>
      </p>
      <button
        type="button"
        disabled={settings.bookPath === null}
        onClick={() =>
          run(async () => {
            if (settings.bookPath !== null) {
              await revealItemInDir(settings.bookPath);
            }
          })
        }
      >
        Open book folder
      </button>

      <h2>Defaults</h2>
      <label className="field">
        Default year
        <input
          type="number"
          inputMode="numeric"
          placeholder="current year"
          value={settings.defaultYear ?? ""}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            const year = raw === "" ? null : Number.parseInt(raw, 10);
            if (year === null || Number.isInteger(year)) {
              void run(() => onUpdate({ defaultYear: year }));
            }
          }}
        />
      </label>

      <h2>Backups</h2>
      <p>
        Folder:{" "}
        {folderPath !== null ? (
          <code>{folderPath}</code>
        ) : (
          <span className="muted">(set a book location first)</span>
        )}
      </p>

      <label className="field checkbox">
        <input
          type="checkbox"
          checked={settings.backups.enabled}
          onChange={(e) => {
            const enabled = e.currentTarget.checked;
            void run(() =>
              onUpdate({ backups: mergeBackups(settings.backups, { enabled }) }),
            );
          }}
        />
        Enable automatic backups
      </label>

      <label className="field">
        Retention (max backups)
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={settings.backups.retention}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isInteger(parsed) || parsed < 1) {
              return;
            }
            void run(() =>
              onUpdate({ backups: mergeBackups(settings.backups, { retention: parsed }) }),
            );
          }}
        />
      </label>

      <label className="field">
        Backup interval (days)
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={settings.backups.intervalDays}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isInteger(parsed) || parsed < 1) {
              return;
            }
            void run(() =>
              onUpdate({
                backups: mergeBackups(settings.backups, { intervalDays: parsed }),
              }),
            );
          }}
        />
      </label>

      <p>
        Last backup: <span>{formatBackupTime(settings.backups.lastBackupAt)}</span>
      </p>

      <button type="button" disabled={backupBusy || settings.bookPath === null} onClick={() => void handleBackupNow()}>
        {backupBusy ? "Backing up…" : "Back up now"}
      </button>
      {backupMessage !== null && <p className="muted">{backupMessage}</p>}

      <h3>Available backups</h3>
      {backupsLoading ? (
        <p className="muted">Loading backups…</p>
      ) : backups.length === 0 ? (
        <p className="muted">No backups yet.</p>
      ) : (
        <ul>
          {backups.map((backup) => (
            <li key={backup.path}>
              <code>{backup.fileName}</code> — {formatBackupTime(backup.createdAt)} —{" "}
              {formatBytes(backup.sizeBytes)}{" "}
              <button
                type="button"
                disabled={restoreBusy || restoreTarget !== null}
                onClick={() => {
                  setRestoreError(null);
                  setRestoreTarget(backup);
                }}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}

      {restoreTarget !== null && (
        <div>
          <p>
            Restore <code>{restoreTarget.fileName}</code>? The current book will be replaced after
            a safety backup is taken first.
          </p>
          <button type="button" disabled={restoreBusy} onClick={() => void handleRestoreConfirm()}>
            {restoreBusy ? "Restoring…" : "Confirm restore"}
          </button>{" "}
          <button type="button" disabled={restoreBusy} onClick={handleRestoreCancel}>
            Cancel
          </button>
          {restoreError !== null && <p className="error">{restoreError}</p>}
        </div>
      )}

      {error !== null && <p className="error">{error}</p>}

      <h2>Updates</h2>
      <p>
        Current version: <code>{currentVersion}</code>
      </p>

      <button
        type="button"
        disabled={updateCheckBusy || updateDownloadBusy}
        onClick={() => void handleCheckForUpdates()}
      >
        {updateCheckBusy ? "Checking…" : "Check for updates"}
      </button>

      {updateCheckResult?.status === "up-to-date" && (
        <p className="muted">You&apos;re up to date.</p>
      )}

      {updateCheckResult?.status === "available" && !updateInstalled && (
        <div>
          <p>
            Version <strong>{updateCheckResult.version}</strong> is available (
            {formatUpdateDate(updateCheckResult.date)}).
          </p>
          {updateCheckResult.notes.trim().length > 0 && (
            <pre className="muted">{updateCheckResult.notes}</pre>
          )}
          <button
            type="button"
            className="primary"
            disabled={updateDownloadBusy || updateCheckBusy}
            onClick={() => void handleDownloadAndInstall()}
          >
            {updateDownloadBusy ? "Downloading…" : "Download and install"}
          </button>
        </div>
      )}

      {updateDownloadBusy && updateDownloadProgress !== null && (
        <div className="field">
          <label htmlFor="update-download-progress">Download progress</label>
          {updateDownloadProgress.total !== null && updateDownloadProgress.total > 0 ? (
            <progress
              id="update-download-progress"
              value={updateDownloadProgress.downloaded}
              max={updateDownloadProgress.total}
            />
          ) : (
            <progress id="update-download-progress" />
          )}
        </div>
      )}

      {updateInstalled && (
        <div>
          <p className="muted">Update installed. Restart the app to finish.</p>
          {appBusy ? (
            <p className="error">Finish current work first, then restart to apply the update.</p>
          ) : (
            <button type="button" disabled={relaunchBusy} onClick={() => void handleRelaunch()}>
              {relaunchBusy ? "Restarting…" : "Restart now"}
            </button>
          )}
        </div>
      )}

      {updateActionError !== null && <p className="error">{updateActionError}</p>}
    </section>
  );
}
