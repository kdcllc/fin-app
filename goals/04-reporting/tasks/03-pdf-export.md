# Task 04.3 — PDF export of reports

Status: todo

## Objective

Export any report page (charts + table + header with title/date window) to PDF.

## Notes

- Research §3: options are WebView print-to-PDF (fidelity varies by OS WebView) vs. Rust-side generation (`printpdf`/Typst). Start with a dedicated print-layout HTML route + WebView print; fall back to Rust-side if Linux WebKitGTK output is poor — decide after a spike on all 3 OSes.
- Charts export as images (ECharts `getDataURL`) into the print layout for consistent output.

## Acceptance criteria

- Exported PDF of each report type is legible and complete (chart + table + period header) on Linux, Windows, macOS.
- File-save dialog with sensible default name, e.g. `fin-report-category-2026.pdf`.
