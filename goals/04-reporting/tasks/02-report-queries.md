# Task 04.2 — Report query engine + CSV

Status: done (judge PASS 4/5, 2026-08-16)
Depends on: 04.1

## Objective

A TS-core query engine returns integer-cent aggregates for the five Goal 04 reports, plus pure CSV formatters (RFC 4180, UTF-8 BOM) for report tables, raw-payment dumps, and year sheets. No UI in this task.

## Notes

- Layer(s) touched: ts-core. Follow `.claude/skills/tdd/SKILL.md` (red-green). Follow `.claude/skills/codebase-design/SKILL.md` for a small public module surface.
- SQL lives only in `src/core/` (e.g. `src/core/report-queries.ts`, exported from `src/core/index.ts`). Reuse `Repositories` / `Database`; do not add a parallel connection.
- One parameterized engine: `dimension × grain × ReportFilter`. The five reports are **not** free-form — they are the exact pairs in `GOAL.md` (copy here):

  | Report | dimension | grain |
  |--------|-----------|-------|
  | Where the money goes | `category` | `all` |
  | Payee ranking | `payee` | `all` |
  | Spend trend | `total` | `month` |
  | Year-over-year | `total` | `year` |
  | Account usage | `account` | `all` |

- Return rows: `{ groupKey, groupLabel, periodKey, total_cents, count }`. `total_cents` is integer. Later chart/table/PDF/xlsx consume this shape only.
- `ReportFilter`: `{ from, to, accountId?: number, categoryId?: number | null }`. Omitted `accountId` = all accounts. Omitted `categoryId` = all categories including Uncategorized. `categoryId: null` = Uncategorized only (`payments.category_id IS NULL`). A number = that category. Invalid windows (`from` > `to`, malformed dates) throw `ValidationError`.
- Window helpers (injectable as-of `Date`): calendar year, trailing 12, all-time, custom — bounds in `GOAL.md` Date windows, including the three trailing-12 worked examples. Also export `yoyWindowForCalendarYear(Y) -> { from: "Y-1-01-01", to: "Y-12-31" }` for the Reports page to call when report type is Year-over-year and preset is Calendar year. The engine does not infer presets.
- Malformed dates (not `YYYY-MM-DD`, impossible calendar dates) throw `ValidationError`, same as `from > to`.
- Spend trend (`total`/`month`): emit every `YYYY-MM` from the `from` month through the `to` month inclusive, `total_cents = 0` and `count = 0` when no payments.
- Uncategorized in `category`/`all`: `groupKey` null, `groupLabel` `"Uncategorized"`. Never omit those payments.
- Archived payees, accounts, **and categories**: included when they have payments in the window (history stays in reports).
- Parent categories: group by the payment's `category_id` (leaf). Do not roll amounts into the parent (avoids double count).
- Raw dump helper `listPaymentsForReport(repos, filter)` (name may vary): same `ReportFilter` as the engine, returns payment rows for xlsx/CSV dumps. Must honor Uncategorized (`categoryId: null`). Do not reuse `payments.list` if it cannot express that tri-state — wrap or query explicitly so dump and aggregate never disagree.
- CSV (pure functions, Vitest): `formatReportCsv(rows)`, `formatPaymentsCsv(payments)`, `formatYearSheetCsv(grid)` from `getBillPayGridForYear`. RFC 4180 quoting; UTF-8 BOM (`\uFEFF`); amounts as decimal strings from integer cents using **integer** `abs/100` and `abs%100` (same as BillsGrid/Payments helpers — not `/ 100` + `toFixed`, not `Number` floats). Example: `12345` → `123.45`, `-50` → `-0.50`.
- Category / payee / account rows (`grain=all`): sort `total_cents` DESC, then `groupLabel` ASC, then `groupKey` ASC (nulls last). Spend-trend months stay chronological. YoY years stay chronological.
- Integer cents only in SQL and aggregation — no `REAL`, no `/ 100` in SQL.
- TDD seams (pre-agreed): (1) public `runReportQuery`; (2) window helpers including trailing-12 literals; (3) `listPaymentsForReport`; (4) the three CSV formatters; (5) empty-book and invalid-window behavior.

## Acceptance criteria

- Vitest with a seeded multi-year temp/in-memory book proves the five `(dimension, grain)` pairs: category/payee/account/`total` totals equal independently listed fixture cents; month grain zero-fills and buckets Dec→Jan across a year boundary; leap-day `2024-02-29` lands in `2024-02`; YoY for calendar year 2026 uses `2025-01-01`…`2026-12-31` and returns periodKeys `2025` and `2026` when both years have fixture rows.
- Trailing-12 helper assertions (exact): as-of `2026-08-16` → `2025-08-16`…`2026-08-16`; as-of `2026-03-31` → `2025-03-31`…`2026-03-31`; as-of `2024-02-29` → `2023-02-28`…`2024-02-29`.
- Uncategorized payments appear in `category`/`all`; `sum(total_cents)` equals sum of in-window filtered `amount_cents`. `categoryId: null` dump and query include only those rows.
- Invalid `from` > `to` **and** malformed dates (`2026-13-01`, `not-a-date`) throw `ValidationError`. Empty window / empty book returns `[]`, not an error.
- `category`/`payee`/`account` grain=`all` fixture: rows are `total_cents` DESC (tie-break `groupLabel`, then `groupKey`).
- CSV tests: output starts with UTF-8 BOM; fields with commas/quotes/newlines are quoted; amount strings match fixture cents via integer `abs/100`/`abs%100`.
- 5 years × ~50 payments/month (~3,000 rows): each of the five report queries completes in under 100 ms (test fails if over).
- No SQL outside `src/core/`. No float money math in the new module.
