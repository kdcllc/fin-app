# Task 08.5 — Rework test coverage

Status: done

## Objective

The gap that let Goal 02 ship broken — production transactional behavior verified only against a different engine — is closed: the Rust backend's transaction, migration, and batch semantics are covered by `cargo test`; the TS/Rust contract is pinned by a parity suite; and the end-to-end import invariants (persistence, atomicity, idempotency, speed) are asserted with fixtures.

## Notes

- Layer(s) touched: tests (Vitest + cargo). Fixtures-only; never live user data.
- Rust (`src-tauri`, extending 08.1's tests): batch with hundreds of statements commits in one transaction (verify via `user_version`-style probes or row counts before/after); error on statement k reports index k and rolls back; concurrent command invocations serialize on the mutex without deadlock; WAL + FK pragmas verified on a fresh open; migration runner refuses nothing on re-open (idempotent).
- Vitest contract parity: one shared spec file executed against the better-sqlite3 adapter asserting the exact `batch`/`transaction` semantics the Rust backend implements (documented as the contract; the Rust side asserts the same behaviors in cargo tests). Any divergence found must be fixed in the adapters, not papered over in tests.
- Vitest import end-to-end (existing fixture workbook + variants under `tests/fixtures/excel/`): full parse → annotate → commit pipeline; re-import zero-insert; one-new-cell variant; mid-batch failure rollback; reconciliation invariant (`parsed + unparsed == non_empty_cells` and commit counts reconcile).
- Speed guard: a generated ≥ 1,000-payment fixture commits via a single batch call; assert the call count (1 batch) and keep a wall-clock measurement in the test output for the completion report (no flaky hard time assertion in CI; the < 5 s goal criterion is verified on the dev machine and recorded as QA evidence).
- Do not weaken or delete existing Goal 02/03 tests; they must all pass on the new backend-shaped seam.

## Acceptance criteria

- `npm test` and `cargo test` (from `src-tauri/`) pass in full.
- Coverage exists for every failure mode found in the diagnosis: phantom-commit data loss (rollback test), lock stalls (serialization test), per-row round-trip explosion (call-count test), silent error swallowing (error-propagation test asserting rejected promises carry the SQLite message).
- The 1,000-payment fixture commit is asserted to use exactly one batch call, with measured duration recorded in the completion report.
- `npm run lint` and `cargo clippy -- -D warnings` are clean.
