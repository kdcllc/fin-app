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

/** SQLite returned BUSY/LOCKED (for example, another process holds a write lock). */
export class DatabaseLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseLockedError";
  }
}

/** Input failed domain validation before hitting SQLite. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Delete/archive flow conflict: the entity is still referenced. */
export class EntityInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityInUseError";
  }
}

/** Payee merge cannot proceed due to invalid state or input. */
export class PayeeMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayeeMergeError";
  }
}

const SQLITE_LOCK_PATTERNS = [
  "database is locked",
  "database table is locked",
  "database schema is locked",
  "database is busy",
  "sqlite_busy",
  "sqlite_locked",
  "sqlstate[hy000]: general error: 5",
  "error code 5",
  "error code 6",
  "code: 5",
  "code: 6",
  "resource busy",
  "lock timeout",
];

export function isSqliteLockErrorMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return SQLITE_LOCK_PATTERNS.some((pattern) => lowered.includes(pattern));
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
  if (isSqliteLockErrorMessage(message)) {
    return new DatabaseLockedError(message);
  }
  return error instanceof Error ? error : new Error(message);
}
