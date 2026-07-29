import { describe, expect, it } from "vitest";
import {
  DatabaseLockedError,
  ForeignKeyViolationError,
  isSqliteLockErrorMessage,
  mapSqliteError,
} from "../../src/core";

describe("sqlite error mapping", () => {
  it("maps foreign key violations", () => {
    const mapped = mapSqliteError(new Error("FOREIGN KEY constraint failed"));
    expect(mapped).toBeInstanceOf(ForeignKeyViolationError);
  });

  it("classifies lock and busy variants", () => {
    const lockMessages = [
      "database is locked",
      "database table is locked",
      "database schema is locked: main",
      "SQLITE_BUSY: database is busy",
      "SQLITE_LOCKED: table payments",
      "error code 5: lock timeout",
      "Resource busy",
      "SqlState[HY000]: General error: 5 database is locked",
      "(code: 6) database table is locked",
    ];

    for (const message of lockMessages) {
      expect(isSqliteLockErrorMessage(message)).toBe(true);
      expect(mapSqliteError(new Error(message))).toBeInstanceOf(DatabaseLockedError);
    }
  });

  it("does not classify unrelated errors as lock contention", () => {
    const message = "no such table: payments";
    expect(isSqliteLockErrorMessage(message)).toBe(false);

    const mapped = mapSqliteError(new Error(message));
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped).not.toBeInstanceOf(DatabaseLockedError);
  });
});
