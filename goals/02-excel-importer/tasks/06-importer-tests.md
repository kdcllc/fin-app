# Task 02.6 — Importer fixtures and automated test coverage

Status: todo

## Objective

Add the fixture data and automated tests required to make Goal 02 fully judgeable without user-private workbook files.

## Notes

- Use fixtures and temp DB/files only; never rely on user-local workbook paths.
- Cover both TS core and Rust command boundaries:
	- Vitest for parser/normalization/core dedup and transaction orchestration.
	- Cargo tests for Rust xlsx raw-reader error mapping where applicable.
- Keep cents-only invariants explicit in assertions.

## Acceptance criteria

- Fixture workbook(s) and expected-output fixtures are committed under `tests/fixtures/excel/` (or equivalent existing fixtures path) with documentation.
- Parser tests prove conservation: `parsed_records + unparsed_records == non_empty_data_cells` for each fixture sheet.
- Normalization tests assert deterministic payee/account-hint/category-suggestion outputs for representative labels.
- Idempotency tests prove:
	- same fixture import twice => zero new payments on second import,
	- fixture variant with one additional valid cell => exactly one new proposed payment.
- UI/commit integration test proves commit stays disabled with unresolved unparsed rows and proves atomic rollback on injected failure.
- Integration tests assert zero pre-commit writes by verifying DB table counts are unchanged until commit is explicitly executed.
