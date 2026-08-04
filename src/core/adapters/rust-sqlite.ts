/**
 * Adapter for the app-owned Rust SQLite backend (`src-tauri/src/db.rs`) —
 * the adapter the real app wires in (tests wire a better-sqlite3 adapter
 * instead; see `tests/support/test-db.ts`). Thin by design: translate the
 * call to the `db_select`/`db_execute`/`db_batch` commands, map the error,
 * nothing else.
 *
 * All statements for the book run on one Rust-side connection, so
 * `transaction()` issues real `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
 * statements. A client-side queue serializes calls made outside a
 * transaction so interleaved callers cannot split one. Commit and rollback
 * failures propagate — nothing is swallowed.
 */
import { invoke } from "@tauri-apps/api/core";
import type { BatchStatement, Database, ExecuteResult, SqlValue } from "../db";
import { mapSqliteError } from "../errors";
import { withDatabaseLockedRetry } from "./locked-retry";

/**
 * Open (creating and migrating if needed) the book at `bookPath` — an
 * absolute path to the SQLite file — and return the `Database` adapter over
 * it. The backend allows one book per session; a second path is rejected.
 */
export async function openRustSqliteDatabase(bookPath: string): Promise<Database> {
  try {
    await invoke<string>("open_book", { path: bookPath });
  } catch (error) {
    throw mapSqliteError(error);
  }

  let queue: Promise<void> = Promise.resolve();

  /**
   * Serialize calls made on the outer adapter so they cannot land inside an
   * in-flight transaction. A transaction occupies ONE queue slot; only the
   * `tx` handle passed to its work callback dispatches directly, so a
   * concurrent outer call can never join (and silently roll back with)
   * someone else's transaction on the shared connection.
   */
  function runSerialized<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function runDirect<T>(work: () => Promise<T>): Promise<T> {
    return withDatabaseLockedRetry(async () => {
      try {
        return await work();
      } catch (error) {
        throw mapSqliteError(error);
      }
    });
  }

  function directExecute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
    return runDirect(() => invoke<ExecuteResult>("db_execute", { sql, params }));
  }

  /** The Database handle the transaction work callback sees: dispatches
   * immediately (the transaction already owns the queue slot). */
  const txHandle: Database = {
    execute: directExecute,
    select: <T>(sql: string, params: SqlValue[] = []) =>
      runDirect(() => invoke<T[]>("db_select", { sql, params })),
    batch: (statements: BatchStatement[]) =>
      runDirect(() => invoke<ExecuteResult[]>("db_batch", { statements })),
    transaction: <T>(work: (tx: Database) => Promise<T>) => work(txHandle),
  };

  async function runTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    await directExecute("BEGIN IMMEDIATE");
    try {
      const result = await work(txHandle);
      await directExecute("COMMIT");
      return result;
    } catch (error) {
      try {
        await directExecute("ROLLBACK");
      } catch (rollbackError) {
        // Propagate the rollback failure without losing the original
        // transaction error. `cause` is attached as a property because
        // the ES2020 lib does not type the Error options constructor.
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        const originalMessage = error instanceof Error ? error.message : String(error);
        const combined = new Error(
          `ROLLBACK failed (${rollbackMessage}) after transaction error: ${originalMessage}`,
        );
        (combined as Error & { cause?: unknown }).cause = rollbackError;
        throw combined;
      }
      throw error;
    }
  }

  const adapter: Database = {
    execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
      return runSerialized(() => directExecute(sql, params));
    },
    select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      return runSerialized(() => runDirect(() => invoke<T[]>("db_select", { sql, params })));
    },
    batch(statements: BatchStatement[]): Promise<ExecuteResult[]> {
      return runSerialized(() =>
        runDirect(() => invoke<ExecuteResult[]>("db_batch", { statements })),
      );
    },
    transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
      return runSerialized(() => runTransaction(work));
    },
  };

  return adapter;
}
