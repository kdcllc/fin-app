# Contract: 01-backup-rust

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

01-backup-rust

## done_definition

A new `src-tauri/src/backup.rs` module implements verified, timestamped book-file backups
with retention rotation; `db.rs::open_book_connection` creates a default-retention (20)
backup before applying pending migrations on non-fresh existing books and aborts open on
backup failure; three IPC commands (`backup_now`, `list_backups`, `restore_backup`) are
registered in `lib.rs` and enforce the one-book-per-session rule via the book mutex.
Restore runs a seven-step close-replace-reopen sequence with explicit failure paths so the
session always ends with an openable book. All behavior is proven by `cargo test backup`
and existing `cargo test db` tests remain green, using temp dirs and fixture books only.

## acceptance_criteria

### `create_backup` core (`backup.rs`)

1. `create_backup` writes the backup to
   `<book-dir>/backups/<book-stem>-YYYYMMDD-HHMMSS.db` where the timestamp is UTC with
   second precision and `<book-stem>` is the book file stem (e.g. `book` for
   `.../book.db`). — verification: unit test asserting the returned path matches that
   pattern and lives under `<book-dir>/backups/`.

2. When a filename collision occurs at second precision, the backup name receives an
   additional collision suffix so two backups in the same UTC second do not overwrite
   each other. — verification: unit test creating two backups within the same second
   (mocked or forced clock) yields two distinct files.

3. Before returning, `create_backup` verifies the copy against the source by matching
   byte length and either SHA-256 digests or a full byte-by-byte compare; a mismatch
   causes a typed error and the unverified copy is not retained as a successful backup.
   — verification: unit test with a tampered or truncated copy fixture asserts error and
   no durable backup file at the expected path.

4. After a successful verified copy, rotation deletes the oldest backups when the count
   of pattern-matched backup files exceeds `retention`, keeping at most `retention`
   backups. — verification: unit test seeding `retention + N` pattern-matched files
   and asserting exactly `retention` remain afterward.

5. Rotation considers only files whose names match the backup naming pattern
   (`<book-stem>-YYYYMMDD-HHMMSS*.db` under `backups/`); non-matching files in the
   same folder (e.g. `notes.txt`, `manual-old.db`) are never deleted. — verification:
   unit test with mixed pattern-matched backups and decoy files; after rotation the decoy
   files still exist.

6. When `retention` is omitted at call sites that accept an optional value, the effective
   retention is 20. — verification: unit test calling `create_backup` without an explicit
   retention and asserting rotation keeps 20 newest pattern-matched files when 25 exist.

7. When `retention` is supplied, values less than 1 are rejected with a typed error and
   no backup file is created. — verification: unit test with `retention = 0` (and/or
   negative) asserts typed error and unchanged `backups/` contents.

### WAL-safe backup consistency

8. Backups of a WAL-mode book are taken via `PRAGMA wal_checkpoint(TRUNCATE)` on the
   open session connection and/or the SQLite backup API so the on-disk copy is a
   consistent standalone database (not a raw copy of a hot WAL file alone). — verification:
   unit test on a WAL-mode book opened through the normal session path asserts checkpoint
   or backup-API use (observable via successful consistent copy, not merely file existence).

9. Writes committed on the open WAL connection before backup are visible when the backup
   file is opened in a separate read-only connection afterward (proves consistency, not
   merely that the copy opens). — verification: unit test inserts identifiable row(s) via
   the open session connection, runs backup, opens the backup path with a fresh
   `Connection`, and reads back the same row(s).

10. Pre-migration and `backup_now` backups do not open a second concurrent connection to
    the open book outside the book mutex. — verification: code review constraint enforced
    by tests that exercise backup through the session/open path; unit test asserts backup
    succeeds while the session holds the sole open connection (no lock errors, data
    visible in copy per criterion 9).

### Pre-migration hook (`db.rs::open_book_connection`)

11. When `user_version` is below the latest migration version and the file is not a fresh
    book (`user_version == 0` with no app tables), a verified backup is created in
    `<book-dir>/backups/` before any migration SQL runs. — verification: integration test
    opening a partially migrated fixture (e.g. stopped at version 1) asserts a new backup
    file exists in `backups/` and `user_version` on disk was still the pre-migration value
    at backup time (backup predates migration writes).
    evaluator-note (pin a): "app tables" is pinned under criterion 13.

12. When backup creation fails during the pre-migration hook, `open_book` returns a typed
    `BackendError` variant (not a generic string) and no migration is applied (`user_version`
    and schema unchanged from before open). — verification: integration test with backup
    destination made unwritable or mocked failure asserts error variant and unchanged
    `user_version`/tables.

