# Goal 04 — Reporting & Export

**Milestone:** v0.2 · **Depends on:** Goals 02, 03, 08

## Objective

Replace the Reports placeholder with multi-year expense reports the spreadsheet could never produce: spending by category, payee, and account; month-over-month trends; and year-over-year comparison — each as a chart plus a data table — plus PDF and xlsx/CSV export so the user can leave with their data.

## Phase 1 decisions (recorded 2026-08-16)

- Problem focus: the imported/manual `payments` rows already exist; reporting is the user-visible reason the app exists. The Reports nav item is currently a placeholder.
- Touched layers: schema (indexes only), TS core (query engine + CSV), Rust commands (`printpdf` PDF writer, `rust_xlsxwriter` xlsx writer), UI (Reports page, ECharts, save dialogs), tests.
- Data model impact: no new entities. Read `payments`, `payees`, `accounts`, `categories`. Known gap: no `payments.account_id` index — add it in 04.1. Totals are integer cents.
- GnuCash: out of scope. Do not open, read, or write GnuCash files. `gnucash_guid` columns stay unused. `source = 'gnucash'` payments, if any exist later, are ordinary payments in aggregates.
- Error behavior: invalid date windows raise `ValidationError` with a user-facing message. Empty windows render an empty table and an explicit empty-state (not an error). Export I/O failures surface as user-facing messages (no raw exceptions, no crash). Export never writes the user's real book, real GnuCash file, or real xlsx as a test target.
- UI surface: replace the Reports placeholder. One Reports page with a global filter bar and five report types. Export actions live on that page. First-paint default window is the **current calendar year** (same idea as `PaymentsPage`).
- Filters: **single** optional `accountId` and tri-state `categoryId` (omitted = all, `null` = Uncategorized only, number = that category). Not multi-select lists. Same `ReportFilter` for queries, charts, PDF, and **report-table / raw-payment** dumps so rows cannot silently drop. **Year-sheet export ignores `accountId`/`categoryId`:** it calls `getBillPayGridForYear` for one calendar year only (default: calendar year of the filter `to` date), matching the Bills Grid.
- PDF (user decision 2026-08-16): **Rust `printpdf`**, not WebView print. Linux fixture/file checks are the completion gate; Windows/macOS visual proof is deferred to CI/Goal 07.
- Dependencies in code (Goals 02/03/08): Excel import, bill-pay UX, and the rusqlite backend are present in the tree even though some Goal 02/03 task files still say `todo`. Goal 04 builds on that code, not on re-implementing it.

## Five report types (engine contract)

Every type calls the same engine with a fixed `(dimension, grain)`. Chart series and table rows are that result, one row per `{groupKey, periodKey}`.

| # | Report | dimension | grain | periodKey | groupKey / groupLabel | Chart | Table |
|---|--------|-----------|-------|-----------|----------------------|-------|-------|
| 1 | Where the money goes | `category` | `all` | unused (`""`) | category id, or `null` / `"Uncategorized"` | pie or treemap (leaf amounts only) | one row per category |
| 2 | Payee ranking | `payee` | `all` | unused (`""`) | payee id / name | bar | one row per payee |
| 3 | Spend trend | `total` | `month` | `YYYY-MM` | unused (`null` / `""`) | line/area | one row per month |
| 4 | Year-over-year | `total` | `year` | `YYYY` | unused (`null` / `""`) | bar (one bar per calendar year) | one row per year |
| 5 | Account usage | `account` | `all` | unused (`""`) | account id / name | bar or pie | one row per account |

Spend trend **zero-fills** every calendar month from the window's `from` month through `to` month (`total_cents = 0` when none). YoY does **not** zero-fill years with no payments.

YoY range: the **Reports page** (and any other caller) must pass an expanded window when the report type is Year-over-year **and** the preset is calendar year `Y`: `from=Y-1-01-01`, `to=Y-12-31`. Trailing-12 / all-time / custom must **not** expand — pass the filter window as-is; the engine groups those payments by calendar year of `date`. The engine itself does not infer the preset.

## Date windows

Inclusive ISO `YYYY-MM-DD` bounds. Default as-of date is today (injectable in tests).

| Preset | `{from, to}` |
|--------|----------------|
| Calendar year `Y` | `Y-01-01` … `Y-12-31` |
| Trailing 12 months | `from = asOf minus 1 calendar year` (clamp invalid days to last day of that month), `to = asOf` |
| All time | min(payment.date) … max(payment.date); empty book → empty result, not an error |
| Custom | user `from`/`to`; `from > to` or malformed → `ValidationError` |

