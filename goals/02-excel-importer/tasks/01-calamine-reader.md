# Task 02.1 — Rust xlsx reader with calamine

Status: todo

## Objective

Rust Tauri command that opens a user-selected `.xlsx` workbook with `calamine` and returns raw sheet data (sheet names, rows, cell strings) to the frontend for parsing/preview.

## Notes

- `calamine` is read-only and pure Rust — ideal for this (research §3).
- Return values as strings plus cell coordinates; parsing happens in the next task so raw values stay inspectable in the review UI.
- Handle: missing file, non-xlsx, empty sheets, sheets whose name is not a year (skip with warning, don't fail).
- Layer ownership: this command performs file I/O and raw extraction only; parsing and normalization stay in TS core.

## Acceptance criteria

- Against committed fixture workbook(s) in `tests/fixtures/excel/`, command returns deterministic sheet/row/cell payloads including source coordinates for each non-empty cell.
- Non-year sheets are skipped and surfaced as structured warnings without failing the import session.
- File-open and workbook-format failures surface as typed errors, never panics.
- Optional smoke check with the real workbook is allowed but non-gating.
