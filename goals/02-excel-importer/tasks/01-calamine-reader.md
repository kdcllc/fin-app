# Task 02.1 — Rust xlsx reader with calamine

Status: todo

## Objective

Rust Tauri command that opens a user-selected `.xlsx` workbook with `calamine` and returns raw sheet data (sheet names, rows, cell strings) to the frontend for parsing/preview.

## Notes

- `calamine` is read-only and pure Rust — ideal for this (research §3).
- Return values as strings plus cell coordinates; parsing happens in the next task so raw values stay inspectable in the review UI.
- Handle: missing file, non-xlsx, empty sheets, sheets whose name is not a year (skip with warning, don't fail).

## Acceptance criteria

- Command returns all sheets/rows of `2026-bill-pay.xlsx` correctly (verify against the known 37-row `2025` sheet).
- Errors surface as typed results, not panics.
