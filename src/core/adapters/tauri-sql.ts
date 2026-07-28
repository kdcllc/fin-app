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
  return {
    async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
      try {
        const result = await db.execute(sql, params);
        return { lastInsertId: result.lastInsertId ?? 0, rowsAffected: result.rowsAffected };
      } catch (error) {
        throw mapSqliteError(error);
      }
    },
    async select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      try {
        return await db.select<T[]>(sql, params);
      } catch (error) {
        throw mapSqliteError(error);
      }
    },
  };
}
