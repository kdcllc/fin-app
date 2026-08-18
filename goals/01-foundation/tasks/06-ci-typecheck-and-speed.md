# Task 01.6 — Typecheck in CI and faster quality jobs

Status: done (judge PASS 5/5, 2026-08-17)
Depends on: 01.5 (quality-checks Linux deps exist)

## Objective

`tauri-apps/tauri-action` runs `npm run build` (`tsc && vite build`). ESLint and Vitest do not typecheck, so CI quality-checks can pass while all three OS builds fail. Today `npx tsc --noEmit` reports the errors listed below. After this task, typecheck is a first-class quality-js step (before any Rust work), JS and Rust quality jobs run in parallel, and the Rust job uses cheap debug info so a cold compile is less than a 36-minute sequential job.

User decision 2026-08-17: keep the 3-OS Tauri matrix on every push/PR. Do not move it to tags-only.

## Current `tsc` errors (all must be gone)

Exact list from `npx tsc --noEmit` on this tree:

1. `src/core/cell-parser.ts:75` — `replaceAll` not on `string` (`lib` is ES2020).
2. `src/core/payee-normalization.ts:54` and `:58` — same `replaceAll`.
3. `src/core/payee-normalization.ts:218` — `payee` possibly `null` (`inheritsHeader` boolean does not narrow `activeGroupHeader`).
4. `src/core/payee-normalization.ts:226` and `:233` — follow-on: `payee: string | null` vs `string`.
5. `src/core/repositories/payments.ts:71` — `K` cannot index `PaymentPatch`.
6. `src/pages/BillsGridPage.tsx:179` — `defaults.payee_id` is `number | null` but `ManualPaymentInput.payee_id` is `number`.
7. `src/pages/ImportPage.tsx:626` — `match_count` on `ImportDedupState` inside `onChange` (narrowing lost in the closure). This is the annotation on the failed macOS build.

## Notes

- Typecheck fixes may touch TS core and UI. Do **not** change money math, SQL, importer conservation, or test assertions. Integer cents stay integer cents.
- Preferred `replaceAll` fix: set `tsconfig.json` `"lib"` to include `ES2021` (or later). Do not rewrite `replaceAll` to `split/join` unless lib bump is rejected by existing tests.
- ImportPage: capture `match_count` (and kind) in a const while `kind === "potential_duplicate"` is narrowed; use that const in `onChange`. Do not add `as` casts that lie about other union members.
- BillsGridPage / `resolvePayeeDefaults`: `payee_id` is always `payee.id` (a `number`). Fix the return type or narrow before `createManualPayment`. `category_id` may stay `number | null`.
- payments `getPatchedField`: keep the same runtime behavior; fix the generic so `tsc` accepts indexing.
- payee-normalization: when `inheritsHeader` is true, `activeGroupHeader` is non-null at runtime. Make `payee` a `string` before `.toLowerCase()` / `Map` insert without changing grouping behavior.
- CI: split into two parallel jobs in the **same** `.github/workflows/ci.yml` (no second workflow file, no self-hosted runner, no sccache). **Delete** the old `quality-checks` job — do not keep it as a third path. `quality-js` and `quality-rust` have **no** `needs` on each other (typecheck does not gate cargo). `build-tauri` needs both.
- `quality-js` (ubuntu-latest): checkout, Node 20 + npm cache, `npm ci`, `npm run lint`, `npm run typecheck` (`tsc --noEmit`), `npm test`. No Rust, no apt GTK.
- `quality-rust` (ubuntu-latest): checkout, Rust + clippy, rust-cache (`src-tauri -> target`), the same five GTK packages as today (unconditional), then `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`. Job `env`: `CARGO_INCREMENTAL: "0"`, `CARGO_PROFILE_DEV_DEBUG: "0"`, `CARGO_PROFILE_TEST_DEBUG: "0"`.
- `build-tauri` still has the 3-OS matrix and still `needs` **both** quality jobs. Keep its Ubuntu GTK install.
- Do not add signing, artifacts, or a new package manager.

## Acceptance criteria

- `npx tsc --noEmit` exits 0 (no errors). The seven items above are gone.
- `package.json` has `"typecheck": "tsc --noEmit"`.
- `.github/workflows/ci.yml` has parallel `quality-js` and `quality-rust` jobs (no `needs` between them). `quality-js` runs lint, typecheck, and Vitest and does not install Rust or GTK. `quality-rust` installs the five GTK packages unconditionally before cargo, then runs the same cargo test and clippy commands as 01.5.
- `quality-rust` sets `CARGO_INCREMENTAL`, `CARGO_PROFILE_DEV_DEBUG`, and `CARGO_PROFILE_TEST_DEBUG` to `"0"`.
- `build-tauri` `needs` both quality jobs and still builds ubuntu-latest, windows-latest, macos-latest.
- `npm test` still passes. `cargo test --manifest-path src-tauri/Cargo.toml command_reads_fixture_year_sheet_and_surfaces_non_year_warning` still passes if the reader fixture is present.
- No float money math. No SQL in UI. No GnuCash. Tests stay on fixtures/temp dirs.
