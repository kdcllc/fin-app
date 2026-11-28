/**
 * Seam tests for the rust-sqlite adapter (`src/core/adapters/rust-sqlite.ts`)
 * with the Tauri `invoke` bridge mocked: what the adapter SENDS to the
 * backend and how backend failures come back out. Tauri rejects with the
 * serialized `BackendError` — a plain string — so these tests reject with
 * strings exactly like production.
 *
 * Pins the diagnosed Goal-02 failure modes at the adapter seam:
 * - per-row round-trip explosion: one `db_batch` invocation per batch call;
 * - silent error swallowing: rejected promises carry the SQLite message;
 * - transaction splitting: BEGIN/COMMIT/ROLLBACK protocol and the client-side
 *   queue that keeps concurrent callers out of an in-flight transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import type { BatchStatement, Database, ExecuteResult } from "../../src/core";
import { ForeignKeyViolationError } from "../../src/core";
import { openRustSqliteDatabase } from "../../src/core/adapters/rust-sqlite";

const BOOK_PATH = "/tmp/test-book.db";
const EXEC_RESULT: ExecuteResult = { lastInsertId: 1, rowsAffected: 1 };

function respondOk(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "open_book":
      return BOOK_PATH;
    case "db_execute":
      return EXEC_RESULT;
    case "db_select":
      return [];
    case "db_batch":
      return (args?.statements as BatchStatement[]).map((_, index) => ({
        lastInsertId: index + 1,
        rowsAffected: 1,
      }));
    default:
      throw new Error(`unexpected command: ${cmd}`);
  }
}

/** The SQL (or command name) of every invocation, in send order. */
function sentSql(): string[] {
  return invokeMock.mock.calls.map(
    ([cmd, args]) => ((args as { sql?: string } | undefined)?.sql ?? cmd) as string,
  );
}

async function openAdapter(): Promise<Database> {
  const db = await openRustSqliteDatabase(BOOK_PATH);
  invokeMock.mockClear();
  return db;
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd, args) => respondOk(cmd, args));
});

