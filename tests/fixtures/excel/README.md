# Excel importer fixtures

These fixtures are the judgeable source of truth for Goal 02 importer tests.

## Files

- `task-02-1-reader.xlsx`: sample workbook used by Rust xlsx reader tests.
- `cell-parser-conservation.json`: representative payment-cell inputs with known parsed/unparsed behavior.
- `payee-normalization.json`: deterministic payee normalization and grouping expectations.
- `base.json`: baseline import candidate set for idempotency tests.
- `one-cell-extended.json`: baseline plus exactly one additional valid candidate.
- `import-review-ui-happy-path.json`: workbook payload fixture for review UI integration tests.

## Invariants these fixtures support

- Parser conservation: for each tested sheet/cell-set, `parsed_cells + unparsed_cells == non_empty_data_cells`.
- Deterministic normalization outputs for representative real-world labels.
- Re-import idempotency: same fixture twice creates zero new payments on second pass.
- One-cell growth behavior: extended variant produces exactly one additional proposed/imported payment.
- Review gating: unresolved unparsed/duplicate decisions block commit and no rows are written pre-commit.
- Atomic commit behavior: injected failures roll back all importer writes including `import_log`.
