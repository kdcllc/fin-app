# Task 02.5 — Import log & idempotent re-import

Status: todo

## Objective

Re-importing the same or an updated workbook must not duplicate payments: record every import in `import_log` (file name, content hash, timestamp, row count) and dedup at payment level.

Scope for this task is strictly schema/migration + TS core contracts. UI wiring is handled in the review UI task.

## Notes

- Payment identity for dedup must be collision-safe: `(payee, account, date, amount_cents, source=xlsx, source_sheet, source_row, source_col, occurrence_index)`.
- If an incoming row matches on business fields but differs in source coordinates, core must emit a `potential_duplicate` outcome for UI review (not silently skipped).
- Same content hash as a previous import → warn "this exact file was already imported."
- Updated workbook (new months filled in) → only new payments proposed.

## Acceptance criteria

- Migration creates `import_log` fields required for deterministic replay checks, and core repository APIs expose lookup/insert operations used by import flow.
- Importing the same fixture file twice yields zero new payments the second time.
- Adding one new valid cell to a fixture variant and re-importing proposes exactly one new payment.
- Potential business-field collisions with different source coordinates are emitted by core as explicit decision items for downstream UI handling.
