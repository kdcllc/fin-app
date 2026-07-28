# Task 02.4 — Review-before-commit import UI

Status: todo

## Objective

Import wizard: pick file → preview parsed payments in an editable table (payee, account, category, date, amount) with unparsed cells flagged → user fixes/confirms → commit writes payees/accounts/categories/payments in one DB transaction.

## Notes

- Show source coordinates (sheet/row/col) per record so the user can cross-check against Excel.
- Bulk actions: assign category to all rows of a payee, merge duplicate payees.
- Nothing touches the DB until the final commit click; commit is atomic.

## Acceptance criteria

- Full happy path works against the real workbook: file → review → commit → payments visible in the app.
- Unparsed cells must be resolved (fixed or explicitly skipped) before commit is enabled.
