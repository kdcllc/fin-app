# Task 03.1 — Payee, account & category management (CRUD)

Status: todo

## Objective

Management screens for the three core entities: payees (with default account/category), accounts (checking/credit/cash, last4), and categories (flat list, optional parent for grouping).

## Notes

- Archive instead of delete once an entity has payments (referential integrity — no orphaned payments).
- Merge action for payees (importer will inevitably create near-duplicates).

## Acceptance criteria

- All three entities can be created, edited, archived; archived entities hidden from pickers but preserved in history/reports.
- Deleting is blocked (or converted to archive) when payments reference the entity.
