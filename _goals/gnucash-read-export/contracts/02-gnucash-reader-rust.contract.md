# Contract: 02-gnucash-reader-rust

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

02-gnucash-reader-rust

## done_definition

A new Rust module `src-tauri/src/gnucash_reader.rs` is the sole code path that opens a
GnuCash book file. It exposes three Tauri commands — `gnucash_probe_book`,
`gnucash_list_accounts`, and `gnucash_list_transactions` — registered in `lib.rs`, each
returning JSON that serde-serializes to the frozen TypeScript shapes in
`src/core/gnucash-types.ts` (field names and casing match exactly). All SQLite opens use
`OpenFlags::SQLITE_OPEN_READ_ONLY`; probe handles every input without panic; schema
compatibility gates on `versions.Gnucash-Resave = 19920`; transaction listing returns
`{ transactions, errors }` with integer-cent conversion and per-transaction error
surfacing. A committed fixture SQL book plus README live under `tests/fixtures/gnucash/`;
in-module Rust tests build temp sqlite3 books from that fixture and prove probe matrix,
read-only enforcement, account paths, date windowing, edge amounts, and the inexact-rational
error path. `cargo test gnucash --manifest-path src-tauri/Cargo.toml` and
`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` (scoped to the new
module or full crate per project convention) pass clean.

## acceptance_criteria

### Module layout and write fence

1. File `src-tauri/src/gnucash_reader.rs` exists and is the only Rust module that opens
   or reads GnuCash book files. — verification: file inspection; `grep -r gnucash`
   under `src-tauri/src/` shows book access confined to `gnucash_reader.rs` (plus
   `lib.rs` registration).

2. `src-tauri/src/lib.rs` gains only: `mod gnucash_reader;` and three entries in
   `tauri::generate_handler![…]` for `gnucash_reader::gnucash_probe_book`,
   `gnucash_reader::gnucash_list_accounts`, and
   `gnucash_reader::gnucash_list_transactions`. No other `lib.rs` edits. — verification:
   read `lib.rs`; `git diff src-tauri/src/lib.rs` limited to module decl + handler list.

3. No edits to `src-tauri/src/db.rs`, any `src/core/*` file, or any UI file. —
   verification: `git diff --name-only` against task baseline excludes those paths.

### Serde / IPC shape fidelity (`src/core/gnucash-types.ts`)

4. Rust response structs/enums serde-serialize to JSON keys matching the frozen TS types
   exactly — snake_case where TS declares snake_case (`txn_guid`, `value_cents`,
   `full_path`, `account_type`, `parent_guid`, `commodity_mnemonic`,
   `commodity_fraction`, `split_guid`, `account_guid`, `post_date`, etc.). — verification:
   unit test deserializes command return JSON with `serde_json` into a schema-checked
   snapshot or field-by-field assertions against expected key names; read `#[serde(...)]`
   attributes on Rust types.
    evaluator-note (pin serde): JSON keys must match `src/core/gnucash-types.ts` exactly.
    snake_case everywhere (`txn_guid`, `value_cents`, `full_path`, `account_type`,
    `parent_guid`, `commodity_mnemonic`, `commodity_fraction`, `split_guid`,
    `account_guid`, `post_date`, `placeholder`, `guid`, `name`, `memo`, `description`,
    `transactions`, `errors`, `reason`, `detail`, `status`). The sole camelCase field is
    `schemaVersion` on the probe `ok` variant. `parent_guid` may be JSON `null` (ROOT).
    Do NOT copy `#[serde(rename_all = "camelCase")]` from `xlsx_reader.rs` / `db.rs`.

