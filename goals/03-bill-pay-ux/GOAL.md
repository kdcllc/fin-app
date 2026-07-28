# Goal 03 — Bill-Pay Core UX

**Milestone:** v0.1 · **Depends on:** Goal 01

## Objective

Replace the spreadsheet's daily job: record bill payments quickly, see the familiar payee × month grid, and know what's due and unpaid this month.

## Success criteria

- A payment can be recorded in under 10 seconds (quick-add with payee defaults).
- Grid view reproduces the spreadsheet layout (payees down, months across, current year) but is backed by real records — clicking a cell shows/edits the underlying payments.
- Dashboard answers "what's due this month and what haven't I paid yet?" from recurring-bill definitions.

## Tasks

1. [Payee, account & category management (CRUD)](tasks/01-entity-crud.md)
2. [Payment quick-add & edit](tasks/02-payment-entry.md)
3. [Bill-pay grid view (payee × month)](tasks/03-grid-view.md)
4. [Recurring bills & due-this-month dashboard](tasks/04-recurring-dashboard.md)
