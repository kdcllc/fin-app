# Task 02: backup-settings-ui

## Objective

The user-facing half of backups: real backup preferences in `settings.ts`, a
`src/backup.ts` wrapper module (invoke wrappers + launch-time scheduled-backup
trigger), and the Settings page section — location, retention, last-backup time,
backup-now, and the guarded restore flow.

## Dependencies

- 01-backup-rust (commands exist)

```yaml
# --- task ownership contract ---
writes:
  - src/settings.ts              # BackupPreferences becomes real
  - src/backup.ts                # new: invoke wrappers + schedule logic
  - src/pages/SettingsPage.tsx   # backup section
  - src/App.tsx                  # run scheduled-backup check once after book open
  - tests/app-shell.test.tsx     # update placeholder-backup assertions to the new shape
reads:
  - src-tauri/src/backup.rs      # command signatures
  - src/gnucash-book.ts          # (if landed) store-file conventions
depends_on:
  - "01-backup-rust"
owner: implementer
rewrite_semantics: targeted-insertion   # SettingsPage.tsx and App.tsx are shared files
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `settings.ts`: `BackupPreferences` becomes
      `{ enabled: boolean; retention: number; intervalDays: number;
      lastBackupAt: string | null }` with defaults
      `{ enabled: true, retention: 20, intervalDays: 7, lastBackupAt: null }`;
      load/update handle the new shape and tolerate the old persisted
      `{ enabled }`-only value (missing fields take defaults — no crash on existing
      stores).
- [ ] `src/backup.ts`: typed wrappers for `backup_now`, `list_backups`,
      `restore_backup`; every `backup_now` call site (manual button AND scheduler)
      passes `settings.backups.retention`; `runScheduledBackupIfDue(settings)` — when
      `enabled` and `lastBackupAt` is null or older than `intervalDays`, runs a
      backup, updates `lastBackupAt`, and returns what happened (ran / skipped /
      failed) so the UI can surface failures non-blockingly.
- [ ] `App.tsx`: after the book opens successfully, the scheduled check runs exactly
      once per app session (fire-and-forget; a failure never blocks the app or shows a
      modal — a dismissible notice at most).
- [ ] Settings backup section shows: backups folder path (derived from the book path),
      retention (numeric input, ≥ 1, persisted), interval, enabled toggle,
      last-backup time (from settings), and a "Back up now" button with success/error
      feedback and a refreshed backup list.
- [ ] Restore flow: list backups (name, date, size, newest first) → pick → explicit
      confirmation naming the backup and warning the current book is replaced (after
      being backed up first) → on success the app reloads onto the restored book; on
      failure the typed error is shown and the current book keeps working.
- [ ] All money-free; no SQL; imports from `src/core` not needed — this is file-ops UI
      over invoke wrappers.
- [ ] Test-first where practical: logic in `src/backup.ts` (due-date math, outcome
      mapping) written to be unit-testable without Tauri (invoke injected/mockable,
      consistent with existing wrapper modules).
- [ ] `tests/app-shell.test.tsx` currently asserts the placeholder checkbox
      ("Automatic backups (placeholder — arrives in a later milestone)") and seeds
      `backups: { enabled: false }`: update exactly those assertions/fixtures to the
      new `BackupPreferences` shape and Settings UI so the existing suite stays green;
      no other test in that file changes.

## Files to Read

- `src/settings.ts`, `src/pages/SettingsPage.tsx` — current shapes and section style
- `src/App.tsx` — book-open lifecycle for the scheduled hook
- `tests/app-shell.test.tsx` — the placeholder assertions/fixtures this task updates
- `_goals/distribution-auto-update/goal.md` — discovery decisions

## Files to Create / Change

- Exactly the ownership contract's write set. SettingsPage/App edits are additive
  sections/hooks — existing behavior untouched.

## Constraints

- Must: keep existing settings tests/consumers working (defaulting old stores);
  follow existing page styling.
- Must NOT: block app startup on backup work, auto-restore anything, or touch
  `src/core`, Rust files, or the gnucash goal's files.

## Verification

- Targeted test command: `npx vitest run tests/app-shell.test.tsx` (the impacted test
  this task owns and updates); plus `npm run typecheck` + `npm run lint`.
  (`tests/backup.test.ts` arrives in task 06.)
- Manual evidence: Settings screenshot with the backup section populated.
