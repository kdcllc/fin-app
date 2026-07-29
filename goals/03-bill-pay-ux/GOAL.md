# Goal 03 — Bill-Pay Core UX

**Milestone:** v0.1 · **Depends on:** Goal 01, Goal 02

## Objective

Replace the spreadsheet's daily job: record bill payments quickly, see the familiar payee × month grid, and know what's due and unpaid this month.

## Success criteria

- Quick-add flow is keyboard-first and deterministic: with fixture defaults loaded, a payment can be saved via keyboard-only interaction in <= 5 field actions plus amount entry, and DB rows reflect selected overrides.
- Grid view reproduces payee x month layout for fixture data (payees down, Jan-Dec across, one year) with deterministic row/column totals and editable underlying payment records.
- Dashboard classifies due/paid/overdue deterministically from recurring-bill fixtures, including monthly, quarterly, and annual schedules with tolerance handling.
- All acceptance checks are fixture-based and reproducible with temp DBs; no user-private workbook data is required.

## Layer ownership and execution order

- No schema migration is expected for this goal unless implementation reveals a concrete gap; if needed, migration work must be added before core changes.
- TS core owns CRUD/query/classification logic and all SQL access.
- Rust command layer is not expected to change for this goal.
- UI layer owns interaction flows and rendering only.
- Tests task is mandatory and closes the goal.

## Phase 1 discovery decisions (recorded)

- Problem focus: replace spreadsheet-era payment entry and review flow with keyboard-first UX backed by persisted records.
- Touched layers: TS core + UI only by default; schema and Rust are no-op unless an explicit gap is discovered.
- Data model impact: payees, accounts, categories, payments, recurring_bills.
- GnuCash scope: no GnuCash read/write changes in Goal 03.
- Error behavior: validation, archive/merge conflicts, and query empty states must be explicit user-facing messages (no raw exceptions).
- Priority order: entity CRUD -> payment entry -> grid -> recurring dashboard -> tests.

## Tasks

Execution order (must follow project invariant): Schema (if needed) -> TS core -> Rust (if needed) -> UI -> Tests

1. [Payee, account & category management (CRUD)](tasks/01-entity-crud.md)
2. [Payment quick-add & edit](tasks/02-payment-entry.md)
3. [Bill-pay grid view (payee × month)](tasks/03-grid-view.md)
4. [Recurring bills & due-this-month dashboard](tasks/04-recurring-dashboard.md)
5. [Bill-pay UX fixtures and automated tests](tasks/05-bill-pay-tests.md)
