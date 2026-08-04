/**
 * Minimal database seam for the core data-access layer.
 *
 * Repositories are written against this interface only. Two adapters satisfy
 * it: `adapters/rust-sqlite.ts` (the real app, over the app-owned Rust SQLite
 * backend in `src-tauri/src/db.rs`) and the better-sqlite3 test adapter in
 * `tests/support/test-db.ts` (Vitest, no Tauri runtime). Both drivers accept
 * `?` positional placeholders — all SQL in this package uses `?` exclusively.
 */

/** Values that can be bound to a `?` placeholder. */
export type SqlValue = string | number | null;

export interface ExecuteResult {
  /** rowid of the last inserted row (0 when not an INSERT). */
  lastInsertId: number;
  /** Number of rows changed by the statement. */
  rowsAffected: number;
}

/** One statement inside a `batch` call. */
export interface BatchStatement {
  sql: string;
  params: SqlValue[];
}

export interface Database {
  /** Run a statement that does not return rows (INSERT/UPDATE/DELETE/DDL). */
  execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult>;
  /** Run a query and return all result rows. */
  select<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /**
   * Run every statement inside ONE SQLite transaction, in order, and return
   * one `ExecuteResult` per statement. If any statement fails, the whole
   * batch rolls back and the error names the failing statement index.
   * Must not be called from inside `transaction` — SQLite cannot nest
   * transactions, and the adapters let that failure propagate.
   */
  batch(statements: BatchStatement[]): Promise<ExecuteResult[]>;
  /**
   * Run all operations in `work` in a single SQLite transaction.
   * The adapter must commit on success and roll back on error; commit and
   * rollback failures propagate — they are never swallowed.
   */
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
}
