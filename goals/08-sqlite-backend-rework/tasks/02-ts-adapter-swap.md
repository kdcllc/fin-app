# Task 08.2 — TS adapter swap & plugin removal

Status: done

## Objective

The TS core talks to the new Rust backend through a new adapter that implements the existing `Database` seam plus a new `batch` primitive; `@tauri-apps/plugin-sql` and the old `tauri-sql.ts` adapter (with its savepoint/error-swallowing workarounds) are gone. Repositories and all existing core logic compile and pass tests unchanged except for the seam extension.

## Notes

- Layer(s) touched: ts-core.
- Baseline: the pre-existing uncommitted working-tree workarounds were discarded by user decision; start from the committed HEAD state.
- Extend the `Database` seam (`src/core/db.ts`) with `batch(statements: Array<{ sql: string; params: SqlValue[] }>): Promise<ExecuteResult[]>`. Both adapters implement it:
  - New `src/core/adapters/rust-sqlite.ts`: `invoke("db_select" | "db_execute" | "db_batch")`, mapping errors through the existing `mapSqliteError`. Keep the existing client-side serialization queue so interleaved calls cannot split a transaction.
  - Test adapter (`tests/support/test-db.ts`, better-sqlite3): implement `batch` with identical semantics (one transaction, rollback-all on failure, per-statement results) so Vitest exercises the same contract.
- `transaction(work)` (callback style) is now coherent on the single connection: `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` via `db_execute`, serialized by the adapter queue. No savepoint fallbacks, no swallowed commit/rollback errors — failures propagate.
- Delete `src/core/adapters/tauri-sql.ts`; remove `@tauri-apps/plugin-sql` from `package.json`; update app wiring that called `Database.load`/`register_book` to the new `open_book` command (UI-facing polish is task 08.4; this task makes the app boot and function).
- This task owns the full plugin removal on BOTH sides: `tauri-plugin-sql` is removed from `src-tauri/Cargo.toml` here (08.1 may leave it present-but-unregistered for compilation; the dependency must not survive this task), with `Cargo.lock` regenerated.
- Remove the per-execute `SELECT last_insert_rowid()` fallback — the backend returns `lastInsertId` directly.
- Remove the `src/core/repositories/insert-verify.ts` / `resolveInsertedRow` machinery: it existed to verify inserts against the pool's unreliable `lastInsertId`. With a single connection, repositories return inserted rows via `INSERT ... RETURNING` through `select` (rusqlite supports RETURNING) or trust `lastInsertId`; pick one style and apply it uniformly across the five repositories that import it. This is the one sanctioned repository change (see GOAL.md constraints).
- Update stale references to `tauri-plugin-sql`: `goals/README.md` stack line, `src-tauri` doc comments touched by this change, and `docs/RESEARCH.md` line 142 ("Schema migrations from day one (`tauri-plugin-sql` migrations)") — amend with a dated note pointing at Goal 08 rather than silently rewriting the research record.
- Skills: `codebase-design` (keep the seam deep and narrow), `setup-ts-deep-modules`.

## Acceptance criteria

- `npm test` passes with the extended seam; every existing repository test is green without modification to repository code beyond the sanctioned `resolveInsertedRow` removal and type-level seam additions.
- `rg "plugin-sql"` finds no matches in `src/`, `package.json`, `src-tauri/Cargo.toml`, or registered Rust plugins; `rg "SAVEPOINT|no transaction is active"` finds no matches in `src/core/adapters/`.
- `src/core/repositories/insert-verify.ts` no longer exists; no repository imports `resolveInsertedRow`; the workspace compiles and all repository tests pass with the replacement insert-result style.
- The app boots against a real book file: `open_book` → adapter `select`/`execute`/`batch` round trips verified manually or via dev smoke.
- Contract parity: a shared Vitest suite runs the same `batch` and `transaction` semantics tests against the better-sqlite3 adapter (atomic success, rollback-all on mid-batch failure, correct `lastInsertId` per statement).
- `npm run lint` is clean.
