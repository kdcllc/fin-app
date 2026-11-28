-- Migration 9 — double-entry ledger (goal ledger-core, task 01).
--
-- Converts the schema-v8 payment model into accounts / transactions / splits.
-- Rebuilds `accounts` and `payees` (SQLite "12-step" procedure: create new,
-- copy, drop old, rename new), turns every `categories` row into an EXPENSE
-- account, and every `payments` row into one balanced two-split transaction.
-- The runner applies this with foreign keys OFF inside ONE transaction and
-- runs PRAGMA foreign_key_check before commit. Money is integer cents; split
-- amounts are debit-positive and every transaction's splits sum to 0.
--
-- Dropped: payments, categories, payment_exports, gnucash_matches (the last
-- two belong to the retired export/reconcile features; the pre-migration
-- backup keeps them recoverable).

-- ---------------------------------------------------------------------------
-- 1. accounts (rebuilt)
-- ---------------------------------------------------------------------------

CREATE TABLE accounts_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY')),
    subtype TEXT,
    parent_id INTEGER REFERENCES accounts (id),
    placeholder INTEGER NOT NULL DEFAULT 0 CHECK (placeholder IN (0, 1)),
    system_role TEXT UNIQUE CHECK (
        system_role IS NULL OR system_role IN (
            'root_asset', 'root_liability', 'root_income', 'root_expense', 'root_equity',
            'uncategorized', 'opening_balances'
        )
    ),
    last4 TEXT,
    gnucash_guid TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    CHECK (
        (type = 'ASSET' AND (subtype IS NULL OR subtype IN ('bank', 'cash', 'savings')))
        OR (type = 'LIABILITY' AND (subtype IS NULL OR subtype IN ('credit_card', 'loan')))
        OR (type IN ('INCOME', 'EXPENSE', 'EQUITY') AND subtype IS NULL)
    ),
    CHECK (
        parent_id IS NOT NULL
        OR (system_role IS NOT NULL AND system_role IN ('root_asset', 'root_liability', 'root_income', 'root_expense', 'root_equity'))
    ),
    CHECK (parent_id IS NULL OR parent_id != id)
);

-- Root placeholders and system accounts get ids ABOVE every existing account
-- id so legacy account ids are preserved.
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 1, 'Assets', 'ASSET', NULL, NULL, 1, 'root_asset'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 2, 'Liabilities', 'LIABILITY', NULL, NULL, 1, 'root_liability'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 3, 'Income', 'INCOME', NULL, NULL, 1, 'root_income'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 4, 'Expenses', 'EXPENSE', NULL, NULL, 1, 'root_expense'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 5, 'Equity', 'EQUITY', NULL, NULL, 1, 'root_equity'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);

INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 6, 'Uncategorized', 'EXPENSE', NULL, base + 4, 0, 'uncategorized'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, system_role)
SELECT base + 7, 'Opening Balances', 'EQUITY', NULL, base + 5, 0, 'opening_balances'
FROM (SELECT COALESCE(MAX(id), 0) AS base FROM accounts);

-- Existing funding accounts keep their ids.
INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, last4, gnucash_guid, archived)
SELECT
    a.id,
    a.name,
    CASE a.kind WHEN 'credit' THEN 'LIABILITY' ELSE 'ASSET' END,
    CASE a.kind WHEN 'checking' THEN 'bank' WHEN 'cash' THEN 'cash' ELSE 'credit_card' END,
    (SELECT r.id FROM accounts_new r
      WHERE r.system_role = CASE a.kind WHEN 'credit' THEN 'root_liability' ELSE 'root_asset' END),
    0,
    a.last4,
    a.gnucash_guid,
    a.archived
FROM accounts a
ORDER BY a.id;

-- ---------------------------------------------------------------------------
-- 2. categories -> EXPENSE accounts (new ids, recorded in legacy_category_map)
-- ---------------------------------------------------------------------------

CREATE TABLE legacy_category_map (
    category_id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE
);

-- New account id = (highest id so far) + old category id: unique, deterministic.
INSERT INTO legacy_category_map (category_id, account_id)
SELECT c.id, (SELECT MAX(id) FROM accounts_new) + c.id
FROM categories c;

INSERT INTO accounts_new (id, name, type, subtype, parent_id, placeholder, gnucash_guid, archived)
SELECT
    m.account_id,
    c.name,
    'EXPENSE',
    NULL,
    (SELECT r.id FROM accounts_new r WHERE r.system_role = 'root_expense'),
    0,
    c.gnucash_guid,
    c.archived
FROM categories c
JOIN legacy_category_map m ON m.category_id = c.id
ORDER BY c.id;

-- Re-parent nested categories under their mapped parent account (any depth:
-- every category row exists in the map before this runs).
UPDATE accounts_new
SET parent_id = (
    SELECT pm.account_id
    FROM legacy_category_map m
    JOIN categories c ON c.id = m.category_id
    JOIN legacy_category_map pm ON pm.category_id = c.parent_id
    WHERE m.account_id = accounts_new.id
)
WHERE id IN (
    SELECT m.account_id
    FROM legacy_category_map m
    JOIN categories c ON c.id = m.category_id
    WHERE c.parent_id IS NOT NULL
);

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

