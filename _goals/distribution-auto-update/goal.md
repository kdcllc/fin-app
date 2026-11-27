# Goal: distribution-auto-update

## Problem Statement

fin-app's CI already builds installers for all three OSes on tags, but nothing protects
the user's data or keeps installs current: there are no book-file backups (an update or
migration failure could destroy years of financial data), no update mechanism (users
must manually download installers), and no signature on update artifacts. This goal
delivers the release milestone (archived Goal 07): rotating book backups with one-click
restore, a minisign-signed auto-updater fed from a public releases repo, and the
release workflow to publish it all — without OS code signing (personal app; the updater
signature covers integrity).

## Discovery Summary (Phase 1 Q&A)

- **Execution plan**: runs in parallel with `gnucash-read-export`; that goal wins on
  contention. Shared hotspot files are serialized by the orchestrator.
- **Signing**: no Windows cert / Apple Developer ID. OS code signing skipped and the
  resulting installer warnings documented; update integrity comes from the Tauri
  updater's minisign signature. Keypair generated during the work; the private key is
  handed to the user for a GitHub Actions secret and never committed.
- **Update check**: on app launch, plus a manual "Check for updates" button in
  Settings. Never restart while an import/commit is running.
- **Release serving**: this repo is private, so CI publishes `latest.json` + installers
  to a separate PUBLIC releases repo (`kdcllc/fin-app-releases`) via a PAT secret. The
  user creates that repo and the two secrets (updater private key, PAT) — code and
  workflow are built and testable regardless.
- **Backups**: rotating timestamped backups of the fin-app SQLite book before every
  schema migration and on a schedule, one-click restore in Settings, retention
  configurable (default 20).

## Success Criteria

- [ ] Opening a book with pending migrations first writes a verified timestamped backup
      to `backups/` next to the book; a fully-migrated book triggers no backup.
- [ ] Scheduled backups fire per the configured cadence when the app runs, and rotation
      prunes to the retention limit (default 20, configurable in Settings).
- [ ] Restore from Settings: pick a listed backup → current book is backed up first →
      book replaced → app reopens on the restored data; a corrupt/missing backup file
      fails the restore with a clear error and leaves the current book untouched.
- [ ] Settings shows backup location, retention, last-backup time, backup-now, and the
      restore flow.
- [ ] The app checks for updates on launch and via a Settings button: shows current vs
      available version + release notes, downloads with progress, verifies the
      minisign signature, and prompts before restart; an in-flight import blocks the
      restart prompt until finished. "Up to date" and network-failure states are
      handled quietly (no blocking errors on launch).
- [ ] A tampered or unsigned artifact is rejected by the updater (signature
      verification proven at the Tauri config level: pubkey pinned in
      `tauri.conf.json`).
- [ ] The release workflow signs update artifacts and publishes installers +
      `latest.json` to the public releases repo on tag builds; the docs cover the
      release runbook, required secrets, key backup, and the unsigned-installer
      warnings users will see.

## Constraints

- The backup/restore engine lives in Rust (file operations on the book next to the
  open connection); UI accesses it via invoke wrappers — no SQL involved, core's SQL
  boundary is unaffected.
- Backups are plain timestamped copies in a user-visible `backups/` folder next to the
  book (local-only philosophy; user owns the files).
- Restore must handle the one-book-per-session rule in `src-tauri/src/db.rs` (close →
  replace → reopen, atomically as possible; never leave the session pointing at a
  half-replaced file).
- Cross-goal hotspots serialized by the orchestrator (never edited concurrently with
  the gnucash goal's tasks): `src-tauri/src/lib.rs`, `src-tauri/src/db.rs`,
  `src/App.tsx`.
- Updater private key: never committed, never logged; only the public key lands in
  `tauri.conf.json`.
- Tests use temp dirs and fixture books only; updater tests mock the plugin surface —
  no network.

## Out of Scope

- OS code signing / notarization (documented trade-off instead). `docs/RESEARCH.md`'s
  "signed installers" recommendation becomes partially inaccurate; Phase 6
  (align-docs) records the decided deviation there.
- Publishing the actual public releases repo and secrets (user action items; workflow
  must degrade gracefully — non-tag builds unaffected).
- Backing up the GnuCash book (that belongs to the deferred gnucash-write goal's
  write-session guardrails).
- Delta/partial updates, downgrade flows, release channels.

## Tasks (dependency order)

| # | Task file | Layer | Depends on |
|---|-----------|-------|------------|
| 01 | `01-backup-rust.md` | Rust commands | — |
| 02 | `02-backup-settings-ui.md` | TS + React UI | 01 |
| 03 | `03-updater-config.md` | Rust/config | 01 |
| 04 | `04-updater-ui.md` | TS + React UI | 02, 03 |
| 05 | `05-release-workflow.md` | CI/docs | 03 |
| 06 | `06-tests.md` | tests | all |

Task 03 depends on 01 only to serialize `src-tauri/src/lib.rs` edits; there is no
logical coupling. Task 04 depends on 02 to serialize `src/pages/SettingsPage.tsx` and
`src/App.tsx`.
