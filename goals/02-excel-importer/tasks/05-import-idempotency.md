# Task 02.5 — Import log & idempotent re-import

Status: todo

## Objective

Re-importing the same or an updated workbook must not duplicate payments: record every import in `import_log` (file name, content hash, timestamp, row count) and dedup at payment level.

## Notes

- Payment identity for dedup: (payee, account, date, amount_cents) + source=xlsx — flag collisions in the review UI as "already imported" (default: skip).
- Same content hash as a previous import → warn "this exact file was already imported."
- Updated workbook (new months filled in) → only new payments proposed.

## Acceptance criteria

- Importing the same file twice yields zero new payments the second time.
- Adding one new cell to the workbook and re-importing proposes exactly one new payment.
