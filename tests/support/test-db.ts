/**
 * better-sqlite3 adapter for the core `Database` seam — Vitest's stand-in for
 * the app's rust-sqlite adapter. Opens an in-memory SQLite database and
 * applies the REAL migration files from `src-tauri/migrations/` in version
 * order, so repository tests run against the exact production schema (CHECKs,
 * FKs, defaults, indexes) without the Tauri runtime.
 */
import BetterSqlite3 from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepositories, mapSqliteError } from "../../src/core";
import type {
  BatchStatement,
  Database,
  ExecuteResult,
  Repositories,
  SqlValue,
} from "../../src/core";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/migrations",
);

/** One recorded call against the adapter, for call-count assertions. */
export interface RecordedDbCall {
  kind: "execute" | "select" | "batch";
  sql: string;
}

export interface TestDb {
  db: Database;
  repos: Repositories;
  /** Every execute/select/batch call, in order — lets tests assert call shape. */
  calls: RecordedDbCall[];
  close(): void;
}

/** Open a fresh in-memory book database with all migrations applied. */
export function openTestDb(): TestDb {
  const raw = new BetterSqlite3(":memory:");
  raw.pragma("foreign_keys = ON"); // the Rust backend sets this in open_book; mirror it.

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrations.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  for (const name of migrations) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  const calls: RecordedDbCall[] = [];

  const db: Database = {
    async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
      calls.push({ kind: "execute", sql });
      try {
        const result = raw.prepare(sql).run(...params);
        return { lastInsertId: Number(result.lastInsertRowid), rowsAffected: result.changes };
      } catch (error) {
        throw mapSqliteError(error);
      }
    },
    async select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      calls.push({ kind: "select", sql });
      try {
        return raw.prepare(sql).all(...params) as T[];
      } catch (error) {
        throw mapSqliteError(error);
      }
    },
    // Identical semantics to the Rust backend's db_batch: every statement in
    // ONE transaction, rollback-all on any failure, per-statement results,
    // and the error names the failing statement index (same message shape).
    async batch(statements: BatchStatement[]): Promise<ExecuteResult[]> {
      calls.push({ kind: "batch", sql: statements.map((statement) => statement.sql).join(";\n") });
      raw.exec("BEGIN");
      try {
        const results: ExecuteResult[] = [];
        for (const [index, statement] of statements.entries()) {
          try {
            const result = raw.prepare(statement.sql).run(...statement.params);
            results.push({
              lastInsertId: Number(result.lastInsertRowid),
              rowsAffected: result.changes,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw mapSqliteError(new Error(`batch statement ${index} failed: ${message}`));
          }
        }
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(db);
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return { db, repos: createRepositories(db), calls, close: () => raw.close() };
}
