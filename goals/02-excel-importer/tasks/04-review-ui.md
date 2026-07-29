# Task 02.4 — Review-before-commit import UI

Status: todo

## Objective

Import wizard: pick file → preview parsed payments in an editable table (payee, account, category, date, amount) with unparsed cells flagged → user fixes/confirms → commit writes payees/accounts/categories/payments in one DB transaction.

## Notes

- Show source coordinates (sheet/row/col) per record so the user can cross-check against Excel.
- Bulk actions: assign category to all rows of a payee, merge duplicate payees.
- Nothing touches the DB until the final commit click; commit is atomic.
- Commit button state is derived from validation state: disabled when unresolved unparsed rows exist.

## Acceptance criteria

- Happy path is validated with fixture workbook(s): file -> review -> commit -> payments visible in the app.
- Unparsed cells must be resolved (fixed or explicitly skipped) before commit is enabled.
- Before commit action, DB table counts remain unchanged during file load, parse, edit, resolve/skip, and dedup-review interactions.
- Rows flagged by core as `potential_duplicate` are surfaced in review with explicit keep/skip decisions prior to commit.
- Import commit executes a single transaction for payees/accounts/categories/payments/import_log and rolls back fully on failure.
- Optional smoke check with the real workbook is allowed but non-gating.
