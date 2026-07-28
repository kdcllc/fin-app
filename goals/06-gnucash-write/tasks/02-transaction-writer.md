# Task 06.2 — Balanced transaction + splits writer

Status: todo

## Objective

Insert a fin-app payment into the GnuCash book as a proper double-entry transaction, honoring the data model exactly (research §4; piecash semantics as reference implementation).

## Per payment

- 1 row in `transactions`: new 32-hex GUID, book currency, post_date/enter_date, description = payee name.
- 2 rows in `splits`: EXPENSE account (mapped category) with positive value/quantity; funding account (mapped BANK/CREDIT) with negative — as numerator/denominator rationals with the commodity's fraction as denominator. **Sum of values = 0.**
- Never touch `slots` or `versions`; only `transactions`/`splits`.

## Notes

- All inserts for a batch inside the session's single SQL transaction (Task 06.1).
- Mark written payments (external_ref = new GnuCash GUID) so they're excluded from QIF export and future writes.
- Study piecash's `Transaction`/`Split` creation code for field-level details (num/denom handling, date formats — GnuCash stores dates as strings in specific formats; match exactly what GnuCash 5.x writes).

## Acceptance criteria

- Written transactions open in GnuCash with no Imbalance splits and no "check & repair" complaints, correct amounts/dates/accounts — verified against a fixture book copy.
- Values exact to the cent for amounts including edge cases ($10,673.91; $0.01).
