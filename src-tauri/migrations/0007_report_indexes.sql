-- Migration 7 — covering index for account-dimension report aggregates.

CREATE INDEX idx_payments_account_id ON payments (account_id);
