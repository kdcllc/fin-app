-- Migration 2 — deliberately harmless: proves the versioned migration path
-- applies incrementally on an existing v1 database (acceptance criterion 2).
CREATE INDEX idx_recurring_bills_payee_id ON recurring_bills (payee_id);