13. A fresh book (`user_version == 0` and no app tables — e.g. empty or newly materialized
    file) skips pre-migration backup even though migrations will run. — verification:
    integration test opening a fresh path asserts `backups/` is absent or contains no new
    pattern-matched backup and migrations still reach latest version.
    evaluator-note (pin a): "app tables" means any table listed in `db.rs` `EXPECTED_TABLES`
    is present in `sqlite_master`. Verified members (test-module `EXPECTED_TABLES`,
    db.rs:427-435): `accounts`, `categories`, `import_log`, `payees`, `payments`,
    `recurring_bill_suggestion_dismissals`, `recurring_bills`. Fresh book = `user_version == 0`
    AND none of those names exist. Mirrors the legacy-guard's app-tables-exist check; never
    file size.

14. Fresh-book detection never uses file size (a WAL-mode book may be non-empty immediately
    after open). — verification: integration test opens a fresh book, performs writes so
    the file is non-empty, resets to a state with `user_version == 0` and no app tables
    (fixture), and asserts backup is still skipped per criterion 13.

15. A fully migrated book (`user_version` equals latest migration version) skips
    pre-migration backup on open. — verification: integration test opening an already
    latest-version fixture asserts no new backup file appears in `backups/`.

16. The pre-migration hook always uses retention 20 and never reads the TS settings store.
    — verification: unit/integration test with more than 20 pre-existing pattern-matched
    backups during a hooked open asserts rotation to 20; no import or invoke of TS store
    APIs from `backup.rs`/`db.rs` (static inspection acceptable, behavior proof via
    criterion 6 default).

### IPC commands (`lib.rs` registrations)

17. `backup_now(retention) -> BackupInfo` creates a verified backup of the currently open
    book's path and returns `BackupInfo` with at least `file_name`, `path`, `created_at`
    (ISO-8601 UTC), and `size_bytes`. — verification: integration test with an open
    session asserts returned fields match the created file on disk.
    evaluator-note (pin b): `db.rs` IPC response structs use `#[serde(rename_all = "camelCase")]`
    (verified on `ExecResult`, db.rs:133-138). `BackupInfo` IPC JSON fields are `fileName`,
    `path`, `createdAt`, `sizeBytes` (Rust struct fields may stay snake_case).

18. `backup_now` returns a typed error when no book is open (`BackendError::NoBookOpen` or
    equivalent dedicated variant). — verification: integration test calling `backup_now`
    on empty `OpenBookState` asserts typed error.

19. `list_backups() -> Vec<BackupInfo>` returns all pattern-matched backups for the open
    book's `backups/` folder, newest first, with `file_name`, `path`, `created_at`
    (ISO-8601), and `size_bytes` on each entry. — verification: integration test seeding
    multiple backups with distinct timestamps asserts sort order and field values.
    evaluator-note (pin b): same IPC camelCase as criterion 17 (`fileName`, `createdAt`,
    `sizeBytes`).

20. `list_backups` returns an empty vector when the `backups/` folder is absent (not an
    error). — verification: integration test on a book with no `backups/` directory.

21. `list_backups` and `restore_backup` return a typed error when no book is open. —
    verification: integration test on empty `OpenBookState`.

22. `restore_backup(backup_path)` runs entirely under the book mutex (concurrent restore
    or overlapping open/restore attempts serialize without corrupting the book file). —
    verification: integration test spawning concurrent restore/open attempts asserts no
    corruption and mutex serialization (one completes, others error or block deterministically
    without partial install).

### Restore sequence — seven steps

23. Step 1: `restore_backup` rejects `backup_path` not contained in the open book's
    `backups/` directory (path traversal / outside paths) with a typed error and performs
    no file mutations. — verification: integration test with `../`, absolute outside path,
    or sibling-folder path asserts error; book file bytes and session unchanged.

24. Step 2: validation opens the candidate backup read-only and runs an integrity probe
    (`PRAGMA schema_version` or `PRAGMA quick_check`); files that are not openable SQLite
    or fail the probe are rejected with a typed error. Magic bytes alone are insufficient
    (a non-SQLite file with SQLite header bytes must fail the probe). — verification: unit
    test with corrupt/truncated/invalid fixture asserting rejection without book mutation.

25. Steps 1–3 failing leave the live book file, WAL/SHM sidecars, session slot, and
    connection state untouched (same as before restore was attempted). — verification:
    integration test failing at step 1 and step 2 captures book bytes and open session
    state before/after; both unchanged.

