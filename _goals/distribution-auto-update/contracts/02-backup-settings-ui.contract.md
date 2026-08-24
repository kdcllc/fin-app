# Contract: 02-backup-settings-ui

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

02-backup-settings-ui

## done_definition

`BackupPreferences` in `settings.ts` is a real persisted shape with safe defaulting for
legacy `{ enabled }`-only stores; a new `src/backup.ts` module exposes typed Tauri invoke
wrappers (`backup_now`, `list_backups`, `restore_backup`) plus injectable scheduling logic
that always passes `settings.backups.retention` to `backup_now`; `App.tsx` fires the
scheduled check exactly once per session after a successful book open (non-blocking, failure
surfaced only as a dismissible notice at most); `SettingsPage.tsx` replaces the placeholder
backup section with location, retention, interval, enabled toggle, last-backup time,
backup-now feedback, a refreshed backup list, and a guarded restore flow; restore success
reinitializes the shell onto the restored book and restore failure shows a typed error while
leaving the current book usable; `tests/app-shell.test.tsx` updates only its placeholder
backup fixtures/assertions to match the new UI shape and stays green alongside
`npm run typecheck` and `npm run lint`. No Rust, core SQL, or money types are touched.

## acceptance_criteria

### `settings.ts` — `BackupPreferences` shape and migration

1. `BackupPreferences` is exported as
   `{ enabled: boolean; retention: number; intervalDays: number; lastBackupAt: string | null }`.
   — verification: typecheck (`npm run typecheck`).

2. `DEFAULT_BACKUPS` equals
   `{ enabled: true, retention: 20, intervalDays: 7, lastBackupAt: null }`.
   — verification: typecheck + code inspection of `src/settings.ts`.

3. When the persisted store has no `backups` key, `loadSettings()` returns
   `backups: { ...DEFAULT_BACKUPS }`.
   — verification: code inspection; full store-migration unit test deferred to task 06
   (`tests/backup.test.ts`, out of scope here).
    evaluator-note (pin e): settings-migration proof this task is code inspection of
    `loadSettings` normalize/merge; unit tests belong to task 06.

4. When the persisted store holds legacy `{ enabled: boolean }` only (missing
   `retention`, `intervalDays`, `lastBackupAt`), `loadSettings()` returns the stored
   `enabled` value and fills missing fields from defaults (`retention: 20`,
   `intervalDays: 7`, `lastBackupAt: null`) without throwing.
   — verification: code inspection of normalize/merge logic in `loadSettings`; no crash
   on partial shape provable by type-safe merge helper.

5. `updateSettings({ backups: … })` persists the full `BackupPreferences` object passed
   in the patch; partial UI edits merge with the current `settings.backups` before save
   so changing one field (e.g. enabled toggle) does not wipe sibling fields.
   — verification: component test in `tests/app-shell.test.tsx` (persist-settings test
   asserts toggling enabled preserves other backup fields when re-read from mock store).
    evaluator-note (pin e): merge-on-update is required. Prove by SettingsPage
    merge-before-save inspection this task. An extra sibling-field assertion inside the
    existing persist-settings test is allowed; new `it(...)` blocks are not (pin d).
    Dedicated merge/migration unit tests remain task 06.

6. Settings module remains money-free and imports nothing from `src/core`.
   — verification: code inspection of `src/settings.ts` imports.

### `src/backup.ts` — invoke wrappers and IPC types

7. `BackupInfo` TypeScript type matches task-01 IPC JSON (camelCase):
   `{ fileName: string; path: string; createdAt: string; sizeBytes: number }`.
   — verification: typecheck.

8. `backupNow(retention: number)` invokes `backup_now` with `{ retention }` and returns
   `Promise<BackupInfo>`. Aligns with `db.rs::backup_now(state, retention: Option<u32>)`.
   — verification: code inspection; invoke arg mapping proven in task 06 wrapper tests
   (out of scope).

9. `listBackups()` invokes `list_backups` with no book-path argument (book comes from
   open session) and returns `Promise<BackupInfo[]>`.
   — verification: code inspection.

