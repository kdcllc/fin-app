# Task 01: backup-rust

## Objective

The Rust backup/restore engine for the fin-app book: verified timestamped copies into a
`backups/` folder next to the book, automatic pre-migration backup wired into the
existing open path, retention-based rotation, and IPC commands for backup-now / list /
restore that respect the one-book-per-session rule.

## Dependencies

- none

```yaml
# --- task ownership contract ---
writes:
  - src-tauri/src/backup.rs
  - src-tauri/src/db.rs        # pre-migration backup hook + restore-aware session handling
  - src-tauri/src/lib.rs       # module decl + command registrations only
reads:
  - src-tauri/src/db.rs
depends_on: []
owner: implementer
rewrite_semantics: targeted-insertion   # db.rs and lib.rs are shared files
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `backup.rs` core: `create_backup(book_path, retention)` copies the book to
      `<book-dir>/backups/<book-stem>-YYYYMMDD-HHMMSS.db` (UTC, second precision,
      collision-suffixed), verifies the copy (byte length + SHA-256 or full byte
      compare) before returning its path, then rotates: oldest backups beyond
      `retention` are deleted (rotation counts only files matching the backup naming
      pattern — never other user files).
- [ ] Backups of a WAL-mode book are taken safely: checkpoint/flush via the open
      connection (`PRAGMA wal_checkpoint(TRUNCATE)`) — or copy through the SQLite
      backup API — so the copy is a consistent standalone database. Proven by a test
      that makes writes on the open WAL connection, backs up, then opens the copy and
      finds those writes (not merely "the copy opens").
- [ ] Pre-migration hook in `db.rs::open_book_connection`: when pending migrations
      exist (current `user_version` < latest) AND the file is an existing book with
      app data, a backup is created BEFORE any migration runs; failure to back up
      aborts the open with a typed error (never migrate unprotected). "Fresh book"
      (skips backup) is defined as `user_version == 0` AND no app tables — never by
      file size, since WAL-mode files are non-empty after open. Fully-migrated books
      skip it (proven by test). The hook always uses the default retention (20); it
      never reads the TS settings store.
- [ ] Commands (registered in `lib.rs`):
      - `backup_now(retention) -> BackupInfo` — uses the open book's path; error when
        no book is open.
      - `list_backups() -> Vec<BackupInfo>` (`file_name`, `path`, `created_at`
        ISO-8601, `size_bytes`), newest first; empty list when the folder is absent.
      - `restore_backup(backup_path) -> ()` — the exact sequence, all under the book
        mutex, in this order:
        1. validate `backup_path` is inside the open book's `backups/` folder;
        2. validate the backup by actually OPENING it read-only and running an
           integrity probe (`PRAGMA schema_version` or `quick_check`) — magic bytes
           alone are insufficient;
        3. safety-backup the CURRENT book (same `create_backup` path);
        4. drop the open connection and clear the session slot to `None` — the
           one-book-per-session no-op in `open_book_impl` (same-path early return)
           means "reopen through the normal open path" only works with a cleared
           slot;
        5. delete the book's `-wal` and `-shm` sidecar files (stale WAL replaying
           into the restored file would corrupt it);
        6. install the restored copy over the book path (atomic rename where
           possible);
        7. reopen via `open_book_connection` and set the session slot (migrations
           re-apply if the backup predates them).
        Failure handling: steps 1–3 failing leave everything untouched; a failure
        after step 4 but before a successful step 6 reopens the ORIGINAL book file
        (still on disk) and returns a typed error; step 7 failing copies the safety
        backup from step 3 back over the book path and reopens it. In every path the
        session ends with an openable book.
- [ ] Retention parameter validated (≥ 1); default 20 when unspecified.
- [ ] Rust tests (temp dirs only): pre-migration backup created exactly when expected
      (and skipped for fresh + fully-migrated books); verified-copy failure aborts;
      rotation past the limit; WAL-consistency of the copy (writes visible in copy);
      restore round-trip (seed data → backup → mutate → restore → original data back,
      re-migration on old backup); sidecar files removed before install (a seeded
      stale `-wal` never leaks into the restored book); reopen-failure rollback path
      restores the safety backup and leaves an openable book; restore rejection for
      paths outside `backups/`, files that fail the open probe, and while no book is
      open; concurrent-safety of the book mutex around restore.

## Files to Read

- `src-tauri/src/db.rs` — open path, session mutex, migration runner, error enum style
- `goals/07-distribution/tasks/03-backup-restore.md` — archived intent
- `_goals/distribution-auto-update/goal.md` — discovery decisions

## Files to Create / Change

- Exactly the ownership contract's write set. `db.rs` edits are surgical: the hook, a
  session-close/reopen surface for restore, new error variants; migration array and
  existing commands untouched.

## Constraints

- Must: keep every `db.rs` behavior test green; typed errors following the existing
  `BackendError` pattern; UTC timestamps.
- Must NOT: introduce a second connection to the open book outside the mutex, delete
  anything but pattern-matched backup files, log book contents, or touch TS/UI files.

## Verification

- Targeted test command: `cargo test backup --manifest-path src-tauri/Cargo.toml`
- Rung 2: `cargo test db --manifest-path src-tauri/Cargo.toml` (existing open/migration
  tests still green).
