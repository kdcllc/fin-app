# Task 02.7 — Track the Rust reader xlsx fixture for CI

Status: done (judge PASS 5/5, 2026-08-17)
Depends on: 02.1 (reader test already expects the file)

## Objective

CI `cargo test` can load `tests/fixtures/excel/task-02-1-reader.xlsx`. That synthetic fixture already exists on disk and is required by `xlsx_reader::tests::command_reads_fixture_year_sheet_and_surfaces_non_year_warning`. Root `.gitignore` currently matches `*.xlsx`, so the file never reaches GitHub Actions.

## Notes

- Layer(s) touched: gitignore + tracked fixture only. Do not change Rust/TS test logic. Do not regenerate or overwrite the workbook.
- The reader test pins sheet `2024` cell grid and a `Summary` skipped-non-year warning. `payload.file_sha256` is a round-trip against `compute_file_sha256(&fixture)`, not a hardcoded digest.
- Keep ignoring personal workbooks: root `*.xlsx` stays. **After that line** add `!tests/fixtures/**/*.xlsx` (or `!tests/fixtures/excel/*.xlsx`). Do not add a single-file exception only. Do not un-ignore all `*.xlsx`.
- Use the existing local file `tests/fixtures/excel/task-02-1-reader.xlsx` (documented in `tests/fixtures/excel/README.md`).
- Do not add `2026-bill-pay.xlsx` or any file outside `tests/fixtures/`.
- After the gitignore exception, `git add` the fixture so it is in the index. Do not create a git commit unless the orchestrator asks.

## Acceptance criteria

- `.gitignore` still contains `*.xlsx`. Immediately after that line it contains `!tests/fixtures/**/*.xlsx` or `!tests/fixtures/excel/*.xlsx`.
- `git check-ignore tests/fixtures/excel/task-02-1-reader.xlsx` exits non-zero (file is not ignored).
- `git check-ignore -v 2026-bill-pay.xlsx` reports `.gitignore` `*.xlsx` (personal workbooks stay ignored).
- `git ls-files --error-unmatch tests/fixtures/excel/task-02-1-reader.xlsx` succeeds after `git add`.
- `tests/fixtures/excel/task-02-1-reader.xlsx` remains 2078 bytes with SHA-256 `17a4ba44f6b22417921b0870fc1f97c5b44974e71894da3e74a5c569c4092572`.
- `cargo test --manifest-path src-tauri/Cargo.toml command_reads_fixture_year_sheet_and_surfaces_non_year_warning` passes.
- No edits to `src-tauri/src/xlsx_reader.rs`, application source, or Vitest files.
