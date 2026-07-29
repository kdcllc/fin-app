/**
 * Minimal database seam for the core data-access layer.
 *
 * Repositories are written against this interface only. Two adapters satisfy
 * it: `adapters/tauri-sql.ts` (the real app, over `tauri-plugin-sql`) and the
 * better-sqlite3 test adapter in `tests/support/test-db.ts` (Vitest, no Tauri
 * runtime). Both drivers accept `?` positional placeholders — all SQL in this
 * package uses `?` exclusively.
 */

/** Values that can be bound to a `?` placeholder. */
export type SqlValue = string | number | null;

export interface ExecuteResult {
  /** rowid of the last inserted row (0 when not an INSERT). */
  lastInsertId: number;
  /** Number of rows changed by the statement. */
  rowsAffected: number;
}

export interface Database {
  /** Run a statement that does not return rows (INSERT/UPDATE/DELETE/DDL). */
  execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult>;
  /** Run a query and return all result rows. */
  select<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /**
   * Run all operations in `work` in a single SQLite transaction.
   * The adapter must commit on success and roll back on error.
   */
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
}
