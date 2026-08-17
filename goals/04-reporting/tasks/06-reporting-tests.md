# Task 04.6 — Reporting fixtures and automated tests

Status: done (judge PASS 4/5, 2026-08-16)
Depends on: 04.1, 04.2, 04.3, 04.4, 04.5

## Objective

Close Goal 04 with committed fixtures and automated tests that a judge can re-run: query conservation, window edges, chart/table wiring, PDF magic bytes, all six xlsx/CSV paths, and empty/error states — all on temp books and temp dirs.

## Notes

- Layer(s) touched: tests.
- Use fixture data and temp DBs only; no user-private workbook, live book, or GnuCash file.
- Extend (do not weaken) tests added in 04.1–04.5. This task fills gaps: one documented fixture dataset used across core + UI + export, and any thin UI/export paths.
- Money assertions stay in integer cents (display-string tests may assert `$123.45` derived from `12345`).
- Follow `.claude/skills/tdd/SKILL.md` test-quality rules: outcomes not implementation details; expected totals are fixture literals, not recomputed with the production query helper.
- Leap-day is required: seed **`2024-02-29`** (do not hedge).

## Acceptance criteria

- A committed fixture (or generated-in-test seed with a documented literal expected-totals table) covers ≥2 calendar years, ≥2 payees, ≥2 accounts, ≥2 categories, at least one uncategorized payment, at least one December and one January payment, and a `2024-02-29` payment.
- Core tests prove conservation for all five `(dimension, grain)` pairs over a documented window: `sum(total_cents)` equals the independently listed fixture payment cents (spend-trend zeros included).
- Trailing-12 literals from `GOAL.md` remain asserted. YoY calendar-year 2026 window remains `2025-01-01`…`2026-12-31`.
- Export tests in temp dirs cover all six flavor×format paths, PDF `%PDF`/`%%EOF`, and year-sheet totals matching the grid helper.
- UI tests: Reports page is not a placeholder; five types; four window presets; account/category filters; empty-state; validation message on from>to and on malformed dates. Year-over-year + calendar year 2026 spies `runReportQuery` with `2025-01-01`…`2026-12-31`.
- 5×12×50 synthetic performance test remains in the suite and fails if a report query exceeds 100 ms.
- Re-running `npm test` and `cargo test` (from `src-tauri/`) is deterministic and does not require Excel, a display, or user-local files.
