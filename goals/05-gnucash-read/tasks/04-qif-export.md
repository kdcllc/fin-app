# Task 05.4 — QIF/CSV export for GnuCash import

Status: todo

## Objective

The zero-risk reverse flow (research §4 tier 3): export selected fin-app payments as a QIF file that GnuCash 5.x's import assistant consumes with duplicate detection — no direct writes to the GnuCash book.

## Notes

- QIF per funding account (`!Account` header + `!Type:Bank`/`!Type:CCard`), date, amount (negative = money out), payee, category as GnuCash account path (`Expenses:Utilities:Electric`) from the mapping.
- Track exported payment ids (avoid re-offering already-exported payments; still allow forced re-export).
- Also plain CSV for GnuCash's CSV importer as an alternative.

## Acceptance criteria

- Exported QIF imports into a real GnuCash 5.x book with correct dates, amounts, accounts, and transfer categories — verified manually once against a copy of the user's book.
- Second export excludes already-exported payments by default.