5. `GnucashBookProbe` serializes as an externally tagged union on `status` with variants:
   `{ "status": "ok", "schemaVersion": <number> }` (note: `schemaVersion` is camelCase per
   TS), `{ "status": "xml" }`, `{ "status": "unknown-schema", "detail": "<string>" }`,
   `{ "status": "missing" }`, `{ "status": "unreadable", "detail": "<string>" }`. —
   verification: unit test on probe responses asserts JSON shape and key casing.
    evaluator-note (pin serde): The JSON examples and TS union are LAW. Implement with
    serde internally tagged `#[serde(tag = "status")]` so the wire shape is
    `{ "status": "ok", "schemaVersion": n }` — not serde's default externally tagged
    `{ "ok": { ... } }`. The phrase "externally tagged" in this criterion is
    TypeScript-union wording, not serde External tagging.

6. `GnucashAccount` JSON objects include exactly: `guid`, `name`, `account_type`,
   `parent_guid`, `placeholder`, `commodity_mnemonic`, `commodity_fraction`, `full_path`
   (all snake_case). — verification: account-list unit test asserts keys on at least one
   returned account.

7. `GnucashTransactionList` JSON is `{ "transactions": [...], "errors": [...] }` where
   each transaction has `txn_guid`, `post_date`, `description`, `splits` (array of objects
   with `split_guid`, `account_guid`, `memo`, `value_cents`), and each error has
   `txn_guid`, `post_date`, `description`, `reason`. — verification: transaction-list
   unit test asserts top-level keys and nested split/error keys.

8. No `f64` / float fields appear in serialized money values; `value_cents` is a JSON
   integer. — verification: read Rust types (integer types only for cents); unit test
   asserts `value_cents` deserializes as `i64`/`i32` without fractional part.

9. Constant `SUPPORTED_GNUCASH_RESAVE` value `19920` is defined in Rust (or inlined) and
   matches `src/core/gnucash-types.ts`. — verification: read both files; probe test uses
   `19920` as the supported pin.

### `gnucash_probe_book(path)` — magic-byte matrix and schema gate

10. Missing path (file does not exist) returns probe `{ status: "missing" }` without
    panic. — verification: `cargo test` probe test with nonexistent path.

11. File whose leading bytes are `SQLite format 3\0` (16 bytes) and whose `versions` table
    has `Gnucash-Resave = 19920` returns `{ status: "ok", schemaVersion: <n> }` where
    `<n>` is the integer value of the `versions` row with key `Gnucash` (display-only per
    task 01 JSDoc). — verification: probe test against temp book built from fixture SQL.

12. File with `SQLite format 3\0` prefix but `Gnucash-Resave` ≠ `19920` returns
    `{ status: "unknown-schema", detail: "<found-value-as-string>" }` where `detail`
    contains the actual stored value (e.g. `"19919"` or `"0"`), never panics. —
    verification: probe test mutates `versions` row in a temp copy and asserts variant +
    `detail`.

13. File whose first two bytes are `\x1f\x8b` (gzip magic) returns `{ status: "xml" }`
    (guides one-time sqlite3 conversion per goal) without attempting SQLite open. —
    verification: probe test writes gzip magic bytes to temp file.
    evaluator-note (pin c): gzip and plain-XML both mapping to `{ status: "xml" }` — approved.

14. File whose leading bytes match a plain-XML prefix (starts with `<?xml` or equivalent
    XML declaration bytes used by GnuCash XML books) returns `{ status: "xml" }` without
    SQLite open. —     verification: probe test writes `<?xml version="1.0"?>` prefix to temp
    file.
    evaluator-note (pin e): `<?xml` prefix heuristic — approved (gzip magic covers
    compressed books; plain `<?xml` covers uncompressed). No XML parse.

15. Existing regular file that is neither sqlite3, gzip, nor plain-XML (e.g. random
    garbage bytes `"not a gnucash book"`) returns `{ status: "unreadable", detail: "<non-empty
    string>" }` without panic. — verification: probe test with garbage temp file.

16. Probe never panics on any input (including empty file, directory path if passed,
    unreadable permissions where the platform allows creating the test). — verification:
    probe tests cover edge inputs; test binary exits 0.

