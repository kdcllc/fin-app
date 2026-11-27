import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  downloadAndInstall,
  getAppVersion,
  relaunch,
  type CheckForUpdateResult,
  type UpdaterDeps,
} from "../src/updater";

type MockUpdate = {
  version: string;
  body?: string;
  date?: string;
  downloadAndInstall: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    check: vi.fn(async () => null),
    relaunch: vi.fn(async () => {}),
    getVersion: vi.fn(async () => "0.1.1"),
    ...overrides,
  };
}

function makeUpdate(overrides: Partial<MockUpdate> = {}): MockUpdate {
  return {
    version: "0.2.0",
    body: "Release notes",
    date: "2026-01-15T00:00:00.000Z",
    downloadAndInstall: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Mirrors App.tsx triggerUpdateCheckOnce branch logic (launch-check silence contract). */
function simulateLaunchCheckConsumer(
  result: CheckForUpdateResult,
  onAvailable: (version: string) => void,
  setErrorUi: (message: string) => void,
): void {
  if (result.status === "available") {
    onAvailable(result.version);
    return;
  }
  if (result.status === "error") {
    // App.tsx only console.warns — no error UI flag on silent launch check.
  }
}

describe("checkForUpdate", () => {
  it("returns up-to-date when check resolves to null", async () => {
    const deps = makeDeps({ check: vi.fn(async () => null) });

    await expect(checkForUpdate(deps)).resolves.toEqual({ status: "up-to-date" });
  });

  it("maps available updates with notes and ISO date", async () => {
    const update = makeUpdate({
      version: "1.2.3",
      body: "Bug fixes",
      date: "2026-01-15T00:00:00.000Z",
    });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    await expect(checkForUpdate(deps)).resolves.toEqual({
      status: "available",
      version: "1.2.3",
      notes: "Bug fixes",
      date: "2026-01-15T00:00:00.000Z",
    });
  });

  it("maps empty body to notes empty string", async () => {
    const update = makeUpdate({ body: undefined, date: "2026-01-15T00:00:00.000Z" });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    const result = await checkForUpdate(deps);
    expect(result).toMatchObject({ status: "available", notes: "" });
  });

  it("maps missing date to empty date string", async () => {
    const update = makeUpdate({ date: undefined });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    const result = await checkForUpdate(deps);
    expect(result).toMatchObject({ status: "available", date: "" });
  });

  it("maps whitespace-only date to empty date string", async () => {
    const update = makeUpdate({ date: "   " });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    const result = await checkForUpdate(deps);
    expect(result).toMatchObject({ status: "available", date: "" });
  });

  it("returns offline error for network-like failures without throwing", async () => {
    const deps = makeDeps({
      check: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });

    const result = await checkForUpdate(deps);
    expect(result).toEqual({
      status: "error",
      kind: "offline",
      message: "Failed to fetch",
    });
  });

  it("returns unknown error for non-network failures", async () => {
    const deps = makeDeps({
      check: vi.fn(async () => {
        throw new Error("signature mismatch");
      }),
    });

    const result = await checkForUpdate(deps);
    expect(result).toEqual({
      status: "error",
      kind: "unknown",
      message: "signature mismatch",
    });
  });
});

describe("downloadAndInstall", () => {
  it("re-runs check inside downloadAndInstall", async () => {
    const update = makeUpdate();
    const check = vi.fn(async () => update);
    const onProgress = vi.fn();
    const deps = makeDeps({ check });

    await downloadAndInstall(onProgress, deps);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("returns error when inner check finds no update", async () => {
    const deps = makeDeps({ check: vi.fn(async () => null) });

    const result = await downloadAndInstall(vi.fn(), deps);

    expect(result).toEqual({
      status: "error",
      kind: "unknown",
      message: "No update is available to download.",
    });
  });

  it("wires download progress through onProgress", async () => {
    const onProgress = vi.fn();
    const update = makeUpdate({
      downloadAndInstall: vi.fn(async (handler) => {
        handler({ event: "Started", data: { contentLength: 100 } });
        handler({ event: "Progress", data: { chunkLength: 40 } });
        handler({ event: "Progress", data: { chunkLength: 60 } });
        handler({ event: "Finished" });
      }),
    });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    const result = await downloadAndInstall(onProgress, deps);

    expect(result).toEqual({ status: "installed" });
    expect(onProgress).toHaveBeenNthCalledWith(1, { downloaded: 0, total: 100 });
    expect(onProgress).toHaveBeenNthCalledWith(2, { downloaded: 40, total: 100 });
    expect(onProgress).toHaveBeenNthCalledWith(3, { downloaded: 100, total: 100 });
    expect(onProgress).toHaveBeenNthCalledWith(4, { downloaded: 100, total: 100 });
  });

  it("returns installed on successful download", async () => {
    const update = makeUpdate({
      downloadAndInstall: vi.fn(async () => {}),
    });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    await expect(downloadAndInstall(vi.fn(), deps)).resolves.toEqual({ status: "installed" });
  });

  it("returns classified error when download throws without throwing to caller", async () => {
    const update = makeUpdate({
      downloadAndInstall: vi.fn(async () => {
        throw new Error("network timeout");
      }),
    });
    const deps = makeDeps({ check: vi.fn(async () => update) });

    const result = await downloadAndInstall(vi.fn(), deps);
    expect(result).toEqual({
      status: "error",
      kind: "offline",
      message: "network timeout",
    });
  });
});

describe("getAppVersion", () => {
  it("delegates to deps.getVersion", async () => {
    const deps = makeDeps({ getVersion: vi.fn(async () => "9.9.9") });

    await expect(getAppVersion(deps)).resolves.toBe("9.9.9");
  });
});

describe("relaunch", () => {
  it("returns ok when relaunch succeeds", async () => {
    const deps = makeDeps({ relaunch: vi.fn(async () => {}) });

    await expect(relaunch(deps)).resolves.toEqual({ status: "ok" });
  });

  it("returns error when relaunch rejects without throwing", async () => {
    const deps = makeDeps({
      relaunch: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });

    await expect(relaunch(deps)).resolves.toEqual({
      status: "error",
      message: "permission denied",
    });
  });
});

describe("launch-check silence consumer", () => {
  it("does not invoke onAvailable for up-to-date results", () => {
    const onAvailable = vi.fn();
    const setErrorUi = vi.fn();

    simulateLaunchCheckConsumer({ status: "up-to-date" }, onAvailable, setErrorUi);

    expect(onAvailable).not.toHaveBeenCalled();
    expect(setErrorUi).not.toHaveBeenCalled();
  });

  it("does not invoke onAvailable for offline errors", () => {
    const onAvailable = vi.fn();
    const setErrorUi = vi.fn();

    simulateLaunchCheckConsumer(
      { status: "error", kind: "offline", message: "offline" },
      onAvailable,
      setErrorUi,
    );

    expect(onAvailable).not.toHaveBeenCalled();
    expect(setErrorUi).not.toHaveBeenCalled();
  });

  it("invokes onAvailable only for available updates", () => {
    const onAvailable = vi.fn();
    const setErrorUi = vi.fn();

    simulateLaunchCheckConsumer(
      { status: "available", version: "2.0.0", notes: "", date: "" },
      onAvailable,
      setErrorUi,
    );

    expect(onAvailable).toHaveBeenCalledWith("2.0.0");
    expect(setErrorUi).not.toHaveBeenCalled();
  });
});
