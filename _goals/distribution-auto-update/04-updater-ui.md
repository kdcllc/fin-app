# Task 04: updater-ui

## Objective

The in-app update experience: a `src/updater.ts` module wrapping the updater plugin
(check, download-with-progress, install, busy-guard) and its UI — a quiet launch check
and a "Check for updates" section in Settings with version info, release notes,
progress, and a restart prompt that defers to in-flight work.

## Dependencies

- 02-backup-settings-ui (serializes `SettingsPage.tsx`/`App.tsx`), 03-updater-config
  (plugin available)

```yaml
# --- task ownership contract ---
writes:
  - src/updater.ts
  - src/pages/SettingsPage.tsx   # updates section
  - src/App.tsx                  # quiet launch check + busy-state signal
  - src/pages/ImportPage.tsx     # optional onBusyChange callback around commit only
reads:
  - src-tauri/tauri.conf.json
  - src/backup.ts
depends_on:
  - "02-backup-settings-ui"
  - "03-updater-config"
owner: implementer
rewrite_semantics: targeted-insertion
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `src/updater.ts` wraps `@tauri-apps/plugin-updater` +
      `@tauri-apps/plugin-process`: `checkForUpdate()` → available
      (version, notes, date) / up-to-date / error (typed, incl. offline);
      `downloadAndInstall(onProgress)` reporting byte progress; `relaunch()`. The
      plugin objects are injected/mockable so tests run without the Tauri runtime.
- [ ] Busy-guard: a minimal app-busy signal (import commit or restore in progress)
      exposed from App state; while busy, the restart prompt is replaced by "finish
      current work first" and relaunch is not offered. `ImportPage` gains an OPTIONAL
      `onBusyChange?: (busy: boolean) => void` prop, called `true` immediately before
      the commit call and `false` when it settles — optional so
      `tests/import-review-ui.test.tsx` keeps passing unchanged; App wires it (and the
      restore flow's equivalent) into the busy signal.
- [ ] Launch check in `App.tsx` after book open: silent on up-to-date, silent on
      network failure (console-level log at most); when an update exists, a
      non-blocking dismissible banner/notice points to Settings → Updates. Never
      auto-downloads on launch.
- [ ] Settings "Updates" section: current version (from app, not hardcoded),
      "Check for updates" button with spinner; when available — new version + release
      notes, "Download and install" with progress bar, then restart prompt honoring
      the busy-guard; up-to-date and error states rendered inline.
- [ ] No update flow ever interrupts or blocks normal app usage; all states
      keyboard-reachable and consistent with existing Settings styling.

## Files to Read

- `src/pages/SettingsPage.tsx`, `src/App.tsx` — post-task-02 shapes
- `src/pages/ImportPage.tsx` — the commit call site gaining `onBusyChange`
- `tests/import-review-ui.test.tsx`, `tests/app-shell.test.tsx` — must keep passing
  UNCHANGED: launch hooks and the optional prop must swallow/route failures so no new
  mocks are needed (if that proves impossible, stop and report — do not edit tests)
- `_goals/distribution-auto-update/goal.md` — discovery decisions (launch + manual
  check; never restart mid-import)

## Files to Create / Change

- Exactly the ownership contract's write set; SettingsPage/App edits additive.

## Constraints

- Must: keep the launch path resilient (updater failure can never prevent the book
  from opening); version string sourced from the Tauri app API.
- Must NOT: auto-install without user action, restart while busy, touch `src/core`,
  Rust files, or CI.

## Verification

- Targeted test command: `npx vitest run tests/updater.test.ts` (written in task 06;
  during this task: `npm run typecheck` + `npm run lint`)
- Manual evidence: Settings screenshot of the Updates section (mock/dev state ok).
