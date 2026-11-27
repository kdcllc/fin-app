# Contract: 04-updater-ui

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

04-updater-ui

## done_definition

A new `src/updater.ts` module wraps `@tauri-apps/plugin-updater` and
`@tauri-apps/plugin-process` behind injectable plugin dependencies and a typed result
API (`checkForUpdate`, `downloadAndInstall` with byte progress, `relaunch`). `App.tsx`
maintains a minimal app-busy boolean (import commit or backup restore in flight),
fires a quiet post-book-open update check that never blocks opening or auto-downloads,
and shows a dismissible notice when an update is available. `SettingsPage.tsx` gains an
additive **Updates** section (alongside the existing Backups section from task 02) with
current version from the Tauri app API, manual check/download/restart UX honoring the
busy-guard, and inline up-to-date/error states. `ImportPage.tsx` gains an optional
`onBusyChange` callback around commit only. Existing tests
`tests/import-review-ui.test.tsx` and `tests/app-shell.test.tsx` remain **unchanged** and
pass; this task proves behavior via `npm run typecheck`, `npm run lint`, and code
inspection — dedicated updater/settings tests are task 06. No Rust, CI, or `src/core`
changes.

## acceptance_criteria

### `src/updater.ts` — module surface and plugin injection

1. `src/updater.ts` exists and is the sole application import site for
   `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` (UI files import from
   `./updater`, not the plugins directly). — verification: code inspection —
   `git grep -E '@tauri-apps/plugin-(updater|process)' src -- ':!src/updater.ts'`
   returns no matches.

2. Plugin objects are injectable/mockable via a dependency object (same pattern as
   `ScheduledBackupDeps` in `src/backup.ts`): a `UpdaterDeps` (or equivalent) type holds
   the updater `check`/`downloadAndInstall` surface and process `relaunch`, with a
   module-level default binding to the real plugins and an optional `deps` parameter on
   exported functions so vitest can run without the Tauri runtime. — verification: code
   inspection of exported types and default deps; full mock tests deferred to task 06
   (`tests/updater.test.ts`, out of scope here).
    evaluator-note (pin e): Default plugin binding may be eager (module-level, matching
    `ScheduledBackupDeps`) or lazy/dynamic import so vitest can load `App`/`ImportPage`
    without plugin side effects. If static `@tauri-apps/plugin-updater` /
    `plugin-process` / `@tauri-apps/api/app` imports break
    `tests/app-shell.test.tsx` or `tests/import-review-ui.test.tsx` at module load, the
    worker STOPS and reports (escalation) — do not edit those tests. See criteria 20/36.

3. `checkForUpdate(deps?)` returns a discriminated union (no thrown errors to callers):
   - `{ status: "available"; version: string; notes: string; date: string }` when the
     plugin reports a newer version (map plugin `body` → `notes`, plugin `date` → ISO
     string).
   - `{ status: "up-to-date" }` when the plugin returns no update.
   - `{ status: "error"; kind: …; message: string }` with a typed `kind` that includes
     at least `"offline"` (network unreachable / fetch failure) and `"unknown"` (or
     equivalent catch-all); other kinds optional but errors must never be bare
     `throw`. — verification: code inspection of return types and mapping branches;
   `npm run typecheck`.
    evaluator-note (pin d): Error-kind mapping is implementer freedom. The `kind` union
    MUST include `"offline"` or an equivalent network discriminator plus a catch-all
    (`"unknown"` or equivalent). Other kinds optional.

4. `downloadAndInstall(onProgress, deps?)` invokes the plugin download/install path and
   calls `onProgress` with byte counts `{ downloaded: number; total: number | null }`
   (or equivalent) as chunks arrive; resolves on success; returns `{ status: "error"; … }`
   on failure without throwing. — verification: code inspection of callback wiring and
   return type; `npm run typecheck`.

5. `relaunch(deps?)` delegates to `@tauri-apps/plugin-process` `relaunch()`; failures
   surface as a typed error result or rejected promise only when explicitly invoked by
   user action (not during launch check). — verification: code inspection.

6. `getAppVersion(deps?)` (or equivalent exported helper) reads the installed version
   from `@tauri-apps/api/app` `getVersion()` — not from `package.json`, not a string
   literal. — verification: code inspection — no hardcoded version constant in
   `src/updater.ts` or `SettingsPage.tsx`; import from `@tauri-apps/api/app`.

7. Updater module does not import from `src/core` and contains no SQL or money types.
   — verification: code inspection of `src/updater.ts` imports.

### Busy-guard — App state, ImportPage, restore

8. `App.tsx` maintains a boolean app-busy signal (e.g. `appBusy` state) representing
   “import commit or backup restore in progress”. — verification: code inspection of
   `App.tsx` state and setter.

