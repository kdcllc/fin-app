# Task 04.4 — xlsx / CSV export

Status: todo

## Objective

Export any report's data table, and raw payments for a date window, to `.xlsx` (via `rust_xlsxwriter`) and CSV — including a "year sheet" xlsx export mirroring the original payee × month layout, so the user can always leave with their data in the format they started from.

## Notes

- xlsx: typed columns (real dates, real currency numbers — fixing the original file's core flaw).
- CSV: RFC 4180, UTF-8 with BOM (Excel compatibility).

## Acceptance criteria

- Report table export opens correctly in Excel/LibreOffice with proper number/date types.
- Payee × month year export round-trips visually against the grid view.
