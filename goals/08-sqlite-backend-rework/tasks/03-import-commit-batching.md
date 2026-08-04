# Task 08.3 — Import commit as one atomic batch

Status: done

## Objective

`commitReviewedImport` (`src/core/import-review.ts`) builds the complete statement list for a reviewed import — entity get-or-create, payment inserts, `import_log` append — and submits it as one `db.batch()` call: genuinely atomic, one IPC round trip, one fsync. Dedup annotation before review becomes one batched query pass instead of two queries per row.

## Notes

- Layer(s) touched: ts-core.
- CONSTRAINT: `payees`, `accounts`, and `categories` have NO unique constraint on name (`0001_schema_v1.sql`), and none is added in this goal. `INSERT OR IGNORE` therefore provides no dedup and must NOT be the mechanism; unconstrained subquery-by-name id resolution is ambiguous if duplicates ever exist.
- Recommended statement-building approach (executor may substitute an equivalent that preserves the acceptance criteria): decide new-vs-existing per entity in TS using the already-loaded entity maps (current `keyOf` trim + case-insensitive semantics). For entities that exist, bind their known integer ids directly into the payment inserts. For genuinely new entities, emit one plain `INSERT` each (TS dedups new names via the map, so each name is inserted at most once per batch), and have payment inserts resolve those ids with a deterministic scalar subquery on the exact TS-normalized name bound as a parameter, e.g. `(SELECT MIN(id) FROM payees WHERE name = ?)` — `MIN(id)` as a determinism guard, matching the exact string the batch itself just inserted.
- Visibility parity requirement: the TS entity maps used for new-vs-existing resolution must see the same row set the SQL subqueries see. The current loader (`loadEntityMaps` in `src/core/import-review.ts`) loads categories via plain `list()`, which excludes archived rows, while a name subquery scans all rows — an archived category whose name reappears would be misclassified as "new", duplicated, and then resolved to the archived row's id. Load categories with archived rows included (mirroring payees/accounts `includeArchived: true`) or otherwise resolve archived-name collisions deterministically, and state the chosen behavior in the completion report.
- Entity idempotency is proven at the table level: committing the same fixture twice must create zero new rows in `payees`, `accounts`, and `categories` on the second run (acceptance criterion below).
- Skip/insert decisions (exact duplicates, potential-duplicate keep/skip, `assertCommitable` gating) are computed in TS before the batch is built, using one batched existing-rows query: a new payments-repository method that fetches all existing xlsx payments matching any of the review rows' business-key tuples `(payee_id, account_id, date, amount_cents)` in a single chunked `SELECT` (VALUES-join or IN-tuple form), replacing per-row lookups. No such method exists at HEAD — it is created in this task. Counting logic (`inserted_count`, skip counters) is derived from the built statement list, not from per-row round trips.
- `annotateImportRowsWithDedup` is reworked to a single batched query for all rows (exact + potential classification computed in TS from the result set), replacing the per-row `checkXlsxDedup` loop. Keep `checkXlsxDedup` for single-row callers if any remain; remove it if dead.
- Zero-silent-drops invariant holds: every review row is accounted for as inserted, skipped-exact, or skipped-potential; totals must reconcile with the input row count.
- The `fail_after_insert_count` test hook must still prove rollback: reimplement as an injected poison statement at position N in the batch (or equivalent), asserting zero rows persist.
- Progress semantics change from per-row to per-stage: `reading → annotating → building → committing → done` (final shape may be adjusted in 08.4, but the `on_progress` contract is defined here). Per-row progress during commit is impossible and unnecessary with a single batch.
- Tests-first encouraged: `tdd` skill applies (this is core parser/writer-adjacent logic with existing fixtures).

## Acceptance criteria

- The commit path issues exactly one `db.batch()` call per import commit (assertable via the test adapter's call recording); no `insert`/`execute` calls escape the batch.
- Vitest: fixture import commits atomically — injected mid-batch failure leaves `payments`, `payees`, `accounts`, `categories`, `import_log` all unchanged.
- Vitest: idempotency invariants from Goal 02 still pass — identical re-import inserts zero payments; one-new-cell variant proposes exactly one.
- Vitest: entity idempotency — committing the same fixture twice creates zero new `payees`, `accounts`, or `categories` rows on the second run, asserted by table row counts.
- Vitest: dedup annotation for N rows issues a bounded number of queries independent of N (≤ a small constant plus chunking), verified via call counting.
- Reconciliation: for every commit, `inserted_count + skipped_exact_duplicates + skipped_potential_duplicates == input rows`, enforced by test.
- `npm test` and `npm run lint` are green.