9. `ImportPage` props include optional `onBusyChange?: (busy: boolean) => void`; when
   provided, `commitImport()` calls `onBusyChange(true)` immediately before the
   `commitReviewedImport(...)` call and `onBusyChange(false)` in a `finally` block when
   commit settles (success or failure). When omitted, behavior is unchanged from
   pre-task-04. — verification: code inspection of `commitImport`; regression —
   `npx vitest run tests/import-review-ui.test.tsx` exit 0 with the test file
   **unchanged** (no edits to that file in this task).

10. `App.tsx` passes `onBusyChange` into `ImportPage` and wires it into the app-busy
    signal. — verification: code inspection of `<ImportPage … />` props in `App.tsx`.

11. Backup restore busy: when the user confirms restore in Settings, the app-busy signal
    becomes `true` before the restore invoke and returns to `false` on settle (success
    path may reload before `false`, but must set `true` before the async restore starts;
    failure path must clear busy). Wiring lives in the write fence — either
    `SettingsPage` accepts optional `onBusyChange` from `App` around
    `handleRestoreConfirm`, or an equivalent mechanism within owned files. —
    verification: code inspection of restore confirm handler and App wiring.
    evaluator-note (pin a): Restore busy wiring via an optional callback prop on
    SettingsPage mirroring ImportPage's `onBusyChange` is APPROVED. Prop naming is free.
    Set busy `true` before the restore invoke; clear busy on failure. Success may reload
    the window without clearing.

12. While `appBusy` is `true`, the Settings Updates restart prompt shows a
    “finish current work first” message (or equivalent copy from the task) and does **not**
    offer a relaunch/restart button; when `appBusy` is `false` after a successful
    download+install, a restart/relaunch control is shown. — verification: code
    inspection of Settings Updates JSX branching on `appBusy` (passed from App or derived
    from shared busy signal); manual evidence at QA gate (screenshot with mock busy
    state).
    evaluator-note (pin b): How Settings learns app-busy is implementer freedom (prop
    from App, or equivalent within the write fence). The wiring MUST be inspectable in
    owned files.

13. `relaunch()` is never invoked automatically — only from explicit user click on the
    restart control after download+install completes. — verification: code inspection —
    no `relaunch()` call in `useEffect`, launch check, or download completion handlers
    without a user-event handler.

### Launch check — `App.tsx` (post book open)

14. After a successful book open (`phase.kind === "ready"`), App triggers a background
    update check once per session entry to ready (same “fire once” spirit as
    `triggerScheduledBackupOnce`; re-entry after first-run choice counts as its own
    session start). The check runs **after** the book is open — it must not delay or
    gate the transition to `ready`. — verification: code inspection — launch check is
    scheduled from the ready path (e.g. alongside or after scheduled backup), not awaited
    before `setPhase({ kind: "ready", … })`.
    evaluator-note (pin c): Once-per-session guard style mirroring
    `triggerScheduledBackupOnce` (module-level flag, fire-and-forget after ready) is
    APPROVED. Re-entry after first-run choice counts as its own session start.

15. When `checkForUpdate()` returns `{ status: "up-to-date" }`, no UI notice is shown
    (silent). — verification: code inspection — no banner state set on up-to-date;
    manual evidence at QA gate optional.

16. When `checkForUpdate()` returns `{ status: "error", … }` (including offline/network
    failure), no blocking UI is shown; at most a `console` log/warn. Book remains usable.
    — verification: code inspection of error branch; no `setPhase({ kind: "error" })` or
    modal on updater failure.

17. When `checkForUpdate()` returns `{ status: "available", … }`, App shows a
    non-blocking dismissible banner/notice in the main content area (reuse or extend the
    existing notices pattern used for `backupNotice`) that informs the user an update is
    available and points them to **Settings → Updates** (e.g. “Go to Settings” button or
    link copy). — verification: code inspection of banner JSX and dismiss control;
    manual evidence at QA gate (screenshot).

18. Launch check never calls `downloadAndInstall` or `relaunch` — discovery only. —
    verification: code inspection of launch-check code path.

19. Updater failure during launch check cannot prevent the book from opening: `openBook`
    success path is unchanged; launch-check promise rejections are caught/swallowed. —
    verification: code inspection — `.catch` or result-status handling on launch check;
    `npx vitest run tests/app-shell.test.tsx` exit 0 with the test file **unchanged**.

20. Launch-check and banner logic must not require new mocks in existing tests (failures
    routed internally so vitest without updater mocks still passes). — verification:
    `npx vitest run tests/app-shell.test.tsx tests/import-review-ui.test.tsx` exit 0,
    both test files unmodified.

### Settings **Updates** section — `SettingsPage.tsx`

21. An additive `<h2>Updates</h2>` (or equivalent) section appears in Settings **below or
    after** the existing Backups section; Book and Defaults sections remain intact. —
    verification: code inspection; manual evidence at QA gate (screenshot of full
    Settings page showing Backups + Updates).

