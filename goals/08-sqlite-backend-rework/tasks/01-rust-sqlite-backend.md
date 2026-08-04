# Task 08.1 — Rust SQLite backend: single connection, migrations, batch transactions

Status: done

## Objective

An app-owned SQLite backend in `src-tauri` replaces `tauri-plugin-sql`: one `rusqlite` connection per book behind a mutex in managed state, a `user_version`-based migration runner reusing the existing `src-tauri/migrations/*.sql` files, and Tauri commands `open_book`, `db_select`, `db_execute`, and `db_batch` — the last executing an entire statement list inside one real transaction in one IPC call.

## Notes

- Layer(s) touched: rust.
- Add `rusqlite` (bundled feature) to `src-tauri/Cargo.toml`; remove `tauri-plugin-sql` here (frontend removal is task 08.2 — coordinate so the workspace still compiles at each task boundary; it is acceptable to leave the plugin dependency present but unregistered until 08.2 if needed for compilation).
- `open_book(path)` replaces `register_book` (`src-tauri/src/lib.rs`): validate absolute path, materialize the file (keep `materialize_book_file`), open the connection, set `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, run pending migrations, store `Mutex<Connection>` in managed state. Same one-book-per-session rule as today.
- Migration runner: apply `src-tauri/migrations/000N_*.sql` in order where `N > PRAGMA user_version`, each file in its own transaction, setting `user_version = N` after each. Never edit shipped migration files (existing invariant in `src-tauri/src/db.rs` docs). Fresh-file bootstrap is the only supported path — no migration of the plugin's `_sqlx_migrations` bookkeeping (user decision: dev data may be wiped).
- Legacy book-file guard: a plugin-era file has app tables but `user_version = 0`, so blindly running migration 0001 would fail mid-way with "table already exists". `open_book` must detect this case (e.g. `user_version = 0` AND `payments` table exists in `sqlite_master`) before running migrations and reject with a typed, user-readable error telling the user to choose a new book file. Empty file + `user_version = 0` is the normal fresh-bootstrap path and must not be rejected.
- Command contracts (params and rows as JSON):
  - `db_select(sql, params) -> Vec<Map<String, Value>>`
  - `db_execute(sql, params) -> { rowsAffected: u64, lastInsertId: i64 }`
  - `db_batch(statements: Vec<{ sql, params }>) -> Vec<{ rowsAffected, lastInsertId }>` — all statements in one transaction; on any error, roll back everything and return an error naming the failing statement index and SQLite message. Errors must surface — never mapped to success.
- Param mapping: JSON null/integer/real/text/bool → rusqlite types; amounts arrive as integer cents. Reject parameter types outside this set with a typed error.
- Keep `xlsx_reader` untouched. Keep error strings mappable by the existing TS `mapSqliteError`.
- Include `cargo test` coverage in this task (test-generator extends it in 08.5): migration runner brings a fresh temp file to the latest `user_version` with all tables present and is idempotent on re-open; `db_batch` atomicity (statement 3 of 5 fails → zero rows persisted); foreign-key enforcement active.

## Acceptance criteria

- `cargo test` (from `src-tauri/`) passes, including new tests proving: fresh-file migration to latest version, migration idempotency across re-open, batch rollback on mid-batch failure, FK enforcement, and param type mapping.
- `db_batch` executes N statements in exactly one transaction on one connection; a mid-batch failure leaves the database byte-identical in content to before the call.
- `open_book` on a fresh path creates the file, applies all 6 existing migrations, and returns success; a second `open_book` with a different path in the same session is rejected (existing rule preserved).
- `open_book` on a plugin-era file (app tables present, `user_version = 0`) is rejected with the clear legacy-file error before any migration statement runs, leaving the file unmodified (covered by a cargo test with a fixture-constructed legacy file).
- No sqlx/`tauri-plugin-sql` code paths remain registered in the Tauri builder.
- `cargo clippy -- -D warnings` is clean.
