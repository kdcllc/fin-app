# Task 04.1 — Report covering indexes

Status: done (judge PASS 5/5, 2026-08-16)
Depends on: Goal 08 (rusqlite `user_version` migrations)

## Objective

`payments` has an `account_id` index (and only additional indexes this task can justify as named, static DDL) so Goal 04 account-dimension aggregates are not missing a basic lookup index. Today `0001_schema_v1.sql` indexes `date`, `payee_id`, and `category_id` but not `account_id`.

## Notes

- Layer(s) touched: schema + the Goal 08 migration **registry** (one append). The runner does **not** glob `migrations/`.
- Never edit shipped migration files 0001–0006. Add `src-tauri/migrations/0007_*.sql`.
- Append `(7, include_str!("../migrations/0007_….sql"))` to `MIGRATIONS` in `src-tauri/src/db.rs` (currently versions 1–6). Without that append, production `open_book` never applies 0007.
- Vitest `tests/support/test-db.ts` `openTestDb()` globs `*.sql` and does **not** set `PRAGMA user_version`. A green Vitest schema test is **not** proof that the app migrated. The `user_version` AC must be a **`cargo test`** that opens a fresh temp book through the Rust runner (`open_book` / the same `MIGRATIONS` apply path already tested in `db.rs`).
- Required DDL: `CREATE INDEX idx_payments_account_id ON payments (account_id);`
- Optional extra indexes: only as explicit named DDL in 0007. Do **not** write report `SELECT`s and do **not** assert `EXPLAIN QUERY PLAN`. Speed is the 04.2 100 ms gate.
- Do not add UNIQUE constraints. Do not change entity tables. GnuCash out of scope.

## Acceptance criteria

- `src-tauri/migrations/0007_*.sql` exists (0001–0006 byte-identical) and creates at least `idx_payments_account_id`.
- `src-tauri/src/db.rs` `MIGRATIONS` includes version 7 pointing at that file.
- A **cargo test** (from `src-tauri/`) opens a fresh temp book through the Rust migration runner and asserts `PRAGMA user_version = 7` and `sqlite_master` contains `idx_payments_account_id`. Do not use Vitest `openTestDb()` as the evidence for `user_version`.
- `npm test` and `cargo test` (from `src-tauri/`) still pass.