10. `restoreBackup(backupPath: string)` invokes `restore_backup` with the backup path
    (Tauri camelCase `{ backupPath }` matching Rust `backup_path: String`) and returns
    `Promise<void>`.
    — verification: code inspection.
    evaluator-note (pin f): confirmed. Existing wrappers pass JS keys that match
    single-word Rust params (`src/xlsx-reader.ts:35` `{ path }`; `src/core/adapters/rust-sqlite.ts:26`
    `{ path: bookPath }`; `{ sql, params }`). `restore_backup` is `#[tauri::command(async)]`
    with Rust `backup_path: String` and no `rename_all` (`src-tauri/src/db.rs:261-265`).
    Tauri 2 default IPC keys are camelCase, so the invoke payload is `{ backupPath }` —
    not `{ backup_path }`. Response `BackupInfo` is independently camelCase via serde
    (`src-tauri/src/backup.rs:19`; test `backup_info_serializes_camel_case_over_ipc`).

11. Every `backup_now` call site in this module — manual backup helper and scheduler — passes
    `settings.backups.retention` (not a hard-coded default, not omitted).
    — verification: code inspection (grep `backup_now` / `backupNow` call sites in owned
    files).

12. Module imports only Tauri API surface and local settings/types — no SQL, no
    `src/core`, no float money.
    — verification: code inspection of `src/backup.ts` imports.

### `src/backup.ts` — scheduling and outcome semantics

13. `runScheduledBackupIfDue(settings: AppSettings, deps?)` (or equivalent exported API)
    evaluates due-ness when `settings.backups.enabled` is true and `lastBackupAt` is
    `null` OR the elapsed time since `lastBackupAt` (ISO-8601 parse) is greater than or
    equal to `settings.backups.intervalDays` whole days (each day = 86_400_000 ms UTC).
    — verification: code inspection of due-date helper (pure, exported or injectable).
    evaluator-note (pin a): whole-day due math is pinned — elapsed UTC ms since parsed
    `lastBackupAt` `>= intervalDays * 86_400_000`; `null` `lastBackupAt` is due. Acceptable
    expansion of task wording "older than intervalDays".

14. When disabled, returns a non-throwing outcome indicating skipped/disabled (e.g.
    `{ status: "skipped", reason: "disabled" }`) and does not invoke `backup_now`.
    — verification: code inspection.

15. When enabled and not due, returns a non-throwing skipped outcome (e.g.
    `{ status: "skipped", reason: "not_due" }`) and does not invoke `backup_now`.
    — verification: code inspection.

16. When enabled and due, invokes `backupNow(settings.backups.retention)`, then persists
    `lastBackupAt` to the current ISO-8601 UTC timestamp via `updateSettings`, and returns
    a ran outcome including backup metadata (e.g. `{ status: "ran", backup: BackupInfo }`).
    — verification: code inspection.

17. When enabled and due but `backup_now` rejects, returns a failed non-throwing outcome
    (e.g. `{ status: "failed", error: string }`) and does not throw through to callers.
    — verification: code inspection.

18. Due-date math and outcome mapping live in pure functions with injectable `invoke` /
    `updateSettings` (consistent with `src/xlsx-reader.ts` wrapper style) so task 06 can
    unit-test without Tauri.
    — verification: code inspection of exported helpers and dependency injection pattern.
    evaluator-note: invoke wrappers themselves stay thin `invoke(cmd, args)` like
    `xlsx-reader.ts`; due-date/outcome helpers take injectable deps because the task
    requires unit-testability without Tauri. `xlsx-reader.ts` does not itself inject.

### `App.tsx` — once-per-session scheduled hook

19. After the book opens successfully and phase becomes `ready`, the scheduled backup check
    runs exactly once per app session (module-level or ref guard survives re-renders;
    not re-fired on settings/page navigation).
    — verification: code inspection of session guard + call site in book-open success path.

20. The scheduled check is fire-and-forget: it does not `await` inside the book-open
    critical path before rendering the shell, and a slow or failing backup never blocks
    startup or shows a modal dialog.
    — verification: code inspection (async IIFE / unawaited promise).

