# Contract: 03-updater-config

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

03-updater-config

## done_definition

`tauri-plugin-updater` and `tauri-plugin-process` are installed via package managers with
lockfile-resolved versions, registered in `lib.rs` on desktop targets only, and configured in
`tauri.conf.json` with `bundle.createUpdaterArtifacts: true`, the public releases endpoint
(`https://github.com/kdcllc/fin-app-releases/releases/latest/download/latest.json`), and a
freshly generated minisign public key inline. Capability permissions use the installed
plugins' real v2 permission identifiers for updater check/download/install and process
restart (JS `relaunch()`). A new signing keypair is generated with the Tauri v2 signer CLI;
only the public key is committed — the private key and password live in a local out-of-repo
(or otherwise untracked) file whose path is named in the completion report (never echoed).
`cargo check`, `npm run typecheck`, and `npm run build` pass; no UI code imports or invokes
the updater yet.

## acceptance_criteria

### Rust dependencies (`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`)

1. `tauri-plugin-updater` is added to `[dependencies]` using the package manager (`cargo add
   tauri-plugin-updater --manifest-path src-tauri/Cargo.toml`), not hand-edited version
   strings. — verification: `git diff src-tauri/Cargo.toml` shows the new dependency line;
   the version requirement matches the `cargo add` output (typically `"2"` aligned with
   existing `tauri-plugin-*` entries).

2. `tauri-plugin-process` is added the same way (`cargo add tauri-plugin-process
   --manifest-path src-tauri/Cargo.toml`). — verification: `git diff src-tauri/Cargo.toml`
   shows the new dependency line.

3. `src-tauri/Cargo.lock` contains resolved entries for both crates with concrete version
   numbers (never invented in the contract or report — read from the lockfile after the
   adds). — verification: `grep -E '^name = "(tauri-plugin-updater|tauri-plugin-process)"'
   -A1 src-tauri/Cargo.lock` prints each `name` followed by a `version = "…"` line; record
   those exact version strings in the completion report.

4. No other `[dependencies]` entries in `Cargo.toml` are added, removed, or reordered beyond
   the two plugin lines (targeted insertion). — verification: `git diff
   src-tauri/Cargo.toml` diff hunks touch only the new dependency lines (plus lockfile
   fallout).

### JavaScript dependencies (`package.json`, `package-lock.json`)

5. `@tauri-apps/plugin-updater` is added via npm (`npm install @tauri-apps/plugin-updater`),
   producing a real resolved version in `package-lock.json`. — verification: `package.json`
   lists the dependency under `"dependencies"`; `npm ls @tauri-apps/plugin-updater --depth=0`
   exit code 0; `grep '"@tauri-apps/plugin-updater"' -A3 package-lock.json` shows a
   `"resolved"` URL and `"version"` string — cite that version in the completion report.

6. `@tauri-apps/plugin-process` is added the same way (`npm install
   @tauri-apps/plugin-process`). — verification: same checks as criterion 5 for
   `@tauri-apps/plugin-process`.

7. No JS/TS source files import or call the new plugins (plumbing only; UI is task 04). —
   verification: `git grep -E '@tauri-apps/plugin-(updater|process)' -- ':!package.json'
   ':!package-lock.json'` returns no matches.
    evaluator-note (pin a): Criterion 7 applies to application source only (`src/**/*.{ts,tsx,js,jsx}` and any JS under `src-tauri/`). Mentions in `_goals/`, `goals/`, and `docs/` are not imports; interpret the listed git-grep with those trees excluded.

### Plugin registration (`src-tauri/src/lib.rs`)

8. `tauri_plugin_updater::Builder::new().build()` is registered on the Tauri builder. —
   verification: file inspection — `grep 'tauri_plugin_updater' src-tauri/src/lib.rs`
   shows the `Builder::new().build()` chain passed to `.plugin(...)`.

9. `tauri_plugin_process::init()` is registered on the Tauri builder. — verification: file
   inspection — `grep 'tauri_plugin_process::init' src-tauri/src/lib.rs` matches.

10. Both updater and process plugin registrations are gated to desktop targets only (e.g.
    `#[cfg(desktop)]` on the `.plugin(...)` lines or an equivalent desktop-only block). —
    verification: file inspection of the inserted lines; no unconditional registration on
    mobile entry points.
    evaluator-note (pin b): Gating style is implementer-chosen (`#[cfg(desktop)]`, a desktop-only block, or `not(any(target_os = "android", target_os = "ios"))`). Whatever is used MUST keep both `.plugin(...)` registrations compiled in on this Linux machine's `cargo check` — a cfg that evaluates false and silently strips them is not done.

