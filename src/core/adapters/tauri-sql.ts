/**
 * `tauri-plugin-sql` adapter for the core `Database` seam — the adapter the
 * real app wires in (tests wire a better-sqlite3 adapter instead; see
 * `tests/support/test-db.ts`). Thin by design: translate the call, map the
 * error, nothing else.
 */
import TauriDatabase from "@tauri-apps/plugin-sql";
import type { Database, ExecuteResult, SqlValue } from "../db";
import { mapSqliteError } from "../errors";

/**
 * Open the book database via `tauri-plugin-sql`. The `sqlite:` URL must match
 * the one registered in `src-tauri/src/db.rs` so the plugin's migrations run.
 */
export async function openTauriDatabase(url: string): Promise<Database> {
  const db = await TauriDatabase.load(url);
  let inTransaction = false;

  async function execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
    try {
      const result = await db.execute(sql, params);
      return { lastInsertId: result.lastInsertId ?? 0, rowsAffected: result.rowsAffected };
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  async function select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    try {
      return await db.select<T[]>(sql, params);
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  const adapter: Database = {
    execute,
    select,
    async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return work(adapter);
      }

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
    },
  };

  return adapter;
}
