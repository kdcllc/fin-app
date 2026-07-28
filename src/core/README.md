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
  queries, never import a SQL driver, never see a connection.
- Business logic lives in TypeScript over `tauri-plugin-sql`. Rust commands
  are reserved for what genuinely needs Rust (xlsx parsing via `calamine`,
  GnuCash file access) — not for CRUD.

## Shape

| Module                  | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `db.ts`                 | The seam: minimal `Database` interface (`execute`/`select`, `?` placeholders only). |
| `entities.ts`           | Entity types mirroring `src-tauri/migrations/0001_schema_v1.sql` field-for-field.   |
| `errors.ts`             | Typed errors (`ForeignKeyViolationError`) + driver-error mapping.                   |
| `repositories/`         | One repository per entity; the only home of SQL strings.                            |
| `adapters/tauri-sql.ts` | Production adapter over `tauri-plugin-sql`.                                         |
| `index.ts`              | Public entry: types, errors, `createRepositories`, `openTauriDatabase`.             |

Two adapters satisfy the `Database` seam: the Tauri one above (wired by the
app), and a better-sqlite3 adapter in `tests/support/test-db.ts` (wired by
Vitest, applying the same migration files from `src-tauri/migrations/` to an
in-memory database) — so `npm test` exercises the real schema with no Tauri
runtime.

## Conventions

- **Money is integer cents** (`*_cents: number`), never floats — project-wide
  non-negotiable.
- Dates are ISO-8601 TEXT (`YYYY-MM-DD`); timestamps come from SQLite
  `datetime('now')` defaults.
- `archived`/`active` flags surface as booleans; repositories convert to and
  from SQLite 0/1 at the row boundary.
- Archiving is a soft delete: archived accounts/payees drop out of default
  `list()` results but `get()` and payment history keep working.

## Typical use

```ts
import { createRepositories, openTauriDatabase } from "./core";

const db = await openTauriDatabase("sqlite:fin-app.db");
const repos = createRepositories(db);
const february = await repos.payments.list({ from: "2026-02-01", to: "2026-02-28" });
```