11. Existing modules, plugins, `manage(...)`, and `invoke_handler![...]` entries are
    unchanged except for the two new `.plugin(...)` insertions (backup commands from task 01
    remain registered). — verification: `git diff src-tauri/src/lib.rs` diff hunks add only
    the plugin lines (and any required `#[cfg(desktop)]` / import lines); `grep
    'db::backup_now\|db::list_backups\|db::restore_backup' src-tauri/src/lib.rs` still
    matches.

### Updater config (`src-tauri/tauri.conf.json`)

12. `bundle.createUpdaterArtifacts` is `true` (boolean, not `"v1Compatible"`). —
    verification: file inspection — `jq '.bundle.createUpdaterArtifacts'
    src-tauri/tauri.conf.json` outputs `true`.

13. `plugins.updater.endpoints` is a one-element array with exactly
    `"https://github.com/kdcllc/fin-app-releases/releases/latest/download/latest.json"`. —
    verification: `jq '.plugins.updater.endpoints'
    src-tauri/tauri.conf.json` outputs that URL as the sole element.

14. `plugins.updater.pubkey` is a non-empty inline string (the minisign public key content,
    not a filesystem path). — verification: `jq -r '.plugins.updater.pubkey |
    length' src-tauri/tauri.conf.json` outputs an integer `> 0`; `jq '.plugins.updater.pubkey'
    src-tauri/tauri.conf.json` value does not start with `/`, `./`, `../`, or `~`.
    evaluator-note (pin c): pubkey is the inline minisign public-key content as emitted by `tauri signer generate` (not a path). Exact generated wrapping/base64 layout is fine.

15. `plugins` remains valid minimal JSON (updater entry only — no unrelated plugin keys). —
    verification: `jq empty src-tauri/tauri.conf.json` exit code 0; `jq '.plugins | keys'
    src-tauri/tauri.conf.json` outputs `["updater"]` (or `["updater"]` plus any pre-existing
    keys if present before this task — currently none).

16. No OS code-signing or notarization settings are added (`bundle.macOS.signingIdentity`,
    `bundle.windows.certificateThumbprint`, etc.). — verification: `git diff
    src-tauri/tauri.conf.json` and `jq 'paths | select(.[-1] | test("sign|notari|cert";"i"))'
    src-tauri/tauri.conf.json` produce no new signing-related keys.

### Signing keypair generation and secret handling

17. A fresh updater signing keypair is generated with the Tauri v2 CLI into a temporary or
    out-of-repo path, e.g. `npm run tauri signer generate -- -w
    "$HOME/.tauri/fin-app-updater.key"` (path may differ; MUST NOT be inside the tracked
    repo tree unless covered by an existing `.gitignore` rule). — verification: completion
    report states the `-w` path used; file exists at that path after generation; the
    corresponding public key material matches `plugins.updater.pubkey` in
    `tauri.conf.json`.
    evaluator-note (pin d): The private-key `-w` path MUST be out-of-repo (e.g. `$HOME/.tauri/fin-app-updater.key`). Out-of-repo is inherently untracked and satisfies the task's "git-ignored local file" wording. Do NOT edit `.gitignore` (outside the write fence). Completion report names the path only; never echo key material or password.

