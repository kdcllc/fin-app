# Task 04.1 — Report query engine over SQLite

Status: todo

## Objective

Aggregate queries in the core layer powering every report: totals by category/payee/account, grouped by month/quarter/year, over arbitrary date windows (calendar year, trailing 12 months, all time).

## Notes

- One parameterized query builder (dimension × grain × window × filters) rather than a query per report.
- Return shape: `{groupKey, periodKey, total_cents, count}` rows — chart and table both render from it.
- Verify indexes from Task 01.2 cover these queries (EXPLAIN QUERY PLAN); add covering indexes if needed.

## Acceptance criteria

- Unit tests with seeded multi-year data verify totals, YoY grouping, and window edges (Dec→Jan, leap day).
- 5 years × ~50 payments/month synthetic data: any report query < 100 ms.
