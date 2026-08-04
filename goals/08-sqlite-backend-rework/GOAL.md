# Goal 08 — SQLite Backend Rework (persistence & import speed)

**Milestone:** v0.1 · **Depends on:** 01, 02

## Objective

Replace the `tauri-plugin-sql` data-layer backend, whose pooled connections silently break `BEGIN`/`COMMIT` (upstream [plugins-workspace #886](https://github.com/tauri-apps/plugins-workspace/issues/886)), with an app-owned Rust SQLite backend: one `rusqlite` connection behind a mutex, real transactions, and a batch command that commits an entire import in a single IPC round trip. This fixes the two shipped defects in Goals 01–02: import commits that report success but do not persist, and import runs that take minutes instead of seconds.

## Root cause being fixed (diagnosis 2026-08-04)

- `tauri-plugin-sql` opens a sqlx pool (up to 10 connections); each `execute`/`select` uses a random connection, so `BEGIN`, the writes, and `COMMIT` land on different connections. Writes inside the phantom transaction are rolled back when the pool recycles; the orphaned write lock stalls later writes for the full `busy_timeout`.
- Every insert costs one IPC round trip plus a `SELECT last_insert_rowid()` round trip, individually fsync'd (no working transaction).
- The Vitest suite runs on a single-connection `better-sqlite3` adapter, so all "atomic commit" tests pass while the production adapter was never exercised.
- Working-tree workarounds (savepoint fallback, swallowed "no transaction is active" errors) mask the data loss and are discarded by explicit user decision, not shipped.

## Constraints

- The TS core `Database` seam, repositories, cell parser, payee normalization, dedup logic, and schema/migration SQL files are preserved — with one sanctioned exception: the `insert-verify.ts` / `resolveInsertedRow` workaround (built to compensate for the pool's unreliable `lastInsertId`) is removed in task 08.2. SQL strings stay in TS core; the Rust backend is a dumb executor (layer-ownership invariant from Goal 02 holds).
- The entity tables (`payees`, `accounts`, `categories`) have no UNIQUE name constraints (see `src-tauri/migrations/0001_schema_v1.sql`); no such constraint is added in this goal. Any commit-batch design must not depend on `INSERT OR IGNORE` name-uniqueness semantics, and entity-level idempotency must be proven by test (task 08.3).
- Plugin-era book files (tables present but `PRAGMA user_version = 0`) are not migrated: `open_book` must detect and reject them with a clear error (task 08.1). Fresh book files are the only supported bootstrap path (user decision 2026-08-04).
- Amounts remain integer cents. Tests remain fixture-only. GnuCash is out of scope.
- Transaction failures must surface as errors — never be swallowed or "treated as success".
- The dev book file may be wiped; existing data does not need migration off the plugin's bookkeeping tables (user decision 2026-08-04).

## Success criteria

- Persistence: importing the committed fixture workbook, then fully restarting the app, shows all imported payments; the SQLite file on disk contains the rows (verified by direct file inspection in QA evidence).
- Atomicity: an injected failure mid-commit leaves zero new rows in `payments`, `payees`, `accounts`, `categories`, and `import_log` (automated test).
- Speed: the import commit for a fixture of ≥ 1,000 payment cells executes as a single batch IPC call and completes in under 5 seconds on the dev machine.
- Idempotency preserved: re-importing identical content inserts zero new payments; a fixture variant with one additional valid cell proposes exactly one.
- `tauri-plugin-sql` is removed from `package.json` and `src-tauri/Cargo.toml`; no `BEGIN`/`COMMIT`/`SAVEPOINT` strings are issued from TS outside the adapters.
- Quality gates green: `npm test`, `cargo test` (from `src-tauri/`), `npm run lint`, `cargo clippy -- -D warnings`.

## Tasks

Execution order deviates from the default layer order because the TS adapter is a client of the new Rust commands: Rust backend → TS adapter → TS core import path → UI → Tests.

1. [Rust SQLite backend: single connection, migrations, batch transactions](tasks/01-rust-sqlite-backend.md)
2. [TS adapter swap & plugin removal](tasks/02-ts-adapter-swap.md)
3. [Import commit as one atomic batch](tasks/03-import-commit-batching.md)
4. [UI wiring: book open flow & commit progress](tasks/04-ui-wiring.md)
5. [Rework test coverage](tasks/05-rework-tests.md)