26. Step 3: before replacing the live book, `restore_backup` creates a safety backup of
    the current book via the same `create_backup` path (verified copy in `backups/`). —
    verification: integration test counts backups before restore and asserts a new
    pattern-matched safety backup appears before the live file is replaced.

27. Step 4: after a successful safety backup, the open connection is dropped and the
    session slot is cleared to `None` so a subsequent reopen goes through the normal
    `open_book_impl` path (same-path early return requires a populated slot). — verification:
    integration test observable via successful step 7 reopen; failure-path test at criterion
    29 confirms slot was cleared mid-restore.

28. Step 5: before installing the restored copy, the book's `-wal` and `-shm` sidecar
    files are deleted so stale WAL cannot replay into the restored database. — verification:
    integration test seeds a stale `-wal` with known junk, completes restore, opens restored
    book, and asserts restored data matches backup (not WAL replay corruption).

29. Step 6: the validated backup file is installed over the book path using an atomic
    rename when the platform supports it. — verification: integration test restore
    round-trip asserts book path contents match backup; post-restore read succeeds.

30. Step 7: the book is reopened via `open_book_connection`, the session slot is repopulated,
    and pending migrations re-apply if the backup predates current schema. — verification:
    integration test restoring an older backup snapshot asserts `user_version` migrates forward
    and session queries succeed.

31. Failure after step 4 but before a successful step 6: the original book file (still on
    disk until step 6 overwrites it) is reopened, a typed error is returned, and the session
    ends with an openable book matching pre-restore data. — verification: integration test
    forcing install failure (e.g. unwritable book path mid-restore) asserts original data
    readable after error.

32. Step 7 failure: the safety backup from step 3 is copied back over the book path, the
    book is reopened from that rollback, and a typed error is returned; the session ends
    with an openable book. — verification: integration test forcing reopen failure after
    install asserts book content matches pre-restore safety backup data and session open.

33. Every restore failure path leaves the session with an openable book (no stuck
    `None` slot with a corrupted or half-replaced file). — verification: integration tests
    for criteria 31–32 plus step 1–3 failures assert `open_book`/`db_select` succeed on the
    surviving book afterward.

### End-to-end restore and migration tests

34. Restore round-trip: seed identifiable data → backup → mutate live book → restore from
    backup → original seeded data is back. — verification: integration test comparing row
    counts and seeded values before mutation vs after restore.

35. Restoring a backup predating newer migrations triggers re-migration on reopen (step 7)
    so the opened book reaches the latest `user_version`. — verification: integration test
    with backup from intermediate schema version asserts post-restore `user_version` equals
    latest and app tables exist.

### Retention on commands

36. `backup_now` accepts optional `retention`; when omitted, default 20 applies; when
    provided, values `< 1` are rejected with a typed error. — verification: unit/integration
    tests mirroring criteria 6–7 via the command entry point.

### Regression and environment

37. All new tests use temporary directories and fixture books only (never the developer's
    real book path). — verification: test code inspection; tests construct `TempBook`-style
    paths under `std::env::temp_dir()`.

38. `cargo test backup --manifest-path src-tauri/Cargo.toml` passes. — verification:
    command output exit code 0.

39. `cargo test db --manifest-path src-tauri/Cargo.toml` passes (existing open/migration
    tests unchanged). — verification: command output exit code 0.

40. New backup/restore errors follow the existing `BackendError` enum pattern and serialize
    as display strings across IPC. — verification: unit test asserting `Serialize` output
    for new variants is a string; integration test surface matches `Display`.

41. Backup timestamps used in filenames and `BackupInfo.created_at` are UTC. — verification:
    unit test comparing filename timestamp and `created_at` against known UTC instant (fixed
    clock or parsed offset `Z`).

42. Implementation does not log book contents. — verification: code inspection of
    `backup.rs`/`db.rs` changes; no SQL row dumps in backup paths.

## verification_environment

library (cargo test)

## out_of_scope

- TypeScript/React Settings UI for backup location, retention, backup-now, restore, and
  scheduled cadence (task `02-backup-settings-ui`).
- Tauri updater configuration, signing, and update-check UI (tasks `03-updater-config`,
  `04-updater-ui`).
- CI release workflow, public releases repo publishing, and docs runbook (task
  `05-release-workflow`).
- Reading backup retention or cadence from the TS settings store in Rust (hook uses fixed
  default 20 only).

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T11:05:00-04:00
    note: Achievable within backup.rs + surgical db.rs hook/commands + lib.rs registrations; WAL-safe backup uses the existing session connection before run_migrations.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T11:20:00-04:00
    note: Counter-signed with pins — app tables = any EXPECTED_TABLES name present; BackupInfo IPC camelCase per ExecResult.
revision: 0
```
