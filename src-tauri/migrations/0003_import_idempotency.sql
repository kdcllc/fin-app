-- Migration 3 — import idempotency metadata and xlsx dedup support.

-- Fast exact-file replay checks by workbook content hash.
CREATE INDEX idx_import_log_content_hash ON import_log (content_hash);

-- Persist source coordinates for xlsx-originated payments so re-import dedup can
-- distinguish exact row identity from business-field-only collisions.
ALTER TABLE payments
ADD COLUMN source_sheet TEXT CHECK (source != 'xlsx' OR source_sheet IS NOT NULL);
ALTER TABLE payments
ADD COLUMN source_row INTEGER CHECK (source != 'xlsx' OR source_row IS NOT NULL);
ALTER TABLE payments
ADD COLUMN source_col INTEGER CHECK (source != 'xlsx' OR source_col IS NOT NULL);
ALTER TABLE payments
ADD COLUMN occurrence_index INTEGER CHECK (
    source != 'xlsx'
    OR (occurrence_index IS NOT NULL AND occurrence_index >= 1)
);

-- Collision-safe identity for xlsx rows.
CREATE UNIQUE INDEX idx_payments_xlsx_identity
ON payments (
    payee_id,
    account_id,
    date,
    amount_cents,
    source_sheet,
    source_row,
    source_col,
    occurrence_index
)
WHERE source = 'xlsx';

-- Speeds potential-duplicate checks that compare business fields first.
CREATE INDEX idx_payments_xlsx_business
ON payments (source, payee_id, account_id, date, amount_cents);
