/**
 * Typed errors surfaced by the core data-access layer.
 *
 * Adapters translate driver-specific failures into these types via
 * `mapSqliteError`, so callers can `instanceof`-match without knowing which
 * SQLite driver is underneath.
 */

/** A statement violated a FOREIGN KEY constraint (e.g. dangling payee_id). */
export class ForeignKeyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForeignKeyViolationError";
  }
}

/**
 * Map a raw driver error to a typed core error. Both SQLite drivers used by
 * this app (sqlx via tauri-plugin-sql, and better-sqlite3 in tests) include
 * the canonical SQLite message text "FOREIGN KEY constraint failed".
 */
export function mapSqliteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("FOREIGN KEY constraint failed")) {
    return new ForeignKeyViolationError(message);
  }
  return error instanceof Error ? error : new Error(message);
}
