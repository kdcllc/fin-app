# Task 04.4 — PDF export via printpdf

Status: done (judge PASS 4/5, 2026-08-16)
Depends on: 04.2, 04.3

## Objective

Export the currently displayed report (title, date-window header, data table, optional chart PNG) to a PDF file written by Rust `printpdf`. No WebView print.

## Notes

- Layer(s) touched: rust, ui.
- Add `printpdf` to `src-tauri/Cargo.toml`. Command (name may vary) e.g. `export_report_pdf(path, spec)` where `spec` includes title, period label, column headers, table rows (labels + integer cents), and optional PNG bytes (from ECharts `getDataURL` in the UI).
- Rust formats cents as dollar strings with integer math (`abs/100`, `abs%100`). No `f64` money math. Rust does not query SQLite.
- Save dialog: `@tauri-apps/plugin-dialog` save, default name like `fin-report-category-2026.pdf`. User cancel is not a crash (no file written). Unwritable path: user-facing message.
- Optional chart image: if `getDataURL` is unavailable (tests, empty chart), omit the image; PDF still includes title, period, and table. `cargo test` uses a tiny fixture PNG or no image.
- Completion gate is Linux automated file checks. Windows/macOS visual inspection is deferred to CI/Goal 07.
- Tests use temp dirs only. Never the user's real book, GnuCash file, or real bill-pay xlsx.

## Acceptance criteria

- `cargo test` (from `src-tauri/`) writes a PDF to a temp path for a fixture spec (title, period, ≥3 table rows with known cents). The file starts with `%PDF` and contains `%%EOF`.
- A second cargo test with a small fixture PNG still produces a valid PDF. If PNG embed needs extra crates you choose not to add, omit the image in that test and document that the UI must not claim a chart was embedded when bytes were not sent.
- Reports page has an Export PDF control. UI test: injected save dialog to a temp path invokes the exporter with integer cents from the current query result; cancel leaves no file.
- `cargo clippy -- -D warnings` is clean. No WebView `print` / `printToPDF` API is used.
