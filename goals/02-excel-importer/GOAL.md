# Goal 02 — Excel Migration Importer

**Milestone:** v0.1 · **Depends on:** Goal 01

## Objective

One-time (but re-runnable) importer that converts `2026-bill-pay.xlsx` — and prior/future year workbooks with the same payee × month layout — into clean `payments` records, with a review step before anything is committed.

## Source format (from research §2)

- One sheet per year (sheet name = year, e.g. `2025`); row 1 = month headers Jan–Dec.
- Rows = payees; cells = free text like `01/08 $48.58` (date + amount); some cells contain a second payment.
- Payment account is embedded in the payee name: `9002 (ExampleBank Personal Checking)`, `pay w/CardOne`, etc.

## Success criteria

- Deterministic fixture import succeeds end-to-end: for a committed fixture workbook under `tests/fixtures/excel/`, every non-empty data cell is accounted for such that `parsed_records + unparsed_records == non_empty_data_cells`.
- Zero silent drops invariant is enforced in code and tests: any non-empty cell that does not parse is emitted in `unparsed` with source coordinates (`sheet`, `row`, `col`).
- Review screen enforces pre-commit integrity: commit remains disabled while unresolved unparsed cells exist, and no DB writes occur until final commit.
- Commit path is atomic: payees/accounts/categories/payments/import_log rows are persisted in a single transaction or not at all.
- Idempotent re-import is deterministic with fixtures: importing the same workbook content twice produces zero new `payments` rows on the second run; importing a fixture variant with one additional valid cell proposes exactly one new payment.
- Real workbook smoke check is optional and non-gating; fixture-based checks are the required gate for completion.

## Layer ownership

- Schema/migrations + TS core own import session bookkeeping, dedup policy, and transaction boundaries.
- Rust commands own xlsx file reading only (raw cell extraction and typed error mapping), keeping backend logic thin.
- TS core owns cell parsing and payee normalization heuristics so behavior is unit-testable in Vitest.
- UI owns review/edit workflows and commit gating.
- GnuCash read/write is explicitly out of scope for Goal 02 and deferred to Goals 05-06.

## Tasks

Execution order (must follow project invariant): Schema/migrations -> TS core -> Rust commands -> UI -> Tests

1. [Import session schema & idempotency core contract](tasks/05-import-idempotency.md)
2. [Cell parser for "MM/DD $amount" values (TS core)](tasks/02-cell-parser.md)
3. [Payee normalization & account-hint extraction (TS core)](tasks/03-payee-normalization.md)
4. [Rust xlsx reader with calamine](tasks/01-calamine-reader.md)
5. [Review-before-commit import UI](tasks/04-review-ui.md)
6. [Importer fixtures and automated test coverage](tasks/06-importer-tests.md)
