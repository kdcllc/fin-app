# Task 03.2 — Payment quick-add & edit

Status: todo

## Objective

Recording a payment must beat typing in a spreadsheet cell: quick-add form with payee picker that pre-fills account and category from payee defaults; date defaults to today; amount in a proper currency input.

Core ownership: default resolution, validation, and write logic stay in TS core; UI performs keyboard-first interaction and invokes typed core APIs.

## Notes

- Keyboard-first: open with a shortcut, tab through fields, Enter to save.
- Edit/delete existing payments from any list or grid context.
- Optional memo field (replaces the ad-hoc notes squeezed into spreadsheet cells).
- Error behavior: invalid amount/date/payee or save conflicts show actionable UI messages; no raw stack traces.
- Execution gate: TS core default-resolution, validation, and write/edit/delete behavior must pass tests before UI shortcut/interaction work is implemented.

## Acceptance criteria

- For fixture data with known payee defaults, keyboard-only quick-add saves a payment in <= 5 field actions plus amount entry (open shortcut, select payee, confirm account/category/date, enter amount, save).
- Payee defaults pre-fill correctly; changed values persist as the record, not as new defaults.
- Edit and delete from list/grid contexts update persisted records deterministically in fixture-backed tests.
