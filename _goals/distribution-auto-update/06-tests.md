# Task 06: tests

## Objective

TypeScript test coverage for the distribution feature's UI-side logic: backup wrapper
scheduling and outcome mapping, settings shape migration, the Settings page backup and
updates sections, and the updater module's state machine — all with the Tauri surfaces
mocked (Rust behavior is already covered by task 01's cargo tests).

## Dependencies

- all implementation tasks (01–05)

```yaml
# --- task ownership contract ---
writes:
  - tests/backup.test.ts
  - tests/updater.test.ts
  - tests/settings-page.test.tsx
reads:
  - src/backup.ts
  - src/updater.ts
  - src/settings.ts
  - src/pages/SettingsPage.tsx
  - src/App.tsx
depends_on:
  - "01-backup-rust"
  - "02-backup-settings-ui"
  - "03-updater-config"
  - "04-updater-ui"
  - "05-release-workflow"
owner: test-writer
rewrite_semantics: whole-file
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `tests/backup.test.ts`: settings default/migration behavior (old
      `{ enabled }`-only store loads with new defaults); `runScheduledBackupIfDue` —
      due by null `lastBackupAt`, due by age, not due, disabled, failure surfaces as
      non-throwing outcome; wrapper calls mocked invoke with correct args.
- [ ] `tests/updater.test.ts`: `checkForUpdate` mapping for available / up-to-date /
      network-error; download progress callback wiring; busy-guard — relaunch not
      offered while busy, offered after; launch-check silence on error/up-to-date.
- [ ] `tests/settings-page.test.tsx`: backup section renders location/retention/last
      time from settings; backup-now success + failure feedback; restore flow requires
      explicit confirmation and shows typed errors; updates section states (idle,
      checking, available with notes, downloading with progress, up-to-date, error);
      retention edit persists. Assert outcomes and persisted values, not just render.
- [ ] All Tauri plugins/invokes mocked (store, dialog, updater, process); no network,
      no real filesystem writes outside temp dirs; follows existing page-test patterns.
- [ ] Coverage audit in the completion report: every exported symbol of `src/backup.ts`,
      `src/updater.ts`, new `settings.ts` surface → covering test; gaps filled or
      justified.
- [ ] Full TS suite green: `npm test`.

## Files to Read

- `tests/app-shell.test.tsx`, `tests/reports-page.test.tsx` — mocking patterns
- `.claude/skills/test-ladder/SKILL.md` — rung discipline
- All task files 01–05 in `_goals/distribution-auto-update/`

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: mock all external surfaces; deterministic time handling (inject/fake timers
  for due-date math).
- Must NOT: modify product code, test the Rust side (cargo tests own it), or run the
  cross-stack rung 3 (`npm test && cargo test …`). Running the full Vitest suite
  (`npm test`) as this closer-task's rung-2 sweep is explicitly allowed.

## Verification

- Targeted test command: `npx vitest run tests/backup.test.ts tests/updater.test.ts tests/settings-page.test.tsx`
- Then rung 2: `npm test` — report pass/fail counts.
