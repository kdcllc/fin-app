# Task 02: gnucash-reader-rust

## Objective

The single Rust module allowed to touch a GnuCash book: opens sqlite3 books strictly
read-only, probes format/schema, and exposes three Tauri commands returning the JSON
shapes frozen in `src/core/gnucash-types.ts` — plus a committed SQL fixture book and
Rust tests proving read-only enforcement and cent-exact rational conversion.

## Dependencies

- 01-contract-schema (frozen payload shapes)

```yaml
# --- task ownership contract ---
writes:
  - src-tauri/src/gnucash_reader.rs
  - src-tauri/src/lib.rs                      # module decl + 3 command registrations only
  - tests/fixtures/gnucash/fixture-book.sql
  - tests/fixtures/gnucash/README.md
reads:
  - src/core/gnucash-types.ts
  - src-tauri/src/db.rs
depends_on:
  - "01-contract-schema"
owner: implementer
rewrite_semantics: targeted-insertion   # lib.rs is a shared file
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `gnucash_probe_book(path)`: detects by magic bytes — `SQLite format 3\0` vs gzip
      (`\x1f\x8b`) vs plain-XML prefix → returns the `GnucashBookProbe` union: `xml`
      (guides conversion), `missing` (file absent), `unreadable`, `unknown-schema`, or
      `ok` with the version. The pin (frozen in task 01): `ok` requires the `versions`
      table to have key `Gnucash-Resave` = `SUPPORTED_GNUCASH_RESAVE` (19920); any
      other value → `unknown-schema` with the found value in `detail`. Never panics on
      any input file.
- [ ] All connections open with rusqlite `OpenFlags::SQLITE_OPEN_READ_ONLY` (no
      CREATE): a test proves an attempted write on this code path fails and the book
      file's bytes are unchanged after every reader operation.
- [ ] `gnucash_list_accounts(path)`: full account tree from `accounts` joined to
      `commodities` — guid, name, account_type, parent_guid, placeholder,
      commodity mnemonic + fraction, and computed colon-joined `full_path` (ROOT
      excluded from paths). Hidden template accounts under ROOT-template are excluded.
- [ ] `gnucash_list_transactions(path, account_guids, from, to)` returns the
      `GnucashTransactionList` shape frozen in task 01: `{ transactions, errors }`.
      Transactions have at least one split in the requested accounts, with post_date
      in `[from, to]` (dates normalized to `YYYY-MM-DD` from GnuCash's stored format —
      read the format from the fixture, don't guess). Each split carries `value_cents`
      converted from `value_num/value_denom` scaled by the commodity fraction —
      integer arithmetic only, no floats anywhere. A transaction whose conversion is
      inexact or whose rows are malformed becomes a `GnucashTransactionError` entry
      (`txn_guid`, `post_date`, `description`, `reason`) in `errors` — never silently
      rounded, never dropped, never failing the whole call.
- [ ] `tests/fixtures/gnucash/fixture-book.sql` materializes a realistic GnuCash 5.x
      sqlite3 book (schema per docs/RESEARCH.md §4: `versions`, `commodities`,
      `accounts`, `transactions`, `splits`, `slots`, `gnclock` empty): account tree
      with ROOT → Assets:Checking (BANK, last4-style name "Checking …9002"),
      Liabilities:Visa (CREDIT), Expenses:Utilities:Electric + Expenses:Groceries
      (EXPENSE), Income:Salary; ≥ 12 balanced transactions across 2 months including
      edge amounts $10,673.91 and $0.01; one transaction with an inexact/malformed
      rational to exercise the `errors` path; `versions` row `Gnucash-Resave` = 19920.
      README documents how it was derived, the schema-version pin, and that real books
      are never used in tests.
- [ ] Rust unit tests (in-module, temp-dir book built from the fixture SQL): probe on
      sqlite3/gzip/missing/garbage files and on a wrong `Gnucash-Resave` value;
      account tree shape + full paths; transaction windowing; cent-exact conversion
      for the edge amounts; the inexact-rational transaction landing in `errors` with
      its GUID and reason; read-only enforcement.
- [ ] Commands registered in `lib.rs` `generate_handler!`; `cargo clippy` clean for the
      new module.

## Files to Read

- `.claude/skills/gnucash-data-model/SKILL.md` — MANDATORY: backends, data model,
  read-tier rules
- `docs/RESEARCH.md` §4 — GnuCash sqlite3 schema ground truth
- `src/core/gnucash-types.ts` — frozen payload shapes (do not change them)
- `src-tauri/src/xlsx_reader.rs` — existing command style/error mapping to follow
- `.cursor/rules/rust-backend.mdc` — Rust rules

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: serde-serialize responses to exactly the TypeScript shapes from task 01;
  integer arithmetic for money; treat the fixture as the source of truth for GnuCash
  date formats.
- Must NOT: write to any GnuCash file, touch `slots`/`versions` beyond reading the
  schema version, add any non-read-only open path, edit `db.rs`, or modify
  `src/core/*`.

## Verification

- Targeted test command: `cargo test gnucash --manifest-path src-tauri/Cargo.toml`
- Evidence: test output showing read-only-enforcement and edge-amount tests passing.
