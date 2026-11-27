-- Migration 8 — GnuCash export tracking and reconciliation overrides.

CREATE TABLE payment_exports (
    id INTEGER PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES payments (id),
    format TEXT NOT NULL CHECK (format IN ('qif', 'csv')),
    exported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payment_exports_payment_id ON payment_exports (payment_id);

CREATE TABLE gnucash_matches (
    id INTEGER PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES payments (id),
    txn_guid TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('matched', 'unmatched')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (payment_id, txn_guid)
);

CREATE INDEX idx_gnucash_matches_txn_guid ON gnucash_matches (txn_guid);