CREATE INDEX idx_accounts_parent_id ON accounts (parent_id);
CREATE INDEX idx_accounts_type_archived_name ON accounts (type, archived, name, id);

-- ---------------------------------------------------------------------------
-- 3. payees (rebuilt: default_category_id now references accounts)
-- ---------------------------------------------------------------------------

CREATE TABLE payees_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    default_category_id INTEGER REFERENCES accounts (id),
    default_account_id INTEGER REFERENCES accounts (id),
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

INSERT INTO payees_new (id, name, default_category_id, default_account_id, notes, archived)
SELECT p.id, p.name, m.account_id, p.default_account_id, p.notes, p.archived
FROM payees p
LEFT JOIN legacy_category_map m ON m.category_id = p.default_category_id
ORDER BY p.id;

DROP TABLE payees;
ALTER TABLE payees_new RENAME TO payees;

-- ---------------------------------------------------------------------------
-- 4. transactions and splits
-- ---------------------------------------------------------------------------

CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    payee_id INTEGER REFERENCES payees (id),
    memo TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'xlsx', 'gnucash')),
    external_ref TEXT,
    source_sheet TEXT CHECK (source != 'xlsx' OR source_sheet IS NOT NULL),
    source_row INTEGER CHECK (source != 'xlsx' OR source_row IS NOT NULL),
    source_col INTEGER CHECK (source != 'xlsx' OR source_col IS NOT NULL),
    occurrence_index INTEGER CHECK (
        source != 'xlsx'
        OR (occurrence_index IS NOT NULL AND occurrence_index >= 1)
    ),
    import_account_id INTEGER REFERENCES accounts (id),
    import_amount_cents INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- NULLs are distinct in a unique index, so xlsx rows must carry the snapshot.
    CHECK (
        source != 'xlsx'
        OR (import_account_id IS NOT NULL AND import_amount_cents IS NOT NULL)
    )
);

CREATE TABLE splits (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    -- Signed integer cents, debit-positive; a transaction's splits sum to 0.
    amount_cents INTEGER NOT NULL,
    memo TEXT,
    reconcile_state TEXT NOT NULL DEFAULT 'n' CHECK (reconcile_state IN ('n', 'c', 'y'))
);

-- Payments -> transactions (same ids and provenance).
INSERT INTO transactions (
    id, date, payee_id, memo, source, external_ref,
    source_sheet, source_row, source_col, occurrence_index,
    import_account_id, import_amount_cents, created_at
)
SELECT
    p.id, p.date, p.payee_id, p.memo, p.source, p.external_ref,
    p.source_sheet, p.source_row, p.source_col, p.occurrence_index,
    CASE WHEN p.source = 'xlsx' THEN p.account_id END,
    CASE WHEN p.source = 'xlsx' THEN p.amount_cents END,
    p.created_at
FROM payments p
ORDER BY p.id;

-- EXPENSE split: +amount on the mapped category account (or Uncategorized).
INSERT INTO splits (transaction_id, account_id, amount_cents, reconcile_state)
SELECT
    p.id,
    COALESCE(
        m.account_id,
        (SELECT u.id FROM accounts u WHERE u.system_role = 'uncategorized')
    ),
    p.amount_cents,
    'n'
FROM payments p
LEFT JOIN legacy_category_map m ON m.category_id = p.category_id
ORDER BY p.id;

-- Funding split: -amount on the paying account.
INSERT INTO splits (transaction_id, account_id, amount_cents, reconcile_state)
SELECT p.id, p.account_id, -p.amount_cents, 'n'
FROM payments p
ORDER BY p.id;

-- ---------------------------------------------------------------------------
-- 5. Drop retired tables, recreate indexes
-- ---------------------------------------------------------------------------

DROP TABLE payment_exports;
DROP TABLE gnucash_matches;
DROP TABLE payments;
DROP TABLE categories;

CREATE INDEX idx_transactions_date ON transactions (date);
CREATE INDEX idx_transactions_payee_id ON transactions (payee_id);
CREATE INDEX idx_splits_transaction_id ON splits (transaction_id);
CREATE INDEX idx_splits_account_id ON splits (account_id);

-- Collision-safe identity for xlsx rows (the exact 0003 key, with account and
-- amount snapshotted on the transaction).
CREATE UNIQUE INDEX idx_transactions_xlsx_identity
ON transactions (
    payee_id,
    import_account_id,
    date,
    import_amount_cents,
    source_sheet,
    source_row,
    source_col,
    occurrence_index
)
WHERE source = 'xlsx';

-- Speeds potential-duplicate checks that compare business fields first.
CREATE INDEX idx_transactions_xlsx_business
ON transactions (source, payee_id, import_account_id, date, import_amount_cents);
