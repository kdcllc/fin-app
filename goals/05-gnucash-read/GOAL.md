# Goal 05 — GnuCash Read Integration + QIF Export

**Milestone:** v0.3 · **Depends on:** Goal 03

## Objective

Safe one-way-each-direction integration with GnuCash (research §4, tiers 1 and 3): read the GnuCash SQLite book directly for bank transactions and balances; push fin-app payments toward GnuCash via QIF/CSV files that GnuCash's built-in import assistant consumes (duplicate detection included, zero corruption risk).

## Prerequisite

User's GnuCash book must be saved in **sqlite3 format** (GnuCash: File → Save As → sqlite3). The app should detect an XML book and walk the user through this one-time conversion.

## Success criteria

- Fin-app lists the GnuCash account tree and imports transactions from selected accounts as payments, with dedup on re-import.
- Account/category mapping (fin-app entities ↔ GnuCash account GUIDs) is persisted and editable.
- Exported QIF imports cleanly into GnuCash 5.x with correct accounts, dates, amounts.
- Reconciliation view flags fin-app payments with no matching GnuCash transaction and vice versa.
- All GnuCash file access in this goal is **read-only** — enforced in code (read-only connection flag).

## Tasks

1. [GnuCash SQLite reader (read-only)](tasks/01-gnucash-reader.md)
2. [Account & category GUID mapping](tasks/02-account-mapping.md)
3. [Transaction import → payments](tasks/03-transaction-import.md)
4. [QIF/CSV export for GnuCash import](tasks/04-qif-export.md)
5. [Reconciliation view](tasks/05-reconciliation.md)
