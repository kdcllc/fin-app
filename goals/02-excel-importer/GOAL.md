# Goal 02 — Excel Migration Importer

**Milestone:** v0.1 · **Depends on:** Goal 01

## Objective

One-time (but re-runnable) importer that converts `2026-bill-pay.xlsx` — and prior/future year workbooks with the same payee × month layout — into clean `payments` records, with a review step before anything is committed.

## Source format (from research §2)

- One sheet per year (sheet name = year, e.g. `2025`); row 1 = month headers Jan–Dec.
- Rows = payees; cells = free text like `01/08 $48.58` (date + amount); some cells contain a second payment.
- Payment account is embedded in the payee name: `9002 (ExampleBank Personal Checking)`, `pay w/CardOne`, etc.

## Success criteria

- Importing the real workbook produces correctly parsed payments (date, amount, payee, account hint) with zero silent drops — unparseable cells are surfaced for manual fix, never skipped quietly.
- Review screen lets the user correct payee/account/category assignments before commit.
- Re-importing the same file creates no duplicates (import log + content hash dedup).

## Tasks

1. [Rust xlsx reader with calamine](tasks/01-calamine-reader.md)
2. [Cell parser for "MM/DD $amount" values](tasks/02-cell-parser.md)
3. [Payee normalization & account-hint extraction](tasks/03-payee-normalization.md)
4. [Review-before-commit import UI](tasks/04-review-ui.md)
5. [Import log & idempotent re-import](tasks/05-import-idempotency.md)
