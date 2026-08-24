# GnuCash test fixture book

## What this is

`fixture-book.sql` is a **hand-authored SQL script** that materializes a minimal GnuCash 5.x-shaped SQLite3 book for automated tests. It follows the table layout documented on the [GnuCash SQL wiki](https://wiki.gnucash.org/wiki/SQL) and the fin-app `gnucash-data-model` skill.

The script is applied to an empty SQLite database at test time (see `gnucash_reader.rs` test helpers). No compressed XML, no real user books, and no GnuCash GUI are involved.

## How it was derived

- Schema tables: `versions`, `commodities`, `books`, `accounts`, `transactions`, `splits`, `slots` (empty), `gnclock` (empty).
- `post_date` values use GnuCash 5.x's stored format: **`YYYYMMDDHHMMSS`** with neutral time **`105900`** (see `docs/RESEARCH.md` §4 / piecash object model).
- Account tree: ROOT → Assets:Checking (BANK, `"Checking …9002"`), Liabilities:Visa (CREDIT), Expenses:Utilities:Electric, Expenses:Groceries, Income:Salary; plus a hidden `ROOT-template` branch with a template account excluded by the reader.
- **13 balanced transactions** span January and February 2026, including edge amounts **$10,673.91** and **$0.01**, and one transaction with an **inexact rational** (`1/3`) to exercise the `errors` path.

## Schema-version pin

The reader accepts a book only when the `versions` table has:

| `table_name`     | `table_version` | Role                                      |
|------------------|-----------------|-------------------------------------------|
| `Gnucash-Resave` | **19920**       | Compatibility gate (`SUPPORTED_GNUCASH_RESAVE`) |
| `Gnucash`        | 5000000         | Display-only `schemaVersion` on probe `ok` |

Any other `Gnucash-Resave` value → probe `unknown-schema`.

## Never use real books

Tests **must** build temp sqlite3 files from this fixture only. Never point tests at a user's real GnuCash book, live xlsx, or fin-app database.
