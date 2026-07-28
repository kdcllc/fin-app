-- Schema v1 (docs/RESEARCH.md §5, goals/01-foundation/tasks/02-sqlite-schema.md).
-- Money is ALWAYS integer cents (INTEGER) — never REAL/float.
-- Foreign keys: sqlx (used by tauri-plugin-sql) enables PRAGMA foreign_keys=ON
-- on every SQLite connection by default; the pragma below documents the intent
-- for anyone opening the file with other tooling.
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('checking', 'credit', 'cash')),
    last4 TEXT,
    gnucash_guid TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES categories (id),
    gnucash_guid TEXT
);

CREATE TABLE payees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    default_category_id INTEGER REFERENCES categories (id),
    default_account_id INTEGER REFERENCES accounts (id),
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    payee_id INTEGER NOT NULL REFERENCES payees (id),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    category_id INTEGER REFERENCES categories (id),
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    memo TEXT,
    source TEXT NOT NULL CHECK (source IN ('manual', 'xlsx', 'gnucash')),
    external_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recurring_bills (
    id INTEGER PRIMARY KEY,
    payee_id INTEGER NOT NULL REFERENCES payees (id),
    frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'annual')),
    expected_amount_cents INTEGER,
    due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE import_log (
    id INTEGER PRIMARY KEY,
    source_file TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count INTEGER NOT NULL
);

-- Report-query indexes required by the task.
CREATE INDEX idx_payments_date ON payments (date);
CREATE INDEX idx_payments_payee_id ON payments (payee_id);
CREATE INDEX idx_payments_category_id ON payments (category_id);
