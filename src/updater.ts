import { getVersion } from "@tauri-apps/api/app";
import { relaunch as processRelaunch } from "@tauri-apps/plugin-process";
import {
  check as updaterCheck,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";

export type CheckForUpdateResult =
  | { status: "available"; version: string; notes: string; date: string }
  | { status: "up-to-date" }
  | { status: "error"; kind: UpdateErrorKind; message: string };

export type UpdateErrorKind = "offline" | "unknown";

export type DownloadProgress = {
  downloaded: number;
  total: number | null;
};

export type DownloadAndInstallResult =
  | { status: "installed" }
  | { status: "error"; kind: UpdateErrorKind; message: string };

export type RelaunchResult =
  | { status: "ok" }
  | { status: "error"; message: string };

export interface UpdaterDeps {
  check: typeof updaterCheck;
  relaunch: typeof processRelaunch;
  getVersion: typeof getVersion;
}

const defaultDeps: UpdaterDeps = {
  check: updaterCheck,
  relaunch: processRelaunch,
  getVersion,
};

function classifyError(error: unknown): UpdateErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    error instanceof TypeError ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("offline") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "offline";
  }
  return "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIsoDate(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    return "";
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return raw;
  }
  return new Date(parsed).toISOString();
}

function trackDownloadProgress(
  onProgress: (progress: DownloadProgress) => void,
): (event: DownloadEvent) => void {
  let downloaded = 0;
  let total: number | null = null;

  return (event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      downloaded = 0;
      onProgress({ downloaded, total });
      return;
    }
    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ downloaded, total });
      return;
    }
    if (event.event === "Finished") {
      onProgress({ downloaded, total });
    }
  };
}

/** Read the installed application version from the Tauri app API. */
export async function getAppVersion(deps: UpdaterDeps = defaultDeps): Promise<string> {
  return deps.getVersion();
}

/** Check whether a newer version is available; never throws to callers. */
export async function checkForUpdate(
  deps: UpdaterDeps = defaultDeps,
): Promise<CheckForUpdateResult> {
  try {
    const update = await deps.check();
    if (update === null) {
      return { status: "up-to-date" };
    }
    return {
      status: "available",
      version: update.version,
      notes: update.body ?? "",
      date: toIsoDate(update.date),
    };
  } catch (error) {
    return {
      status: "error",
      kind: classifyError(error),
      message: errorMessage(error),
    };
  }
}

/** Download and install the available update, reporting byte progress. */
export async function downloadAndInstall(
  onProgress: (progress: DownloadProgress) => void,
  deps: UpdaterDeps = defaultDeps,
): Promise<DownloadAndInstallResult> {
  try {
    const update = await deps.check();
    if (update === null) {
      return {
        status: "error",
        kind: "unknown",
        message: "No update is available to download.",
      };
    }

    await update.downloadAndInstall(trackDownloadProgress(onProgress), undefined);
    return { status: "installed" };
  } catch (error) {
    return {
      status: "error",
      kind: classifyError(error),
      message: errorMessage(error),
    };
  }
}

/** Relaunch the app after an update has been installed. */
export async function relaunch(deps: UpdaterDeps = defaultDeps): Promise<RelaunchResult> {
  try {
    await deps.relaunch();
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      message: errorMessage(error),
    };
  }
}
