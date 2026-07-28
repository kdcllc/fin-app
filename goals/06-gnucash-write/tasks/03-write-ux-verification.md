# Task 06.3 — Write UX, verification & rollback

Status: todo

## Objective

User-facing flow around the writer: select unpushed payments → preview exactly what will be written (accounts, splits, amounts) → confirm → write → post-write verification report.

## Notes

- Preview shows the double-entry effect per payment (debit Expenses:X / credit Assets:Y) so the user sees GnuCash's view before committing.
- Post-write verification: re-open the book read-only, re-read the inserted GUIDs, validate balance invariant, and show a written/verified summary.
- "Restore from backup" action listing the session backups from Task 06.1 (restore only allowed when gnclock is empty).
- This feature ships behind a settings toggle, default off — QIF export (Task 05.4) remains the default path.

## Acceptance criteria

- End-to-end on a fixture book: select → preview → write → verification passes → payments show external_ref.
- Restore-from-backup returns the book to its exact pre-write state (hash-verified).
