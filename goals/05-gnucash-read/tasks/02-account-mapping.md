# Task 05.2 — Account & category GUID mapping

Status: todo

## Objective

The heart of the integration (research §4): persistent, editable mapping between fin-app entities and GnuCash accounts — fin-app `accounts` ↔ GnuCash BANK/CREDIT accounts, fin-app `categories` ↔ GnuCash EXPENSE accounts.

## Notes

- Mapping UI shows the GnuCash tree next to fin-app entities; suggest matches by name similarity and last4.
- Store `gnucash_guid` on `accounts`/`categories` (columns exist from Task 01.2).
- Handle unmapped on both sides gracefully: unmapped GnuCash accounts are simply not imported; unmapped fin-app entities are flagged before any export.

## Acceptance criteria

- Mappings survive restart and re-sync; remapping is possible without data loss.
- Suggestions correctly pair the obvious cases (e.g. checking …9002) in the fixture + real book.
