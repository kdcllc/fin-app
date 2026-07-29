/**
 * `tauri-plugin-sql` adapter for the core `Database` seam — the adapter the
 * real app wires in (tests wire a better-sqlite3 adapter instead; see
 * `tests/support/test-db.ts`). Thin by design: translate the call, map the
 * error, nothing else.
 */
import TauriDatabase from "@tauri-apps/plugin-sql";
import type { Database, ExecuteResult, SqlValue } from "../db";
import { mapSqliteError } from "../errors";
import { withDatabaseLockedRetry } from "./locked-retry";

/**
 * Open the book database via `tauri-plugin-sql`. The `sqlite:` URL must match
 * the one registered in `src-tauri/src/db.rs` so the plugin's migrations run.
 */
export async function openTauriDatabase(url: string): Promise<Database> {
  const db = await TauriDatabase.load(url);
  // Allow transient lock contention to wait briefly instead of failing immediately.
  await db.execute("PRAGMA busy_timeout = 5000");
  let inTransaction = false;
  let queue: Promise<void> = Promise.resolve();

  async function runSerialized<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
    const run = async () =>
      withDatabaseLockedRetry(async () => {
        try {
          const result = await db.execute(sql, params);
          let lastInsertId = result.lastInsertId ?? null;
          if (lastInsertId === null) {
            const rows = await db.select<Array<{ id: number }>>(
              "SELECT last_insert_rowid() AS id",
            );
            const first = rows[0];
            lastInsertId = first?.id ?? 0;
          }
          return { lastInsertId, rowsAffected: result.rowsAffected };
        } catch (error) {
          throw mapSqliteError(error);
        }
      });

    return inTransaction ? run() : runSerialized(run);
  }

  async function select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const run = async () =>
      withDatabaseLockedRetry(async () => {
        try {
          return await db.select<T[]>(sql, params);
        } catch (error) {
          throw mapSqliteError(error);
        }
      });

    return inTransaction ? run() : runSerialized(run);
  }

  const adapter: Database = {
    execute,
    select,
    async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return work(adapter);
      }

      return runSerialized(async () => {
        inTransaction = true;
        await execute("BEGIN IMMEDIATE");
        try {
          const result = await work(adapter);
          await execute("COMMIT");
          return result;
        } catch (error) {
          try {
            await execute("ROLLBACK");
          } catch {
            // Ignore rollback failures to preserve the original error surface.
          }
          throw error;
        } finally {
          inTransaction = false;
        }
      });
    },
  };

  return adapter;
}
