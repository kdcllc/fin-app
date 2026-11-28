# `src/core` — the data-access layer

Platform-agnostic core in the Actual Budget mold (docs/RESEARCH.md §3): all
domain data access lives here, behind one small seam, so the React shell stays
thin and the whole layer is testable without the Tauri runtime.

## Boundary rule

**Code outside `src/core/` imports from `src/core` (the public entry,
`index.ts`) only.** Deep imports into `core/adapters/*`, `core/repositories/*`,
etc. are forbidden and blocked by the `no-restricted-imports` rule in
`eslint.config.js`. Consequences:

- **All SQL lives in `core/repositories/`** — UI components never issue
  queries, never import a SQL driver, never see a connection. Exceptions:
  exactly `import-review.ts`, `gnucash-import.ts`, and `report-queries.ts`, which
  embed module-level SQL for cross-entity queries no repository covers (no module
  owns its own tables any more). `ledger.ts` contains no SQL — it calls `LedgerRepo`.
- Business logic lives in TypeScript over the app-owned Rust SQLite backend
  (`src-tauri/src/db.rs`, a dumb executor). Other Rust commands are reserved
  for what genuinely needs Rust (xlsx parsing via `calamine`, GnuCash file
  access) — not for CRUD.

## Shape

| Module                    | Role                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `db.ts`                   | The seam: minimal `Database` interface (`execute`/`select`/`batch`, `?` placeholders only).   |
| `entities.ts`             | Entity types: legacy facade types (`Account`, `Payment`, `Category`, …) and ledger types (`LedgerAccount`, `Transaction`, `Split`, `AccountType`, `ReconcileState`). |
| `errors.ts`               | Typed errors (`ForeignKeyViolationError`) + driver-error mapping.                             |
| `repositories/`           | One repository per entity; the home of SQL strings (see Boundary rule exceptions). `payments`/`categories`/`accounts`/`payees` are facades over the ledger. |
| `repositories/ledger.ts`  | `LedgerRepo`: the ledger's SQL over `accounts`/`transactions`/`splits`.                       |
| `ledger.ts`               | Ledger domain API (post/update/delete/get transaction, register, account tree, balances, transfer, income, opening balance); no SQL. |
| `gnucash-types.ts`        | Frozen GnuCash IPC types + `SUPPORTED_GNUCASH_RESAVE`.                                        |
| `gnucash-mapping.ts`      | Account/category ↔ GnuCash GUID suggestions + apply via repositories.                         |
| `gnucash-import.ts`       | Review-plan + transactional commit of GnuCash transactions as payment-shaped ledger transactions. |
| `adapters/rust-sqlite.ts` | Production adapter over the Rust backend commands (`db_select`/`db_execute`/`db_batch`).      |
| `index.ts`                | Public entry: types, errors, `createRepositories`, `openRustSqliteDatabase`; re-exports GnuCash modules, the ledger API, and `LedgerRepo`. |

Two adapters satisfy the `Database` seam: the rust-sqlite one above (wired by
the app), and a better-sqlite3 adapter in `tests/support/test-db.ts` (wired by
Vitest, applying the same migration files from `src-tauri/migrations/` to an
in-memory database) — so `npm test` exercises the real schema with no Tauri
runtime. A shared contract suite (`tests/support/db-contract.ts`) pins the
`batch`/`transaction` semantics both adapters must share.

## Conventions

- **Money is integer cents** (`*_cents: number`), never floats — project-wide
  non-negotiable.
- **Split sign convention** — `splits.amount_cents` is debit-positive and a
  transaction's splits sum to 0 (unbalanced transactions are rejected). Display
  uses natural sign: LIABILITY, INCOME and EQUITY balances are negated
  (`naturalBalance`).
- Dates are ISO-8601 TEXT (`YYYY-MM-DD`); timestamps come from SQLite
  `datetime('now')` defaults.
- `archived`/`active` flags surface as booleans; repositories convert to and
  from SQLite 0/1 at the row boundary.
- Archiving is a soft delete: archived accounts/payees/categories drop out of default
  `list()` results but `get()` and payment history keep working.

## Typical use

```ts
import { createRepositories, openRustSqliteDatabase } from "./core";

const db = await openRustSqliteDatabase("/home/me/books/fin-app.db");
const repos = createRepositories(db);
const february = await repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
```
