import { describe, expect, it, vi } from "vitest";
import { DatabaseLockedError } from "../../src/core";
import { withDatabaseLockedRetry } from "../../src/core/adapters/locked-retry";

describe("withDatabaseLockedRetry", () => {
  it("retries lock contention and eventually succeeds", async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    const result = await withDatabaseLockedRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return "ok";
      },
      {
        delaysMs: [1, 2, 3],
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1, 2]);
  });

  it("stops retrying after the final attempt and throws DatabaseLockedError", async () => {
    const sleep = vi.fn(async () => undefined);

    await expect(
      withDatabaseLockedRetry(
        async () => {
          throw new Error("SQLITE_LOCKED: database table is locked");
        },
        {
          delaysMs: [1, 2],
          sleep,
        },
      ),
    ).rejects.toBeInstanceOf(DatabaseLockedError);

    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-lock errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const work = vi.fn(async () => {
      throw new Error("no such table: payments");
    });

    await expect(withDatabaseLockedRetry(work, { delaysMs: [1, 2], sleep })).rejects.toThrow(
      /no such table/i,
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
