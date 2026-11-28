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
  /**
   * Apply every migration not yet applied (only meaningful after
   * `openTestDb({ upToVersion })`), exactly like the Rust runner: FKs off,
   * one transaction per file, `PRAGMA foreign_key_check` must be empty.
   */
  applyRemainingMigrations(): void;
  close(): void;
}

export interface OpenTestDbOptions {
  /**
   * Apply only migrations whose numeric prefix is <= this version.
   * Default: apply all migrations.
   */
  upToVersion?: number;
}

interface MigrationFile {
  version: number;
  name: string;
}

function listMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ version: Number.parseInt(name.slice(0, 4), 10), name }));
  if (files.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  return files;
}

/** Open a fresh in-memory book database (all migrations applied unless `upToVersion` is given). */
export function openTestDb(options: OpenTestDbOptions = {}): TestDb {
  const raw = new BetterSqlite3(":memory:");
  raw.pragma("foreign_keys = ON"); // the Rust backend sets this in open_book; mirror it.

  const pending = listMigrations();
  const upTo = options.upToVersion ?? Number.POSITIVE_INFINITY;

  // Mirrors the Rust `run_migrations`: foreign keys OFF outside any
  // transaction, one transaction per file, `foreign_key_check` gate before
  // COMMIT, foreign keys restored ON on every exit path.
  function applyMigrations(limit: number): void {
    raw.pragma("foreign_keys = OFF");
    try {
      while (pending.length > 0 && pending[0].version <= limit) {
        const { name } = pending[0];
        raw.exec("BEGIN");
        try {
          raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
          const violations = raw.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) {
            throw new Error(
              `migration ${name} left foreign key violations: ${JSON.stringify(violations)}`,
            );
          }
          raw.exec("COMMIT");
        } catch (error) {
          raw.exec("ROLLBACK");
          throw error;
        }
        pending.shift();
      }
    } finally {
      raw.pragma("foreign_keys = ON");
    }
  }

  applyMigrations(upTo);

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

  return {
    db,
    repos: createRepositories(db),
    calls,
    applyRemainingMigrations: () => applyMigrations(Number.POSITIVE_INFINITY),
    close: () => raw.close(),
  };
}
