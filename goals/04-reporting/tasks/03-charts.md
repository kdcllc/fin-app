# Task 04.3 — Chart components with ECharts

Status: done (judge PASS 4/5, 2026-08-16)
Depends on: 04.2

## Objective

The Reports placeholder is a working Reports page: a global filter bar and the five Goal 04 report types, each an ECharts chart plus a data table fed by `runReportQuery` with the exact `(dimension, grain)` pairs in `GOAL.md`. No PDF/xlsx/CSV buttons in this task.

## Notes

- Layer(s) touched: ui.
- There is **no** `dataviz` skill in this repo. Chart rules:
  - Bundle `echarts` (and `echarts-for-react` if used) via npm — no CDN, offline-first.
  - Light/dark: follow the app shell `prefers-color-scheme` theming. `buildChartOption(result, theme)` takes `theme: "light" | "dark"` and sets background, axis, and text tokens from that argument (unit-testable without a real `matchMedia` paint).
  - Do not encode meaning with color alone (table is the accessible companion).
  - Series data is integer cents; axis/tooltip formatters produce dollar strings the same way `PaymentsPage` / `BillsGridPage` already format cents. Do not aggregate in dollars.
- Wire `src/App.tsx` so `page === "reports"` renders this page, not `PlaceholderPage`.
- Filter bar (all named, all required):
  - Window preset: Calendar year | Trailing 12 months | All time | Custom from/to.
  - Calendar year picker when that preset is active.
  - Optional account `<select>` (empty = all) listing accounts with `includeArchived: true` so archived accounts that still appear in aggregates can be selected.
  - Optional category `<select>` with `includeArchived: true`, plus an Uncategorized option that sets `categoryId: null`.
  - First paint: calendar year of today (injectable clock in tests), no account/category filter.
- Changing preset, year, custom dates, account, category, **or report type** re-runs the current report's `(dimension, grain)` with the correct window:
  - Year-over-year + Calendar year `Y` → `runReportQuery` must receive `from=Y-1-01-01`, `to=Y-12-31` (use `yoyWindowForCalendarYear`).
  - Year-over-year + Trailing 12 / All time / Custom → do **not** expand; pass that preset's `from`/`to`.
  - The other four report types always use the preset window (never the YoY expansion).
- Empty window: explicit empty-state copy. Invalid custom window: user-facing `ValidationError` message (no raw exception).
- jsdom cannot reliably paint ECharts canvas. Test `buildChartOption(result, theme)` plus DOM tests for filter bar, table rows (cents formatted), empty state, report-type switching, and the four presets. No screenshot tests.

## Acceptance criteria

- `src/App.tsx` renders a real Reports page (not `PlaceholderPage`) for the reports nav item.
- UI tests with mocked/fixture repos cover:
  - all five report types, each calling the matching `(dimension, grain)` from `GOAL.md`;
  - table cents match the query result;
  - all four window presets (calendar year, trailing 12, all time, custom) change the `from`/`to` passed into the engine for non-YoY reports;
  - switching to Year-over-year with calendar year **2026** calls the engine with `from: "2025-01-01"` and `to: "2026-12-31"` (spy/mock assertion);
  - switching to Year-over-year with Trailing 12 does **not** apply that two-year expansion (engine `from`/`to` equal the trailing-12 helper);
  - account filter and category filter (including Uncategorized) are present and applied; archived entities appear in those selects;
  - first paint uses the current calendar year;
  - empty results show the empty-state;
  - invalid from>to shows a user-facing validation message.
- `buildChartOption(result, "light")` vs `"dark"` differs in theme tokens (e.g. text/background color). Series values are `total_cents` integers; a formatter unit test maps `12345` → `$123.45`.
- `echarts` is an npm dependency (not a script CDN). `npm test` and `npm run lint` pass.