describe("rust-sqlite adapter seam", () => {
  it("opens the book via open_book before returning the adapter", async () => {
    await openRustSqliteDatabase(BOOK_PATH);
    expect(invokeMock).toHaveBeenCalledWith("open_book", { path: BOOK_PATH });
  });

  it("maps open_book rejections into Errors carrying the backend message", async () => {
    invokeMock.mockRejectedValue("book path must be absolute, got: relative/book.db");
    await expect(openRustSqliteDatabase("relative/book.db")).rejects.toThrow(
      /book path must be absolute/,
    );
  });

  it("sends an entire statement list as exactly one db_batch invocation", async () => {
    const db = await openAdapter();
    const statements: BatchStatement[] = [
      { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Water Co"] },
      {
        sql: "INSERT INTO accounts (name, type, subtype, parent_id) VALUES (?, 'ASSET', 'bank', 1)",
        params: ["Checking"],
      },
      {
        sql: "INSERT INTO import_log (source_file, content_hash, row_count) VALUES (?, ?, ?)",
        params: ["fixture.xlsx", "hash-1", 4858],
      },
    ];

    const results = await db.batch(statements);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("db_batch", { statements });
    expect(results).toEqual([
      { lastInsertId: 1, rowsAffected: 1 },
      { lastInsertId: 2, rowsAffected: 1 },
      { lastInsertId: 3, rowsAffected: 1 },
    ]);
  });

  describe("error propagation (the silent-swallowing failure mode)", () => {
    it("maps a FOREIGN KEY rejection to ForeignKeyViolationError with the message intact", async () => {
      const db = await openAdapter();
      invokeMock.mockRejectedValue("FOREIGN KEY constraint failed");

      const error = await db
        .execute("INSERT INTO payees (name, default_account_id) VALUES ('x', 999)")
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect((error as Error).message).toBe("FOREIGN KEY constraint failed");
    });

    it("preserves the batch statement index and SQLite message from db_batch failures", async () => {
      const db = await openAdapter();
      invokeMock.mockRejectedValue("batch statement 2 failed: FOREIGN KEY constraint failed");

      const error = await db
        .batch([{ sql: "INSERT INTO payees (name) VALUES (?)", params: ["x"] }])
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect((error as Error).message).toBe(
        "batch statement 2 failed: FOREIGN KEY constraint failed",
      );
    });

    it("surfaces non-FK SQLite messages verbatim on select rejections", async () => {
      const db = await openAdapter();
      invokeMock.mockRejectedValue("no such table: import_log");

      const error = await db
        .select("SELECT * FROM import_log")
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ForeignKeyViolationError);
      expect((error as Error).message).toBe("no such table: import_log");
    });

    it("retries a locked database and succeeds without surfacing the lock", async () => {
      const db = await openAdapter();
      let attempts = 0;
      invokeMock.mockImplementation(async (cmd, args) => {
        attempts += 1;
        if (attempts === 1) throw "database is locked";
        return respondOk(cmd, args);
      });

      await expect(db.execute("INSERT INTO payees (name) VALUES ('x')")).resolves.toEqual(
        EXEC_RESULT,
      );
      expect(attempts).toBe(2);
    });
  });

  describe("transaction protocol", () => {
    it("wraps work in BEGIN IMMEDIATE / COMMIT on the backend", async () => {
      const db = await openAdapter();

      const value = await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO payees (name) VALUES ('inside')");
        return 42;
      });

      expect(value).toBe(42);
      expect(sentSql()).toEqual([
        "BEGIN IMMEDIATE",
        "INSERT INTO payees (name) VALUES ('inside')",
        "COMMIT",
      ]);
    });

    it("issues ROLLBACK and propagates the original error when work throws", async () => {
      const db = await openAdapter();

      await expect(
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO payees (name) VALUES ('doomed')");
          throw new Error("injected work failure");
        }),
      ).rejects.toThrow(/injected work failure/);

      expect(sentSql()).toEqual([
        "BEGIN IMMEDIATE",
        "INSERT INTO payees (name) VALUES ('doomed')",
        "ROLLBACK",
      ]);
    });

    it("propagates a COMMIT failure instead of reporting phantom success", async () => {
      const db = await openAdapter();
      invokeMock.mockImplementation(async (cmd, args) => {
        if ((args as { sql?: string } | undefined)?.sql === "COMMIT") throw "disk I/O error";
        return respondOk(cmd, args);
      });

      await expect(
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO payees (name) VALUES ('x')");
        }),
      ).rejects.toThrow(/disk I\/O error/);
    });

    it("combines the errors when ROLLBACK itself fails, losing neither", async () => {
      const db = await openAdapter();
      invokeMock.mockImplementation(async (cmd, args) => {
        if ((args as { sql?: string } | undefined)?.sql === "ROLLBACK") {
          throw "cannot rollback - no transaction is active";
        }
        return respondOk(cmd, args);
      });

      const error = await db
        .transaction(async () => {
          throw new Error("original failure");
        })
        .then(() => null, (e: unknown) => e);

      expect((error as Error).message).toContain("original failure");
      expect((error as Error).message).toContain("ROLLBACK failed");
      expect((error as Error).message).toContain("cannot rollback - no transaction is active");
    });
  });

  describe("client-side serialization (the lock-stall / split-transaction failure mode)", () => {
    it("serializes non-transactional calls in submission order", async () => {
      const db = await openAdapter();
      let releaseFirst!: (value: ExecuteResult) => void;
      invokeMock.mockImplementationOnce(
        () => new Promise<unknown>((resolve) => (releaseFirst = resolve)),
      );

      const first = db.execute("INSERT 1");
      const second = db.execute("INSERT 2");
      await settle();
      expect(invokeMock).toHaveBeenCalledTimes(1);

      releaseFirst(EXEC_RESULT);
      await Promise.all([first, second]);
      expect(sentSql()).toEqual(["INSERT 1", "INSERT 2"]);
    });

    it("holds concurrent outside calls until an in-flight transaction completes", async () => {
      const db = await openAdapter();
      let releaseWork!: () => void;
      const gate = new Promise<void>((resolve) => (releaseWork = resolve));

      const tx = db.transaction(async (txDb) => {
        await txDb.execute("INSERT INTO payees (name) VALUES ('inside')");
        await gate;
      });
      await vi.waitFor(() =>
        expect(sentSql()).toContain("INSERT INTO payees (name) VALUES ('inside')"),
      );

      // An unrelated caller fires while the transaction is open. It must NOT
      // reach the backend yet — on the shared connection it would silently
      // join (and roll back with) the transaction.
      const outside = db.execute("INSERT INTO payees (name) VALUES ('outside')");
      await settle();
      expect(sentSql()).not.toContain("INSERT INTO payees (name) VALUES ('outside')");

      releaseWork();
      await Promise.all([tx, outside]);
      expect(sentSql()).toEqual([
        "BEGIN IMMEDIATE",
        "INSERT INTO payees (name) VALUES ('inside')",
        "COMMIT",
        "INSERT INTO payees (name) VALUES ('outside')",
      ]);
    });
  });
});