21. On scheduled failure (`status: "failed"`), the shell may show at most one dismissible
    notice (inline banner/toast with dismiss control — not `window.alert`, not a blocking
    dialog); the user can dismiss it and continue using the app.
    — verification: manual screenshot or live interaction showing dismissible error notice
    after simulated invoke failure; code inspection confirms no modal.
    evaluator-note (pin d): App.tsx once-per-session / fire-and-forget / dismissible-notice
    (criteria 19–24) and restore-reload (37) are proven by code inspection plus manual
    evidence this task; automated behavioral tests live in task 06. See criterion 43 for
    the allowed setup mock.

22. On scheduled skip or success, no blocking UI is shown (success may be silent).
    — verification: code inspection.

23. First-run flow (no book yet) and error phase do not run the scheduled backup check.
    — verification: code inspection.

24. Existing app-shell navigation, first-run, and settings behaviors outside the backup
    placeholder remain unchanged.
    — verification: `npx vitest run tests/app-shell.test.tsx` (non-backup tests still pass).

### `SettingsPage.tsx` — backup section UI

25. Backups section displays the backups folder path derived from `settings.bookPath` as
    `<book-parent>/backups` (read-only label, e.g. `<code>` text); when `bookPath` is
    null, shows a sensible empty state without throwing.
    — verification: manual screenshot with book configured; component test may assert
    rendered path text when `bookPath` is set in app-shell persist test navigation.

26. Enabled toggle binds to `settings.backups.enabled` and persists via `onUpdate` with
    merged `BackupPreferences`.
    — verification: component test in `tests/app-shell.test.tsx` (updated checkbox label,
    not the placeholder string).

27. Retention numeric input binds to `settings.backups.retention`, rejects or clamps values
    `< 1` before persist (user cannot persist 0 or negative), and persists valid values
    `≥ 1`.
    — verification: manual screenshot; code inspection of input validation.

28. Interval-days numeric input binds to `settings.backups.intervalDays`, persists valid
    values, and uses the same merge-on-update pattern as retention.
    — verification: manual screenshot.

29. Last-backup time displays from `settings.backups.lastBackupAt` (formatted for humans
    when set; clear empty state when `null`).
    — verification: manual screenshot.

30. "Back up now" button calls `backupNow(settings.backups.retention)`, shows success or
    error feedback inline in the section (same `error`/`run` pattern as existing Settings
    controls), refreshes the backup list on success, and updates displayed `lastBackupAt`
    after a successful manual backup (via settings refresh or patch).
    — verification: manual screenshot (success + error states); code inspection.

31. Backup list loads via `listBackups()` on entering Settings (or on mount of backup
    section), renders each backup's name (`fileName`), date (`createdAt`), and size
    (`sizeBytes`) human-readable, ordered newest-first (trust Rust sort; re-sort allowed).
    — verification: manual screenshot with at least one backup file present.

32. Settings page remains money-free, SQL-free, and does not import `src/core`.
    — verification: code inspection.

33. New backup UI follows existing Settings page styling (`section.page`, `h2`, `label.field`,
    `button`, `p.error`).
    — verification: manual screenshot.

### Restore flow (`SettingsPage.tsx` + `src/backup.ts`)

34. Each listed backup offers a restore action (button or row action) that does not
    immediately restore — it opens an explicit confirmation step naming the selected backup
    (`fileName`) and warning that the current book will be replaced after a safety backup
    is taken first.
    — verification: manual screenshot of confirmation copy; code inspection.
    evaluator-note (pin c): confirm widget is implementer freedom (buttons or typed
    confirm). The copy MUST name the selected backup `fileName` and warn that the current
    book will be replaced after a safety backup is taken first.

35. Confirmation requires an affirmative user action (e.g. confirm/cancel buttons or typed
    confirm); cancel leaves the book untouched and closes the flow.
    — verification: manual live interaction.

36. On confirm, `restoreBackup(backup.path)` is invoked; while pending, restore controls
    show busy/disabled state.
    — verification: code inspection.

