# Task 05.3 — Transaction import → payments

Status: todo

## Objective

Import GnuCash transactions from mapped accounts as fin-app payments (source=`gnucash`, external_ref=GnuCash transaction GUID), through the same review-before-commit flow as the Excel importer.

## Notes

- Dedup on external_ref: re-import never duplicates; changed transactions (same GUID, different data) flagged as updates.
- Payee matching from GnuCash description → fin-app payees (reuse Task 02.3 normalization; suggest, don't auto-create silently).
- Category comes from the mapped EXPENSE account of the expense split.
- Cross-source dedup: a bill entered manually AND imported from GnuCash should match up (same account, date ±n days, amount) → offer merge, not duplicate.

## Acceptance criteria

- Fixture book imports fully; re-import is a no-op.
- Manual payment + matching GnuCash transaction → merge suggestion appears.
