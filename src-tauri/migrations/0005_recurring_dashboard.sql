-- Migration 5 — recurring-dashboard suggestion dismissals.

-- Persist dismissed suggestion signatures so suggestion generation is deterministic
-- across reloads and test runs.
CREATE TABLE recurring_bill_suggestion_dismissals (
    signature TEXT PRIMARY KEY,
    payee_id INTEGER NOT NULL REFERENCES payees (id),
    frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'annual')),
    due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    expected_amount_cents INTEGER,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recurring_suggestion_dismissals_payee
ON recurring_bill_suggestion_dismissals (payee_id);