22. **Current version** displays the value from `getAppVersion()` / `@tauri-apps/api/app`
    `getVersion()` on mount or section load — not hardcoded `0.1.1` or `package.json`. —
    verification: code inspection — async load or effect calling updater helper; QA
    screenshot shows a version string.

23. A **“Check for updates”** button triggers `checkForUpdate()`; while the check is
    in-flight the button shows a spinner or disabled “Checking…” state (consistent with
    backup-busy patterns on the same page). — verification: code inspection; manual
    evidence at QA gate.

24. **Up-to-date** state: after check returns up-to-date, an inline message (e.g. “You’re
    up to date”) renders in the Updates section without modal or app-wide blocking. —
    verification: code inspection; manual evidence at QA gate.

25. **Available** state: after check returns available, the section shows the new
    `version`, `notes` (release notes body), and `date`; a **“Download and install”**
    (or equivalent) button starts `downloadAndInstall(onProgress)`. — verification: code
    inspection; manual evidence at QA gate.

26. **Downloading** state: while download runs, a progress bar (or `<progress>`) reflects
    byte progress from `onProgress` (`downloaded` / `total` when known). — verification:
    code inspection of progress state binding; manual evidence at QA gate.

27. **Post-download** state: after successful install, show restart prompt per criterion
    12 (honors busy-guard). — verification: code inspection + QA screenshot.

28. **Error** state: check or download errors render inline in the Updates section (typed
    message from `{ status: "error", message }`); no app-wide blocking modal. —
    verification: code inspection; manual evidence at QA gate.

29. Updates UX never blocks navigation: sidebar remains clickable; user can leave Settings
    during check/download; in-flight operations may show section-local busy state but must
    not disable the whole app shell. — verification: code inspection — no global overlay
    or `phase` gate on update operations.

30. All interactive controls in the Updates section are keyboard-reachable (`button`,
    `progress` labels) and use existing Settings styling (`section.page`, `field`, `muted`,
    `error`, primary buttons). — verification: code inspection of markup/classes; QA
    keyboard spot-check deferred to QA gate.

31. Settings Updates section does not import `@tauri-apps/plugin-updater` or
    `@tauri-apps/plugin-process` directly — only `./updater` (or relative re-export). —
    verification: code inspection of `SettingsPage.tsx` imports.

### Constraints and non-regression

32. No auto-install without explicit user click on “Download and install” (launch and
    Settings check paths). — verification: code inspection across `App.tsx` and
    `SettingsPage.tsx`.

33. No edits to `src/core/**`, `src-tauri/**`, CI workflows, or `tests/updater.test.ts`.
    — verification: `git diff --name-only` scoped to task fence files only.

34. `npm run typecheck` exits 0. — verification: command output.

35. `npm run lint` exits 0. — verification: command output.

36. Targeted regression: `npx vitest run tests/import-review-ui.test.tsx
    tests/app-shell.test.tsx` exits 0 with both files unchanged from pre-task-04
    content. — verification: command output + `git diff tests/import-review-ui.test.tsx
    tests/app-shell.test.tsx` empty.

## verification_environment

library (vitest for unchanged regression tests) + manual evidence at QA gate (Settings
Updates section screenshot covering idle, available+notes, progress, up-to-date, error,
and busy-guard restart deferral)
evaluator-note (pin f): Visual/screenshot evidence listed on criteria 12, 17, 21–28, 30
is deferred to the QA gate (same precedent as task 02). This task proves via typecheck,
lint, unchanged vitest, and code inspection.

## out_of_scope

- Rust commands, `src-tauri/**`, `tauri.conf.json`, capabilities, or plugin registration
  (task 03 — already done).
- CI/release workflow, `latest.json` publishing, signing key handling (task 05).
- New or modified test files: `tests/updater.test.ts`, `tests/settings-page.test.tsx`,
  `tests/backup.test.ts` (task 06 owns dedicated updater/settings coverage).
- Changes to `tests/import-review-ui.test.tsx` or `tests/app-shell.test.tsx` (must pass
  unchanged; if impossible, worker stops and reports — no test edits in this task).
- `src/core/**`, `src/settings.ts`, `src/backup.ts` (read-only interfaces).
- Auto-download on launch, silent background install, delta updates, downgrade flows,
  release channels.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # implementer, proposing
    agreed: true
    timestamp: 2026-08-24T14:20:00-04:00
    note: Achievable within fence (src/updater.ts, SettingsPage, App, ImportPage); restore busy via SettingsPage callback prop mirrors ImportPage pattern.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T15:00:00-04:00
    note: Counter-signed with pins — restore busy callback approved (naming free); Settings learns app-busy inspectably; once-per-session mirrors triggerScheduledBackupOnce; kind includes offline; plugin-import test breakage → stop/report not test edits; screenshots at QA gate. Existing tests must pass unchanged.
revision: 0
```