Worked trailing-12 examples (must appear as 04.2 fixture assertions):

- as-of `2026-08-16` → `{ from: "2025-08-16", to: "2026-08-16" }`
- as-of `2026-03-31` → `{ from: "2025-03-31", to: "2026-03-31" }`
- as-of `2024-02-29` → `{ from: "2023-02-28", to: "2024-02-29" }` (2023 has no 29 Feb)

## Success criteria

- The five report types above run over fixture-seeded temp books with the four window presets. Query rows are `{ groupKey, groupLabel, periodKey, total_cents, count }` (integer cents). Chart and table both render from that shape. Uncategorized payments (`category_id` IS NULL) appear as an explicit Uncategorized bucket in the category report — never dropped.
- Conservation: for dimension `category`/`payee`/`account`/`total` with grain `all` or `year`, `sum(total_cents)` equals the sum of in-window (and filtered) payment `amount_cents`. For spend-trend (zero-filled months), the sum of monthly `total_cents` still equals that payment sum (zeros do not change it). Category / payee / account rows sort by `total_cents` DESC, then `groupLabel`, then `groupKey` (stable ranking).
- Every report type renders as an ECharts chart plus a data table on the Reports page, bundled locally (no CDN), adapting to the app light/dark theme. First paint uses the current calendar year.
- Any report exports to PDF via a Rust `printpdf` command (title, period header, table; optional chart PNG). `cargo test` writes a valid PDF (`%PDF` header, `%%EOF`) to a temp path.
- Six tabular exports, all implemented: report table xlsx, report table CSV, raw-payments xlsx, raw-payments CSV, year-sheet xlsx, year-sheet CSV. xlsx via `rust_xlsxwriter`; CSV via TS core (RFC 4180, UTF-8 BOM). Round-trips use `calamine` / Vitest on temp files — not Excel GUI and not the user's real workbook.
- A 5-year × ~50 payments/month synthetic fixture (~3,000 rows) answers any of the five report queries in under 100 ms in Vitest; the Reports page render of that result is specified as under 1 second on the dev machine (QA evidence, non-gating if the 100 ms query gate holds).
- Quality gates: `npm test`, `cargo test` (from `src-tauri/`), `npm run lint`, `cargo clippy -- -D warnings`.

## Layer ownership

- Schema/migrations own covering indexes only. Never edit shipped migration files; add a new `0007_*.sql` (or next unused number).
- TS core owns all SQL, the report query engine, CSV formatting, date-window helpers, raw-payment dump helper, and integer-cent totals. UI never issues SQL.
- Rust commands own file bytes: PDF (`printpdf`) and xlsx (`rust_xlsxwriter`). They receive already-aggregated rows and labels (cents as integers) — no SQL in Rust, no float money math.
- UI owns the Reports page, filter bar, ECharts option building / render, and save dialogs. Display formatters convert cents to dollar strings the same way Payments/Grid pages already do.
- Tests own fixture books and temp-dir export files. Never the user's real book, real GnuCash file, or real `2026-bill-pay.xlsx`.

## Constraints

- Integer cents in storage, aggregation, and query results. Float dollars are not used for math. Presentation may format cents as dollar strings; ECharts series use cents with a label formatter (do not aggregate in `cents/100`).
- SQL only in `src/core/`. The Rust SQLite backend from Goal 08 stays a dumb executor.
- No `dataviz` skill exists in this repo — do not invent one. Chart rules live in task **04.3** notes (theme, accessibility, local bundle).
- GnuCash out of scope.
- `tauri-plugin-sql` stays gone.

## Tasks

Execution order **deviates** from the default schema → TS core → Rust → UI → tests (same honesty as Goal 08): CSV formatters live with the query engine (TS core) before any UI; the Reports page (UI) lands before PDF/xlsx because optional chart PNGs and export buttons need that page; each export task then adds its Rust writer **and** the matching Reports-page controls.

1. Schema: [Report covering indexes](tasks/01-report-indexes.md)
2. TS core: [Report query engine + CSV](tasks/02-report-queries.md)
3. UI: [Chart components with ECharts](tasks/03-charts.md)
4. Rust + UI: [PDF export via printpdf](tasks/04-pdf-export.md)
5. Rust + UI: [xlsx export + CSV wiring](tasks/05-xlsx-csv-export.md)
6. Tests: [Reporting fixtures and automated tests](tasks/06-reporting-tests.md)
