# Contract: 06-tests

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

06-tests

## done_definition

Three new Vitest files — `tests/backup.test.ts`, `tests/updater.test.ts`, and
`tests/settings-page.test.tsx` — provide deterministic, fully mocked coverage of the
distribution feature's TypeScript surfaces: `src/backup.ts` scheduling and invoke
wrappers, `src/updater.ts` typed result API (injectable `UpdaterDeps`, status
discriminant, internal re-check in `downloadAndInstall`), `src/settings.ts` backup
defaults/migration, and `SettingsPage` backup + updates UX (including busy-guard and
restore confirmation). All Tauri plugins (`invoke`, store, dialog, updater, process, app
version) are mocked; time is injected or faked for due-date math; no network and no
real filesystem writes outside temp dirs. A completion-report coverage audit maps every
exported symbol of `src/backup.ts`, `src/updater.ts`, and the new `settings.ts` backup
surface to a covering test (gaps filled or explicitly justified). Targeted run
(`npx vitest run tests/backup.test.ts tests/updater.test.ts
tests/settings-page.test.tsx`) and the full Vitest suite (`npm test`) both exit 0. No
product code, Rust tests, or CI changes.

## acceptance_criteria

### Global constraints (all three test files)

1. Every test file mocks all external Tauri/plugin surfaces — `@tauri-apps/api/core`
   `invoke`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-dialog`,
   `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`,
   `@tauri-apps/api/app`, and `@tauri-apps/plugin-opener` when imported — so tests run
   without the Tauri runtime or network. — verification: code inspection of `vi.mock`
   blocks; unit test — no unhandled network/plugin errors when running targeted vitest.

2. No test writes to the user's real book, real app-data settings path, or real
   filesystem outside vitest temp dirs (if any FS touch is needed, use `tmpdir` /
   fixture paths only). — verification: code inspection; unit test — targeted vitest
   exit 0 with mocks in place.

3. Due-date and scheduling tests use injected `now` (`ScheduledBackupDeps.now`) or
   `vi.useFakeTimers()` — never depend on wall-clock time at run time. — verification:
   unit test — `tests/backup.test.ts` cases for due/not-due pass with fixed timestamps.

4. Page tests follow existing patterns from `tests/app-shell.test.tsx`: jsdom
   environment, `@testing-library/react` + `userEvent`, module-level `vi.mock` for
   `src/backup`, `src/updater`, `src/settings` (or store plugin), and dialog/opener as
   needed; render `SettingsPage` with controlled `settings` + `onUpdate` props. —
   verification: code inspection; unit test — `tests/settings-page.test.tsx` exit 0.

### `tests/backup.test.ts` — `src/settings.ts` backup defaults and migration

5. `normalizeBackups(null)` and `normalizeBackups(undefined)` return
   `DEFAULT_BACKUPS` (`enabled: true`, `retention: 20`, `intervalDays: 7`,
   `lastBackupAt: null`). — verification: unit test in `tests/backup.test.ts`.

6. Legacy store shape `{ enabled: false }` (only `enabled` persisted) normalizes to
   `{ enabled: false, retention: 20, intervalDays: 7, lastBackupAt: null }` — no throw,
   no crash. — verification: unit test calling `normalizeBackups({ enabled: false })`.

7. `loadSettings()` when the mocked store returns `backups: { enabled: true }` only
   yields `AppSettings.backups` with all four fields populated from defaults for missing
   keys. — verification: unit test with mocked `LazyStore.get` returning partial
   backups; assert merged result.

8. Partial overrides merge correctly: e.g. stored `{ enabled: true, retention: 5 }`
   keeps `intervalDays: 7` and `lastBackupAt: null` from defaults. — verification: unit
   test on `normalizeBackups` or `loadSettings`.

### `tests/backup.test.ts` — `isBackupDue` and `runScheduledBackupIfDue`

9. `isBackupDue(null, intervalDays, nowMs)` returns `true` for any positive
   `intervalDays`. — verification: unit test with fixed `nowMs`.

10. `isBackupDue(lastBackupAt, intervalDays, nowMs)` returns `true` when
    `nowMs - Date.parse(lastBackupAt) >= intervalDays * 86_400_000`. — verification: unit
    test with injected `nowMs` and ISO `lastBackupAt` exactly at boundary and one ms
    before boundary.

11. `isBackupDue(lastBackupAt, intervalDays, nowMs)` returns `false` when the interval
    has not elapsed. — verification: unit test with recent `lastBackupAt`.

12. `runScheduledBackupIfDue` with `settings.backups.enabled === false` resolves to
    `{ status: "skipped", reason: "disabled" }` without calling `backupNow`. — verification:
    unit test with mocked `ScheduledBackupDeps`.

13. `runScheduledBackupIfDue` with enabled backups and `lastBackupAt === null` calls
    `deps.backupNow(settings.backups.retention)`, then `deps.updateSettings` with
    `lastBackupAt` set to `new Date(nowMs).toISOString()`, and resolves to
    `{ status: "ran", backup }`. — verification: unit test; assert mock call args
    `{ retention: <settings value> }`.

14. `runScheduledBackupIfDue` when not due (recent `lastBackupAt`, injected `now`)
    resolves to `{ status: "skipped", reason: "not_due" }` without calling `backupNow`. —
    verification: unit test.

15. When `deps.backupNow` rejects (or throws), `runScheduledBackupIfDue` resolves to
    `{ status: "failed", error: "<message>" }` and **does not throw** to the caller. —
    verification: unit test with rejecting mock.

16. Failure path does not call `deps.updateSettings`. — verification: unit test —
    `updateSettings` mock not called when `backupNow` fails.

### `tests/backup.test.ts` — invoke wrappers

17. `backupNow(retention)` calls `invoke("backup_now", { retention })` with the passed
    retention value and returns the invoke result. — verification: unit test with mocked
    `@tauri-apps/api/core` `invoke`.

18. `restoreBackup(backupPath)` calls `invoke("restore_backup", { backupPath })` with the
    exact path argument. — verification: unit test with mocked `invoke`.

19. `listBackups()` calls `invoke("list_backups")` with no extra args and returns the
    invoke result array. — verification: unit test with mocked `invoke`.

### `tests/updater.test.ts` — `checkForUpdate` mapping (injectable `UpdaterDeps`)

20. When `deps.check()` resolves to `null`, `checkForUpdate(deps)` returns
    `{ status: "up-to-date" }`. — verification: unit test.

21. When `deps.check()` resolves to an update object with `version`, `body`, and `date`,
    `checkForUpdate(deps)` returns
    `{ status: "available", version, notes: body ?? "", date: <ISO string> }` (empty body
    → `notes: ""`; missing/empty date → `date: ""`; valid date parsed to ISO). —
    verification: unit tests for available mapping including empty body and date edge
    cases matching `toIsoDate` in `src/updater.ts`.

22. When `deps.check()` rejects with a network-like error (e.g. `TypeError`, message
    containing `"network"` or `"fetch"`), `checkForUpdate(deps)` returns
    `{ status: "error", kind: "offline", message: "<string>" }` and **does not throw**. —
    verification: unit test.

23. When `deps.check()` rejects with a non-network error, `checkForUpdate(deps)` returns
    `{ status: "error", kind: "unknown", message: "<string>" }`. — verification: unit
    test.

### `tests/updater.test.ts` — `downloadAndInstall` (re-runs `check()` internally)

24. `downloadAndInstall(onProgress, deps)` calls `deps.check()` again (not a cached
    result from a prior `checkForUpdate`). — verification: unit test — mock `check`
    returns update on second call; assert `check` invoked inside `downloadAndInstall`.

25. When inner `deps.check()` returns `null`, `downloadAndInstall` resolves to
    `{ status: "error", kind: "unknown", message: "No update is available to download." }`
    without calling `downloadAndInstall` on the update object. — verification: unit test.

26. Progress callback wiring: mock update object's `downloadAndInstall(eventHandler, …)`
    invokes the handler with plugin events `{ event: "Started", data: { contentLength } }`,
    `{ event: "Progress", data: { chunkLength } }`, and `{ event: "Finished" }`; assert
    `onProgress` receives `{ downloaded, total }` after Started (total from contentLength
    or `null`), after each Progress (downloaded accumulates), and after Finished. —
    verification: unit test simulating `DownloadEvent` sequence.

27. Successful download+install resolves to `{ status: "installed" }`. — verification:
    unit test with mock update whose `downloadAndInstall` resolves.

28. When download/install throws, `downloadAndInstall` resolves to
    `{ status: "error", kind: "offline" | "unknown", message }` and **does not throw**. —
    verification: unit test.

### `tests/updater.test.ts` — `getAppVersion` and `relaunch`

29. `getAppVersion(deps)` delegates to `deps.getVersion()` and returns its string
    result. — verification: unit test with mocked deps.

30. `relaunch(deps)` on success returns `{ status: "ok" }` after `deps.relaunch()`
    resolves. — verification: unit test.

31. `relaunch(deps)` when `deps.relaunch()` rejects returns
    `{ status: "error", message: "<string>" }` without throwing. — verification: unit
    test.

### `tests/updater.test.ts` — launch-check silence contract

32. Simulated launch-check consumer (mirroring `App.tsx` `triggerUpdateCheckOnce`):
    given mocked `checkForUpdate` returning `{ status: "up-to-date" }`, the consumer's
    `onAvailable` callback is **not** invoked and no error UI flag is set. — verification:
    unit test in `tests/updater.test.ts` exercising the same branch logic as App
    (`result.status === "available"` only triggers `onAvailable`).

33. Simulated launch-check consumer: given mocked `checkForUpdate` returning
    `{ status: "error", kind: "offline", message: "…" }`, `onAvailable` is **not**
    invoked (silent failure — at most optional console warn, not asserted). — verification:
    unit test in `tests/updater.test.ts`.

### `tests/settings-page.test.tsx` — backup section render

34. With `settings.bookPath` set and backups folder derivable, the page renders backup
    **folder** path (`…/backups`), **retention** input showing
    `settings.backups.retention`, and **last backup** text from
    `formatBackupTime(settings.backups.lastBackupAt)` (`"Never"` when null). —
    verification: unit test — `screen.getByText` / label queries on rendered
    `SettingsPage`.

35. When `settings.bookPath` is null, backup folder shows muted placeholder copy (not a
    path). — verification: unit test.

### `tests/settings-page.test.tsx` — backup-now feedback

36. Clicking **Back up now** calls mocked `backupNow` with `settings.backups.retention`,
    then `onUpdate` with `backups.lastBackupAt` matching the mock backup's `createdAt`,
    and shows success message containing the mock `fileName`. — verification: unit test
    with `userEvent` + waitFor on mocks and DOM.

37. When mocked `backupNow` rejects, an `.error` element shows the error message and
    `onUpdate` is not called with a new `lastBackupAt`. — verification: unit test.

### `tests/settings-page.test.tsx` — restore flow

38. Clicking **Restore** on a listed backup opens an inline confirmation that names the
    backup file (`restoreTarget.fileName` visible in confirmation copy, e.g. inside
    `<code>`). — verification: unit test after mocking `listBackups` to return at least
    one entry.

39. **Confirm restore** without prior selection is a no-op (guard when
    `restoreTarget === null`). — verification: unit test or code-path coverage via
    confirm only after Restore click.

40. **Confirm restore** calls mocked `restoreBackup(restoreTarget.path)` with the
    selected backup's path. — verification: unit test with `userEvent`.

41. When mocked `restoreBackup` rejects, `.error` shows the typed error message,
    `onBusyChange(false)` is called (failure path), and the page does not reload. —
    verification: unit test — mock `restoreBackup` rejection; assert `restoreError`
    visible; stub `window.location.reload` to detect no reload.

42. **Cancel** dismisses confirmation without calling `restoreBackup`. — verification:
    unit test.

### `tests/settings-page.test.tsx` — updates section states

43. **Idle**: Updates section shows current version (from mocked `getAppVersion`) and
    enabled **Check for updates** button. — verification: unit test on initial render.

44. **Checking**: after clicking **Check for updates**, button shows **Checking…** (or
    is disabled) while the mocked `checkForUpdate` promise is pending. — verification:
    unit test with deferred mock resolution.

45. **Up-to-date**: mocked `checkForUpdate` resolving `{ status: "up-to-date" }` shows
    inline muted **You're up to date** (or equivalent) copy. — verification: unit test.

46. **Available with notes**: mocked `checkForUpdate` resolving
    `{ status: "available", version, notes, date }` shows version, formatted date, release
    notes in a `<pre>`, and **Download and install** button. — verification: unit test
    with non-empty `notes`.

47. **Downloading with progress**: clicking **Download and install** with mocked
    `downloadAndInstall` that invokes the progress callback shows a labeled download
    progress `<progress>` element whose `value`/`max` reflect callback bytes when total
    is known. — verification: unit test driving progress callback synchronously or via
    microtasks.

48. **Post-install / restart**: after mocked `downloadAndInstall` resolves
    `{ status: "installed" }`, section shows restart prompt copy and **Restart now**
    button when `appBusy={false}`. — verification: unit test.

49. **Error**: mocked `checkForUpdate` resolving `{ status: "error", kind, message }`
    shows inline `.error` with `message`. Download failure
    (`{ status: "error", … }` from `downloadAndInstall`) also surfaces in `.error`. —
    verification: unit test(s) for check and download error paths.

### `tests/settings-page.test.tsx` — retention persist and busy-guard

50. Changing **Retention (max backups)** to a valid integer ≥ 1 calls `onUpdate` with
    `{ backups: { …, retention: <new value> } }` and the input reflects the persisted
    value on re-render with updated props. — verification: unit test — assert
    `onUpdate` mock args and controlled input value.

51. **Busy-guard**: with `updateInstalled` state (successful download) and
    `appBusy={true}`, **Restart now** button is **not** shown; instead the
    **Finish current work first** (or equivalent) error copy is visible. — verification:
    unit test rendering `SettingsPage` with `appBusy={true}` after simulating install
    complete.

52. Same post-install state with `appBusy={false}` shows **Restart now** and hides the
    busy-guard message; clicking it calls mocked `relaunch()`. — verification: unit test.

### Coverage audit (completion report requirement)

53. Completion report includes a table mapping **every exported symbol** below to a
    test case id (file + describe/it) or an explicit justification for omission:

    **`src/backup.ts`**: `BackupInfo`, `backupNow`, `listBackups`, `restoreBackup`,
    `isBackupDue`, `ScheduledBackupOutcome`, `ScheduledBackupDeps`,
    `runScheduledBackupIfDue`.

    **`src/updater.ts`**: `CheckForUpdateResult`, `UpdateErrorKind`, `DownloadProgress`,
    `DownloadAndInstallResult`, `RelaunchResult`, `UpdaterDeps`, `getAppVersion`,
    `checkForUpdate`, `downloadAndInstall`, `relaunch`.

    **`src/settings.ts` (backup surface)**: `BackupPreferences`, `AppSettings`,
    `DEFAULT_BACKUPS`, `normalizeBackups`, `loadSettings`, `updateSettings`.

    Pure types/interfaces (`BackupInfo`, outcome/result types, `BackupPreferences`,
    `AppSettings`) may be justified as covered implicitly by function tests that use
    them — justification must name the covering test. — verification: completion report
    section in task output; evaluator cross-check against exports.

54. Any export listed in criterion 53 with no test after implementation is a contract
    failure unless the report justification is accepted (e.g. type-only re-export with no
    runtime behavior). — verification: evaluator review of coverage table.

### Verification commands

55. Targeted Vitest run exits 0:
    `npx vitest run tests/backup.test.ts tests/updater.test.ts tests/settings-page.test.tsx`
    — verification: command output (pass count ≥ 1 per file, 0 failures).

56. Full TypeScript test suite exits 0: `npm test` — verification: command output (all
    vitest tests pass; report pass/fail counts in completion report). This is the
    closer-task rung-2 sweep; cross-stack rung 3 (`cargo test`) stays with the
    orchestrator.

57. Only the three owned test files are created or modified; no product code, Rust
    tests, or `.github/workflows/ci.yml` changes. — verification: `git diff --name-only`
    scoped to task write fence.

## verification_environment

library (vitest)

## out_of_scope

- Product-code changes (`src/**` except reading for assertions), including `App.tsx`
  launch-check integration tests (launch-check silence is covered via updater unit
  contract tests mirroring App branch logic — criterion 32–33).
- Rust / `cargo test` coverage (owned by task 01).
- CI workflow changes (`.github/workflows/ci.yml`).
- Editing existing test files (`tests/app-shell.test.tsx`, etc.) unless a pre-existing
  failure blocks `npm test` — if so, worker stops and reports escalation rather than
  editing out-of-fence tests.
- Cross-stack rung 3 (`npm test && cargo test …`) — orchestrator-owned.
- Real network, real Tauri runtime, real updater downloads, or real book/settings paths.

## pins (evaluator round 1 — orchestrator rulings)

1. **Launch-check silence (criteria 32–33)** — App integration is out of fence. Cover silence by duplicating `App.tsx` `triggerUpdateCheckOnce` branch logic in `tests/updater.test.ts`: `onAvailable` runs only when `result.status === "available"`; `"up-to-date"` and `"error"` (including `kind: "offline"`) do not invoke it and must not set an error-UI flag. Optional `console.warn` on error is not asserted. `tests/app-shell.test.tsx` already proves non-blocking startup. APPROVED.
2. **`updateSettings` non-backup keys** — thin direct tests of `bookPath` / `defaultYear` patches **or** an audit justification in the completion-report table (criterion 53). Either is acceptable. APPROVED.
3. **Type-only exports** — `BackupInfo`, `ScheduledBackupOutcome`, `ScheduledBackupDeps`, `CheckForUpdateResult`, `UpdateErrorKind`, `DownloadProgress`, `DownloadAndInstallResult`, `RelaunchResult`, `UpdaterDeps`, `BackupPreferences`, `AppSettings` may be justified as implicitly covered by function tests that construct/assert those shapes. Each named type must still appear in the criterion-53 audit with the covering test id. APPROVED.
4. **Pre-existing `npm test` failures** — STOP and escalate; never edit out-of-fence tests (`tests/app-shell.test.tsx`, etc.). APPROVED.
5. **`window.location.reload` success path** — may be stubbed or justified (jsdom constraint). Criterion 41 still requires a stub on the restore **failure** path to prove reload is not called. APPROVED.
6. **`listBackups` refresh-on-mount** — implicitly covered when restore-list rendering (criterion 38) shows mocked `listBackups()` entries after mount. No dedicated mount-only case required. APPROVED.
7. **Criterion 13 call shape (surface pin)** — `ScheduledBackupDeps.backupNow` is `(retention: number) => Promise<BackupInfo>`. Assert `deps.backupNow` was called with the positional number `settings.backups.retention`, not `{ retention }`. The object `{ retention }` is only the `invoke("backup_now", { retention })` payload in criterion 17.
8. **Busy-guard file (surface pin)** — relaunch busy-guard is `SettingsPage` UI on `appBusy` + internal `updateInstalled` (criteria 51–52), not `src/updater.ts`. Drive it by completing a mocked download/install, then render with `appBusy={true|false}`. Task-file listing under `tests/updater.test.ts` is not law; both files are in fence.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # test-writer, proposing
    agreed: true
    timestamp: 2026-08-24T17:50:00-04:00
    note: Achievable within fence (three test files only); launch-check silence via updater contract tests mirroring App branches; settings backup surface covered in backup.test.ts with mocked store.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T18:30:00-04:00
    note: Counter-signed round 1. Six orchestrator rulings plus two surface pins (positional backupNow vs invoke payload; busy-guard on SettingsPage appBusy). No revision.
revision: 0
```
