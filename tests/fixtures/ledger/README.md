# Ledger test scenarios

Scenarios used by the cross-cutting ledger-core suites. **All payees, accounts,
categories, GUIDs and last-4 values are placeholders** (for example "Payee One",
"Checking A", last-4 "0001"); no real bill, bank or GnuCash data is used. All
databases are in-memory SQLite.

## `tests/core/ledger-migration.test.ts` (v8 -> v9 fidelity)

A v8 book is seeded with raw SQL (the v8 schema has no ledger facades), then
`applyRemainingMigrations()` runs 0009. Seeded shapes:

- payments: a zero-amount payment, a negative (refund) payment, a NULL-category
  payment, a very large amount, two xlsx payments with sheet/row/col coordinates
  and occurrence indexes (same business key), two gnucash payments with `external_ref`
- categories: a three-level chain (Housing > Utilities > Electric), an archived
  category, categories with and without `gnucash_guid`, non-contiguous ids
- accounts: all three kinds (checking, credit, cash), an archived account,
  accounts with and without `gnucash_guid`/`last4`, non-contiguous ids
- payees with default category/account, notes and an archived payee
- `recurring_bills`, a suggestion dismissal, an `import_log` row,
  `payment_exports` and `gnucash_matches` rows (the last two are dropped by 0009)

## `tests/core/ledger-invariants.test.ts` (balancing invariant)

Two fixed PRNG seeds drive 250 random operations each over a small tree
(placeholder bank group, savings, cash, card, two income and four expense
accounts): post, update, delete, transfer, income, opening balance, and
deliberately rejected attempts (unbalanced post/update, placeholder account,
unknown account, self-transfer). The seed, operation index and kind appear in
any failure message.

## `tests/core/report-parity.test.ts` (report parity)

`tests/fixtures/report/reporting-fixture.json` plus four extra rows (a refund,
a zero amount, a nested-category payment, a 2027 uncategorized payment) are
seeded at v8. Expected rows are computed with SQL over the legacy
`payments`/`categories` tables for every dimension and grain across several
windows and filters, then compared with `runReportQuery` after migration
(category keys mapped through `legacy_category_map`).
