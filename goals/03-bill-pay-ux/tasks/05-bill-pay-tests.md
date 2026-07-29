# Task 03.5 — Bill-pay UX fixtures and automated tests

Status: todo

## Objective

Add fixture data and automated tests that close Goal 03 with reproducible verification of CRUD, quick-add/edit flows, grid totals, and recurring dashboard classification.

## Notes

- Use fixture data and temp DBs only; no user-private workbook or live data.
- Cover TS core query/classification logic with Vitest.
- Cover critical UI behavior with interaction tests for keyboard-first quick-add and grid/dashboard refresh behavior.
- Keep money assertions in integer cents.

## Acceptance criteria

- Fixture dataset(s) for Goal 03 scenarios are committed and documented under `tests/fixtures/`.
- Core tests verify CRUD/archive/merge behavior, including referential integrity outcomes.
- Core tests verify grid totals, month bucketing, and recurring due/paid/overdue classification against exact expected fixture outputs.
- UI tests verify keyboard-first quick-add, edit/delete refresh behavior, and user-facing error states.
- Re-running tests is deterministic and does not require external services or user-local files.
