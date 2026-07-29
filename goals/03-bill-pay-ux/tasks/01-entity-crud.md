# Task 03.1 — Payee, account & category management (CRUD)

Status: todo

## Objective

Management screens for the three core entities: payees (with default account/category), accounts (checking/credit/cash, last4), and categories (flat list, optional parent for grouping).

Core ownership: CRUD rules and archive eligibility checks are implemented in TS core repositories/services; UI only invokes typed operations and renders results.

## Notes

- Archive instead of delete once an entity has payments (referential integrity — no orphaned payments).
- Merge action for payees (importer will inevitably create near-duplicates).
- Error behavior must be explicit: duplicate/invalid inputs show user-facing validation messages; archive conflicts and merge failures return typed errors, never raw exceptions.
- Execution gate: TS core CRUD/archive/merge behaviors and typed errors must pass tests before UI screens are implemented.

## Acceptance criteria

- All three entities can be created, edited, archived; archived entities hidden from pickers but preserved in history/reports.
- Deleting is blocked when payments reference the entity; archive is the only allowed path for referenced entities.
- Payee merge operation reassigns referenced payments to the survivor payee and archives the merged source payee, with deterministic fixture-based verification.
