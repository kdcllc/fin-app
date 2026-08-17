# Task 04.5 — xlsx export + CSV wiring

Status: done (judge PASS 4/5, 2026-08-16)
Depends on: 04.2, 04.3

## Objective

From the Reports page, the user can export all six tabular flavors: report table, raw payments, and year sheet — each as `.xlsx` (Rust `rust_xlsxwriter`) and as CSV (04.2 TS-core formatters).

## Notes

- Layer(s) touched: rust, ui (CSV functions already shipped in 04.2; this task wires them and adds xlsx).
- xlsx: add `rust_xlsxwriter` to `src-tauri/Cargo.toml`. Command receives path + a typed spec (headers, rows). Dates as date cells; amounts as numeric cells derived from integer cents **without** `as f64 / 100.0` as the source of truth (integer split or a cents-based write API). Round-trip with **calamine** (already a dependency) in `cargo test` — not Excel/LibreOffice GUI.
- Raw dump rows come from `listPaymentsForReport` with the **same** `ReportFilter` as the on-screen report (including `categoryId: null` Uncategorized).
- Year sheet **does not apply** `accountId` / `categoryId`. It calls `getBillPayGridForYear(repos, year)` only. Default `year` is the calendar year of the current filter `to` date. Document this in the control label (e.g. “Year sheet (full year, ignores account/category filters)”).
- Reports page export menu/controls must expose all six paths, with default names like `fin-report-payee-2026.xlsx`, `fin-payments-2026.csv`, `fin-year-2026.xlsx`. User cancel is not a crash (no file written). Unwritable path / other I/O failure: user-facing message, same bar as 04.4 — no raw exception.
- Tests: temp dirs only. Never the user's real workbook.

## Acceptance criteria

Each of the six paths has an automated check:

1. **Report table xlsx** — `cargo test` (or UI+command test writing temp xlsx): calamine reads amounts that correspond 1:1 with fixture `total_cents`.
2. **Report table CSV** — UI or core test writes/uses `formatReportCsv`; BOM + RFC 4180; amount strings match fixture cents.
3. **Raw-payments xlsx** — calamine round-trip of dump rows (date, payee, account, category, amount) for a `ReportFilter`; Uncategorized-only filter dumps only `category_id` NULL rows.
4. **Raw-payments CSV** — `formatPaymentsCsv` on the same dump; BOM + cents strings.
5. **Year-sheet xlsx** — calamine-read month / row / grand totals equal `getBillPayGridForYear` `month_totals` / `row_total_cents` / `grand_total_cents` for a fixture year.
6. **Year-sheet CSV** — `formatYearSheetCsv` totals match that same grid helper.

- UI tests with injected save dialog: at least one xlsx path and one CSV path invoke the matching writer with current filters; cancel writes no file; an injected I/O failure shows a user-facing message. All six controls are present in the DOM (labels or `data-testid`s). Year-sheet control does not pass account/category into `getBillPayGridForYear`.
- `npm test`, `cargo test` (from `src-tauri/`), `cargo clippy -- -D warnings` pass.
