# Task 03: updater-config

## Objective

The updater plumbing: `tauri-plugin-updater` + `tauri-plugin-process` installed and
registered on both sides of the IPC boundary, updater config in `tauri.conf.json`
pointing at the public releases repo with the minisign public key pinned, capability
permissions granted, and the keypair generated (public key committed; private key
delivered to the user out-of-band).

## Dependencies

- 01-backup-rust (serializes the shared `src-tauri/src/lib.rs` file only — no logical
  coupling)

```yaml
# --- task ownership contract ---
writes:
  - src-tauri/Cargo.toml               # add tauri-plugin-updater, tauri-plugin-process
  - src-tauri/Cargo.lock               # lockfile fallout of the cargo adds
  - src-tauri/src/lib.rs               # plugin init lines only
  - src-tauri/tauri.conf.json          # updater plugin config + createUpdaterArtifacts
  - src-tauri/capabilities/default.json  # updater + process permissions
  - package.json                       # add @tauri-apps/plugin-updater, @tauri-apps/plugin-process
  - package-lock.json
reads:
  - src-tauri/src/lib.rs
depends_on:
  - "01-backup-rust"
owner: implementer
rewrite_semantics: targeted-insertion
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] Rust deps added at current stable v2 versions via cargo; JS deps added via npm
      (real resolved versions in the lockfile — never hand-invented).
- [ ] `lib.rs`: `tauri_plugin_updater::Builder::new().build()` and
      `tauri_plugin_process::init()` registered (desktop targets), nothing else
      changed.
- [ ] `tauri.conf.json`: `bundle.createUpdaterArtifacts: true`; updater plugin config
      with `endpoints:
      ["https://github.com/kdcllc/fin-app-releases/releases/latest/download/latest.json"]`
      and the freshly generated minisign `pubkey` inline.
- [ ] Keypair generated with the Tauri v2 signer flow (`npm run tauri signer generate`
      into a temp path). Public key: committed in `tauri.conf.json`. Private key +
      password: NEVER committed, NEVER echoed into the completion report or logs —
      written to a git-ignored local file whose path the report names, with the
      instruction that the user stores it as the `TAURI_SIGNING_PRIVATE_KEY` (and
      password) GitHub secret and backs it up (losing it strands users on manual
      reinstalls).
- [ ] `capabilities/default.json` grants the updater and process permissions using
      the plugins' REAL v2 permission identifiers (e.g. `updater:default` /
      `updater:allow-check` / `updater:allow-download-and-install`, and
      `process:default` / `process:allow-restart` — note the JS `relaunch()` maps to
      the `restart` permission; verify the exact names against the installed plugin
      versions' permission docs, never invent them).
- [ ] `npm run typecheck`, `npm run build`, and
      `cargo check --manifest-path src-tauri/Cargo.toml` all pass with the new config
      (no UI usage yet — that's task 04).

## Files to Read

- `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` — current shapes
- `goals/07-distribution/tasks/02-auto-updater.md` — archived intent
- `_goals/distribution-auto-update/goal.md` — discovery decisions (public releases
  repo name, no OS signing)

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: use package managers for all dependency additions; keep `plugins: {}` JSON
  valid and minimal.
- Must NOT: commit or print the private key/password; enable OS code signing; touch
  UI files, `db.rs`, or the CI workflow (task 05 owns it).

## Verification

- Targeted test command: `cargo check --manifest-path src-tauri/Cargo.toml && npm run build`
- Evidence: `git grep` proof that no private-key material is tracked; the pubkey
  visible in `tauri.conf.json`.