18. The private key file and its password are written only to the local path from criterion
    17 (or the CLI's documented companion files alongside it). They are NEVER committed,
    NEVER printed in logs, and NEVER included in the completion report body beyond naming the
    path. — verification: `git status --porcelain` and `git ls-files` do not list the
    private key path; completion report contains no PEM body, no `d=` minisign secret lines,
    and no password value.

19. The completion report names the private-key file path and instructs the user to store the
    key (and password, if set) as the `TAURI_SIGNING_PRIVATE_KEY` and
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secrets and to back up the key (losing
    it strands existing installs on manual reinstall). — verification: completion report
    inspection (evaluator checklist item).

20. No private-key material is tracked in git. — verification: command output — all of the
    following exit with no matches (or only this contract/task docs if quoted hypothetically):
    `git grep -iE 'TAURI_SIGNING_PRIVATE_KEY|BEGIN.*PRIVATE|minisign secret|\.key"' -- .`
    excluding `_goals/`; `git grep -F "$(jq -r '.plugins.updater.pubkey'
    src-tauri/tauri.conf.json)" -- .` matches only `src-tauri/tauri.conf.json` (pubkey is
    allowed); `git ls-files | grep -iE '\.(key|pem)$'` is empty or lists no updater private
    key.

### Capability permissions (`src-tauri/capabilities/default.json`)

21. After dependencies are installed, the worker verifies permission identifiers against the
    **installed** plugin versions' docs (Tauri v2 updater/process plugin permission tables —
    e.g. https://v2.tauri.app/plugin/updater/ and https://v2.tauri.app/plugin/process/, or
    generated schemas under `src-tauri/gen/schemas/` after `cargo check`). — verification:
    completion report cites the doc URL or schema file path and the plugin versions from
    criteria 3, 5, and 6.
    evaluator-note (pin e): Either official plugin docs (https://v2.tauri.app/plugin/updater/ and https://v2.tauri.app/plugin/process/) or generated schemas under `src-tauri/gen/schemas/` after `cargo check` is an acceptable verification source. Cite the source plus lockfile/npm versions in the completion report.

22. Updater permissions granted include at minimum the v2 identifiers required for the full
    check → download → install workflow task 04 will use. Acceptable sets (verify exact
    spelling against criterion 21):
    - `updater:default` alone (bundles `allow-check`, `allow-download`, `allow-install`,
      `allow-download-and-install`), **or**
    - `updater:default` plus explicit `updater:allow-check` and
      `updater:allow-download-and-install`, **or**
    - the explicit trio without `updater:default`: `updater:allow-check`,
      `updater:allow-download-and-install` (and `updater:allow-download` /
      `updater:allow-install` if required by the installed schema).
    — verification: `jq '.permissions' src-tauri/capabilities/default.json` includes the
    chosen identifiers verbatim; cross-check each string appears in the installed plugin
    permission table or generated schema.
    evaluator-note (pin e): Any listed updater set is accepted if it covers check → download-and-install for task 04 (`check()` then `downloadAndInstall()`). Do not invent identifiers; spelling must match the source in criterion 21.

23. Process permissions grant restart capability for JS `relaunch()` from
    `@tauri-apps/plugin-process`. Acceptable sets (verify against criterion 21):
    - `process:default` (bundles `allow-exit` and `allow-restart`), **or**
    - `process:allow-restart` explicitly.
    — verification: `jq '.permissions' src-tauri/capabilities/default.json` includes
    `process:default` and/or `process:allow-restart`; confirm `process:allow-restart` exists
    in the installed plugin docs (JS `relaunch` maps to the `restart` command/permission).
    evaluator-note (pin e): Any listed process set is accepted if it grants JS `relaunch()` (`process:allow-restart` or `process:default`). Extra bundled perms such as `allow-exit` inside `process:default` are fine.

24. Existing permissions (`core:default`, `opener:default`, `dialog:default`,
    `store:default`) are preserved. — verification: `jq '.permissions'
    src-tauri/capabilities/default.json` still contains all four identifiers.

25. No permission identifiers are invented or mistyped (e.g. no `updater:allow-download-and-install`
    with wrong hyphenation, no v1-style bare `allow-check`). — verification: every new
    permission string in the diff matches an entry in the installed plugin permission table
    or `src-tauri/gen/schemas/` ACL definitions.

### Build and typecheck (no UI usage yet)

26. `cargo check --manifest-path src-tauri/Cargo.toml` completes with exit code 0. —
    verification: command output.

27. `npm run typecheck` completes with exit code 0. — verification: command output.

28. `npm run build` completes with exit code 0. — verification: command output.

29. Combined targeted check from the task file also passes: `cargo check --manifest-path
    src-tauri/Cargo.toml && npm run build`. — verification: command output exit code 0.

### Scope fence

30. Only the task ownership write set is modified:
    `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/lib.rs`,
    `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `package.json`,
    `package-lock.json`. — verification: `git diff --name-only` against the task base lists
    only those paths (plus this contract file from contract mode).

31. No UI files, `db.rs`, backup module logic, CI workflow files, or docs are touched. —
    verification: `git diff --name-only` excludes `src/`, `.github/`, `docs/`, and
    `src-tauri/src/db.rs`.

## verification_environment

CLI (cargo/npm) + file inspection

## out_of_scope

- Any TypeScript/React UI that calls `@tauri-apps/plugin-updater` or
  `@tauri-apps/plugin-process` (task `04-updater-ui` — launch check, Settings button,
  download progress, restart prompt).
- CI/release workflow, `latest.json` publishing, and GitHub Actions secrets wiring (task
  `05-release-workflow`).
- OS code signing, notarization, or Windows/macOS installer certificate configuration.
- Adding or editing `.gitignore` (not in the write fence; private key MUST use an out-of-repo
  path or another already-untracked location).
- Delta/partial updates, downgrade flows, and release channels.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T11:55:00-04:00
    note: Achievable within the seven-file fence; private key stays out-of-repo (e.g. ~/.tauri/) since .gitignore is not writable.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T12:20:00-04:00
    note: Counter-signed with pins — private key out-of-repo (~/.tauri/), no .gitignore edit; any docs/schema-verified check→download-install→restart permission set; pubkey inline as generated; desktop gating implementer-chosen but live on Linux cargo check.
revision: 0
```