17. Probe reads `versions` for schema gate only — no writes to `versions` or `slots`. —
    verification: read `gnucash_probe_book` implementation; file-byte hash unchanged
    after probe (see read-only criteria).

### Read-only enforcement

18. Every SQLite connection to a GnuCash book opens with
    `rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY` (no `SQLITE_OPEN_CREATE`, no write
    flags). — verification: read source for `Connection::open_with_flags` (or
    equivalent); grep module for `OpenFlags`.

19. A unit test attempts a write statement (e.g. `INSERT` or `CREATE TABLE`) on a
    connection opened by the reader code path and asserts failure (error returned, no
    successful mutation). — verification: `cargo test` read-only write-attempt test.

20. After `gnucash_probe_book`, `gnucash_list_accounts`, and `gnucash_list_transactions`
    each run against the same temp book file, the file's byte content (SHA-256) is
    identical to before the operation. — verification: `cargo test` hashes book before/after
    each command (or one combined test exercising all three).

### `gnucash_list_accounts(path)` — account tree

21. Command queries `accounts` joined to `commodities` and returns a JSON array of
    account objects. — verification: read SQL in module; account-list test returns
    non-empty vec for fixture book.

22. Each account includes: `guid`, `name`, `account_type`, `parent_guid`, `placeholder`,
    `commodity_mnemonic`, `commodity_fraction`, `full_path`. — verification: account-list
    test asserts all fields present on fixture accounts.

23. `full_path` is colon-joined ancestor names from root downward, **excluding** the ROOT
    account name from the path (e.g. `Expenses:Utilities:Electric`, not
    `ROOT:Expenses:…`). — verification: account-list test asserts `full_path` for
    `Expenses:Utilities:Electric` and other fixture accounts.

24. Hidden template accounts under `ROOT-template` are **excluded** from the returned
    list. — verification: account-list test asserts no returned account has a
    `full_path` or name chain indicating `ROOT-template` descendants; if fixture includes
    a template row, it is absent from output.

25. Fixture account tree includes at minimum: `Assets:Checking` (BANK, name matching
    last4-style `"Checking …9002"` or equivalent ellipsis/unicode per fixture), `Liabilities:Visa`
    (CREDIT), `Expenses:Utilities:Electric` and `Expenses:Groceries` (EXPENSE),
    `Income:Salary` (INCOME). — verification: account-list test finds these `full_path`
    values (or name + type pairs) in output.

26. `placeholder` reflects the GnuCash `accounts.placeholder` column (boolean). —
    verification: account-list test asserts `placeholder` on at least one known fixture
    account if fixture sets it; field is always present.

27. `commodity_fraction` comes from the joined commodity row (e.g. `100` for USD cents). —
    verification: account-list test asserts `commodity_fraction == 100` for USD accounts
    in fixture.

### `gnucash_list_transactions(path, account_guids, from, to)`

28. Command signature matches task: `(path: String, account_guids: Vec<String>, from:
    String, to: String)` (or equivalent Tauri-compatible types). — verification: read
    `#[tauri::command]` signature.

29. Return type serializes to `GnucashTransactionList`: `{ transactions, errors }`. —
    verification: transaction-list unit test asserts both top-level arrays exist.

30. Only transactions with `post_date` normalized to `YYYY-MM-DD` falling inclusively in
    `[from, to]` are eligible. — verification: windowing test with narrow date range
    returns expected subset count from fixture (≥ 12 total transactions across 2 months in
    fixture; filtered window returns proper subset).

31. `post_date` normalization reads the exact string format stored in the fixture's
    `transactions.post_date` column (implementation must match fixture, not invent a
    format). — verification: read fixture SQL for raw date strings; unit test asserts
    normalized output equals expected `YYYY-MM-DD` for known fixture txn.
    evaluator-note (pin f): date normalization from the fixture's stored format — approved.
    Read `transactions.post_date` as written in `fixture-book.sql`; do not invent a format.

