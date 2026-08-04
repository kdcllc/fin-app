# Task 08.4 — UI wiring: book open flow & commit progress

Status: done

## Objective

The app shell opens the book through the new `open_book` command, and the import review screen (`src/pages/ImportPage.tsx`) reflects the new stage-based commit: a determinate-feeling progress presentation for annotate/build stages, an indeterminate "committing" state for the single atomic batch, and honest error surfacing — a failed commit says so and shows the mapped error, never a false success.

## Notes

- Layer(s) touched: ui.
- Book file management flow (first-run picker, settings `bookPath`, restart-to-switch rule) keeps its current UX; only the underlying command changes (`register_book` → `open_book`).
- Commit gating rules are unchanged: commit disabled while unresolved unparsed cells or undecided potential duplicates exist; no DB writes before final commit.
- Progress UI consumes the `on_progress` stage contract defined in 08.3. Show stage labels and row totals (e.g. "Preparing 1,240 payments…", "Writing to database…"); do not fabricate per-row progress during the batch.
- Success state shows the commit result counts (inserted / skipped exact / skipped potential) sourced from `ReviewedImportCommitResult`.
- `DatabaseLockedError` messaging stays, but the stale "another app window" lock advice should be revisited: with the single-connection backend the realistic cause is an external SQLite tool holding the file.
- After commit, navigating to payment views must show the imported rows without an app restart (repositories read through the same single connection).

## Acceptance criteria

- Existing `tests/import-review-ui.test.tsx` suite passes, updated only where the progress contract changed.
- A commit failure injected at the adapter level renders an error state (no success message, no cleared review state) and the review rows remain editable for retry.
- Manual dev-loop smoke (documented in the completion report with output): pick fixture workbook → review → commit → payments visible in UI → restart app → payments still visible.
- `npm test` and `npm run lint` are green.
