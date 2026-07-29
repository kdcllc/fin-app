-- Migration 6 — explicit recurring schedule anchors for annual and quarterly billing.

ALTER TABLE recurring_bills
ADD COLUMN anchor_month INTEGER NOT NULL DEFAULT 1 CHECK (anchor_month BETWEEN 1 AND 12);

ALTER TABLE recurring_bills
ADD COLUMN anchor_phase INTEGER NOT NULL DEFAULT 1 CHECK (anchor_phase BETWEEN 1 AND 3);
