# Goal 04 reporting fixtures

Directory: `report/`

- `reporting-fixture.json`: canonical multi-year payment dataset and **literal** expected totals for report query conservation, UI table wiring, and export specs. Expected cents are not derived from `runReportQuery`.
- `chart-mini.png`: tiny PNG embedded in PDF export tests (`src-tauri/src/report_pdf.rs`).

## Dataset invariants

- Spans ≥2 calendar years (2024 leap-day payment + 2025–2026 window payments).
- ≥2 payees (`Power Co`, `Water Co`), ≥2 accounts (`Checking`, `Visa`), ≥2 categories (`Utilities`, `Groceries`).
- Includes uncategorized (`category: null`), December (`2025-12-15`), January (`2026-01-10`), and leap day (`2024-02-29`).
- Default query window: `2025-01-01` … `2026-12-31` with in-window total **17_000** cents (`5000 + 7500 + 1200 + 3300`).
- Seed helper: `tests/support/report-fixture.ts` (`seedReportingFixture`).