37. On restore success, the app shell reinitializes onto the restored book (full page reload
    via `window.location.reload()` or equivalent re-run of the book-open bootstrap in
    `App.tsx`) so the user sees restored data without stale in-memory repos.
    — verification: manual live interaction (restore then verify reloaded shell/data).
    evaluator-note (pin b): reload mechanism is implementer freedom — `window.location.reload()`
    or equivalent re-run of the book-open bootstrap. Required outcome: shell shows restored
    data with no stale in-memory repos.

38. On restore failure (invoke rejection with Rust `BackendError` display string), the
    Settings section shows the typed error message inline and the current session/book
    remains usable (no reload, no corrupted shell state).
    — verification: manual live interaction with invalid backup fixture; code inspection.

39. Restore path passed to invoke is the `path` field from `BackupInfo` (absolute path
    under the book's `backups/` folder, as returned by `list_backups`).
    — verification: code inspection.

### `tests/app-shell.test.tsx` — owned test updates only

40. Mock `DEFAULT_BACKUPS` matches the new default shape
    `{ enabled: true, retention: 20, intervalDays: 7, lastBackupAt: null }` (or imports
    from settings when mock allows).
    — verification: `npx vitest run tests/app-shell.test.tsx`.

41. `beforeEach` persisted `backups` fixture uses the full `BackupPreferences` shape (not
    `{ enabled: false }` alone).
    — verification: `npx vitest run tests/app-shell.test.tsx`.
    evaluator-note (pin d): `beforeEach` uses the full shape with `enabled: false` (preserving
    current skip so the scheduler does not fire in app-shell tests). Criterion 40's mocked
    `DEFAULT_BACKUPS` is the new default `{ enabled: true, retention: 20, intervalDays: 7,
    lastBackupAt: null }`.

42. The persist-settings test queries the enabled checkbox by the new accessible name/label
    (not `"Automatic backups (placeholder — arrives in a later milestone)"`) and still
    verifies enable persists across unmount/remount.
    — verification: `npx vitest run tests/app-shell.test.tsx`.

43. No other tests, mocks, or assertions in `tests/app-shell.test.tsx` are added, removed,
    or modified beyond the placeholder backup fixtures/assertions required by criteria
    40–42.
    — verification: diff inspection limited to backup-related lines in that file.
    evaluator-note (pin d): means no other `it(...)` cases and no non-backup assertion
    edits. Adding `vi.mock` for `src/backup.ts` and/or `@tauri-apps/api/core` in file setup
    is allowed and expected so SettingsPage `listBackups` / App scheduled check do not hit
    live invoke.

### Regression and environment

44. `npm run typecheck` passes.
    — verification: command output exit code 0.

45. `npm run lint` passes on owned files.
    — verification: command output exit code 0.

46. `npx vitest run tests/app-shell.test.tsx` passes.
    — verification: command output exit code 0.

47. Manual evidence: Settings page screenshot shows populated backup section (folder path,
    retention, interval, enabled toggle, last-backup time, backup-now control, backup list
    area) with a configured book.
    — verification: screenshot.

## verification_environment

library (vitest) + manual screenshot

## out_of_scope

- Rust changes (`src-tauri/**`), including `backup.rs`, `db.rs`, and `lib.rs` (task
  `01-backup-rust`).
- Updater configuration, signing, update-check UI, and `src/updater.ts` (tasks
  `03-updater-config`, `04-updater-ui`).
- Dedicated backup module and settings-page test files: `tests/backup.test.ts`,
  `tests/settings-page.test.tsx` (task `06-tests`).
- `src/core/**` and any SQL/data-access changes.
- GnuCash goal files.
- CI release workflow and docs (task `05-release-workflow`).

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T11:55:00-04:00
    note: Achievable within the five-file fence; IPC matches db.rs backup_now/list_backups/restore_backup and camelCase BackupInfo from task 01.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T12:20:00-04:00
    note: Counter-signed with pins — interval=86400000ms UTC; reload/confirm-widget freedom (must name fileName + warn replace); invoke { backupPath }; app-shell proof via inspection+manual+task 06 (backup mock allowed).
revision: 0
```
