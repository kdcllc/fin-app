/**
 * Runs the shared `Database` seam contract suite against the better-sqlite3
 * test adapter, pinning the `batch`/`transaction` semantics it must share
 * with the app's rust-sqlite adapter (see `tests/support/db-contract.ts`).
 */
import { describeDatabaseContract } from "../support/db-contract";
import { openTestDb } from "../support/test-db";

describeDatabaseContract("better-sqlite3 test adapter", () => {
  const t = openTestDb();
  return { db: t.db, close: () => t.close() };
});
