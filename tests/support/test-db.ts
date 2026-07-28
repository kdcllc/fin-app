/**
 * better-sqlite3 adapter for the core `Database` seam — Vitest's stand-in for
 * the app's tauri-sql adapter. Opens an in-memory SQLite database and applies
 * the REAL migration files from `src-tauri/migrations/` in version order, so
 * repository tests run against the exact production schema (CHECKs, FKs,
 * defaults, indexes) without the Tauri runtime.
 */
import BetterSqlite3 from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepositories, mapSqliteError } from "../../src/core";
import type { Database, ExecuteResult, Repositories, SqlValue } from "../../src/core";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/migrations",
);

export interface TestDb {
  db: Database;
  repos: Repositories;
  close(): void;
}

/** Open a fresh in-memory book database with all migrations applied. */
export function openTestDb(): TestDb {
  const raw = new BetterSqlite3(":memory:");
  raw.pragma("foreign_keys = ON"); // sqlx does this on every connection; mirror it.

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrations.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  for (const name of migrations) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  const db: Database = {
    async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
      try {
        const result = raw.prepare(sql).run(...params);
        return { lastInsertId: Number(result.lastInsertRowid), rowsAffected: result.changes };
      } catch (error) {
        throw mapSqliteError(error);
      }
    },
    async select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      try {
        return raw.prepare(sql).all(...params) as T[];
      } catch (error) {
        throw mapSqliteError(error);
      }
    },
  };

  return { db, repos: createRepositories(db), close: () => raw.close() };
}