32. A transaction is included only if it has **at least one split** whose `account_guid`
    is in `account_guids`. — verification: windowing test passes single account GUID and
    confirms returned txns all touch that account.

33. Returned splits for each transaction are those belonging to accounts in
    `account_guids` (splits on other accounts in the same txn are omitted). —
    verification: transaction-list test on a known multi-split txn asserts split
    `account_guid` membership.
    evaluator-note (pin a — CRITICAL, OVERRIDES this criterion's body and verification):
    `gnucash_list_transactions` returns each matching transaction with ALL of its splits,
    NOT filtered to `account_guids`. Criterion 32 still governs which transactions appear
    (at least one split on a requested account). Once included, every split on that
    transaction is returned. Reason: task 04 derives category from the EXPENSE split,
    which lives outside the requested funding accounts; filtered splits make import
    unimplementable. Replacement verification: list a known two-split expense (funding +
    EXPENSE) with only the funding account GUID in `account_guids`; assert both splits
    are present and the EXPENSE split's `account_guid` is NOT in the request list.

34. `value_cents` converts from split `value_num` / `value_denom` scaled by the account
    commodity `fraction` using **integer arithmetic only** (no floats in conversion path).
    — verification: read conversion function (integer ops); clippy/no float lint; edge-amount
    tests below.

35. Edge amount `$10,673.91` appears in fixture as a balanced transaction; listing that
    txn yields split `value_cents` of `1067391` (sign per split direction). —
    verification: unit test asserts exact cent value.

36. Edge amount `$0.01` appears in fixture; listing yields split `value_cents` of `1` (or
    `-1` per sign convention, test documents expected sign for the fixture split). —
    verification: unit test asserts exact cent value.
    evaluator-note (pin b): `value_cents` is SIGNED as stored per split direction.
    Fixture tests document expected signs: funding split negative for expenses, expense
    split positive (matches gnucash-data-model: positive EXPENSE / negative BANK|CREDIT).

37. One fixture transaction has an **inexact** rational (numerator/denominator not
    exactly representable in cents at the commodity fraction) or **malformed** rows (e.g.
    missing split, null guid, zero denominator — implementer picks one case in fixture);
    listing returns that txn in `errors`, not `transactions`. — verification: unit test
    asserts `errors` contains entry with matching `txn_guid`.
    evaluator-note (pin d): inexact-vs-malformed fixture choice is implementer freedom.
    Required: exactly one txn in `errors[]` with `txn_guid` + non-empty `reason`.

38. Error entry includes `txn_guid`, `post_date` (string or `null`), `description`
    (string or `null`), and non-empty `reason` explaining inexact conversion or malformed
    data. — verification: unit test asserts all fields on the inexact/malformed fixture
    txn error.

39. Inexact/malformed transactions are **never** silently rounded, dropped, or returned in
    `transactions`; the command still succeeds with `{ transactions, errors }`. —
    verification: same test asserts `Ok(...)` return and error vec non-empty for bad txn.

40. Valid transactions in the same call are still returned in `transactions` when another
    txn errors. — verification: list call asserts `transactions.len() >= 1` alongside
    `errors.len() >= 1`.

### Fixture `tests/fixtures/gnucash/fixture-book.sql`

41. File exists and contains SQL DDL/DML that materializes a realistic GnuCash 5.x
    sqlite3 book with tables per `docs/RESEARCH.md` §4 / gnucash-data-model skill:
    `versions`, `commodities`, `accounts`, `transactions`, `splits`, `slots`; `gnclock`
    table present and **empty** (zero rows). — verification: file inspection; temp-book
    test `SELECT COUNT(*) FROM gnclock` → 0.

42. `versions` includes row `Gnucash-Resave = 19920`. — verification: read SQL or query
    temp book after apply.

43. Account tree matches criterion 25 (Checking …9002, Visa, Electric, Groceries,
    Salary). — verification: read SQL; account-list test.

44. ≥ 12 **balanced** transactions (sum of split values = 0 per txn) spanning **2
    calendar months**. — verification: read SQL; optional integrity query in test
    `SUM(value_num * …)` per txn guid.

45. Includes transactions with edge amounts `$10,673.91` and `$0.01`. — verification:
    read SQL split values; edge-amount tests.

46. Includes exactly one transaction engineered for the inexact/malformed `errors`
    path. — verification: read SQL; error-path test.

47. Fixture is self-contained SQL (applied to empty sqlite DB produces a valid book). —
    verification: test helper executes SQL into temp file and opens read-only.

### Fixture `tests/fixtures/gnucash/README.md`

48. README documents: (a) how `fixture-book.sql` was derived, (b) the schema-version pin
    (`Gnucash-Resave = 19920`), (c) that tests use this fixture only — never a user's real
    GnuCash book. — verification: read README sections.

### Rust unit tests (in-module)

49. Tests live in `#[cfg(test)] mod tests` inside `gnucash_reader.rs` (no new files under
    `tests/` required by this task). — verification: read module test module.

50. Test helper builds a temp sqlite3 book by executing `fixture-book.sql` (path via
    `CARGO_MANIFEST_DIR` → `../tests/fixtures/gnucash/fixture-book.sql`). —
    verification: read helper; tests pass without real user book.

51. Probe matrix tests cover: sqlite3+ok, sqlite3+wrong-Resave, gzip, plain-XML, missing,
    garbage (criteria 10–15). — verification: `cargo test gnucash_probe` or named tests
    in output.

52. Read-only tests cover criteria 19–20. — verification: `cargo test` output includes
    passing read-only tests.

53. Account-tree tests cover `full_path`, ROOT exclusion, ROOT-template exclusion,
    placeholder, commodity fraction (criteria 23–27). — verification: `cargo test`
    account tests pass.

54. Transaction tests cover windowing, date normalization, edge cents, error-path GUID +
    reason (criteria 30–40). — verification: `cargo test` transaction tests pass.
    evaluator-note (pin a): Criterion 33 coverage is the OVERRIDDEN all-splits test (pin a
    on 33), not filtered `account_guid` membership.

### Clippy and targeted test command

55. `cargo test gnucash --manifest-path src-tauri/Cargo.toml` exits 0. — verification:
    command output.

56. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` exits 0 (no new
    warnings from `gnucash_reader.rs`; pre-existing warnings elsewhere do not block if
    clippy was already clean on main — evaluator confirms no new denies from this module).
    — verification: command output; `git diff` scope.
    evaluator-note (pin g): clippy scope is no new warnings from the new module — approved.
    Pre-existing warnings elsewhere do not block this task.

### Safety guardrails (gnucash-data-model)

57. Module never writes to any GnuCash file, never opens XML for parsing (probe only),
    never mutates `slots` or `versions` beyond SELECT on `versions` for probe. —
    verification: read module; criteria 17, 20.

58. No PostgreSQL/MySQL backend code. — verification: read module (sqlite3 only).

## verification_environment

library (cargo test)

## out_of_scope

- TypeScript core modules (`src/core/gnucash-*.ts`) — frozen by task 01; this task only
  reads `gnucash-types.ts` as the IPC contract.
- GnuCash page UI and any frontend invoke wiring beyond what task 07 owns.
- Any write path to GnuCash files (insert/update/delete, `gnclock` manipulation).
- Changes to `src-tauri/src/db.rs` or fin-app book migrations.
- Dedicated test files under repo `tests/` (task 08); tests belong in-module per task.
- QIF/CSV export, import planning, mapping, reconcile logic (tasks 03–06).

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T13:15:00-04:00
    note: Achievable within the four-path write fence; lib.rs is targeted-insertion only.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T14:20:00-04:00
    note: Counter-signed with orchestrator pins a–g; criterion 33 OVERRIDDEN (return ALL splits). Serde keys match gnucash-types.ts (snake_case; schemaVersion camelCase).
revision: 0
```
