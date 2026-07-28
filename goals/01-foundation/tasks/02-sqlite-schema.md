# Task 01.2 — SQLite schema v1 + migrations

Status: todo
Depends on: 01-scaffold-tauri

## Objective

Define schema v1 and wire up `tauri-plugin-sql` (SQLite) with its versioned migration system so every future schema change is a migration from day one.

**Book path for this task:** use a fixed default dev path (app-data directory, e.g. via Tauri's `appDataDir()`); the user-chosen location and first-run prompt arrive in task 04, which supersedes this default.

## Schema v1 (from research §5)

- `accounts` — id, name, kind (checking|credit|cash), last4, gnucash_guid (nullable), archived
- `payees` — id, name, default_category_id, default_account_id, notes, archived
- `categories` — id, name, parent_id (nullable), gnucash_guid (nullable)
- `payments` — id, payee_id, account_id, category_id, date, amount_cents (integer), memo, source (manual|xlsx|gnucash), external_ref (nullable), created_at
- `recurring_bills` — id, payee_id, frequency (monthly|quarterly|annual), expected_amount_cents (nullable), due_day, active
- `import_log` — id, source_file, content_hash, imported_at, row_count

## Notes

- Store amounts as integer cents — never floats (finance).
- Index `payments(date)`, `payments(payee_id)`, `payments(category_id)` for report queries.

## Acceptance criteria

- Fresh app run creates the DB at the default dev path with schema v1 applied.
- A second migration (no-op test) applies cleanly on an existing DB, proving the migration path.
