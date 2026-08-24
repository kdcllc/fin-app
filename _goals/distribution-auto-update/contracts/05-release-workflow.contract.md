# Contract: 05-release-workflow

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

05-release-workflow

## done_definition

On tag builds (`v*` tags), `.github/workflows/ci.yml` signs updater artifacts via
`tauri-apps/tauri-action` using GitHub Actions secrets, enables `includeUpdaterJson: true`,
and publishes installers, `.sig` files, and a complete three-platform `latest.json` to the
public `kdcllc/fin-app-releases` repo authenticated with `RELEASES_REPO_TOKEN`. The
parallel-matrix `latest.json` race is resolved with an explicit, commented strategy, and a
release missing any platform's entry fails. Non-tag pushes and PRs behave as today: no signing
secrets required, no cross-repo release, `includeUpdaterJson` effectively off, artifacts
still upload. Missing signing secrets on a tag build fail loudly — never a silently unsigned
release. `docs/RELEASING.md` is the operator runbook: version bump → tag → push, one-time repo
and secrets setup (including the empty minisign password), private-key backup at
`~/.tauri/fin-app.key`, unsigned-installer OS warnings, updater minisign verification, and an
explicit note that end-to-end pipeline proof requires a real tag build after user setup.

## acceptance_criteria

### Workflow file validity (`.github/workflows/ci.yml`)

1. The workflow YAML parses without syntax errors. — verification: command output —
   `node -e "const fs=require('fs');const yaml=require('yaml');yaml.parse(fs.readFileSync('.github/workflows/ci.yml','utf8'));console.log('OK')"`
   exit code 0 (or equivalent YAML lint/parse one-liner documented in the completion report).
   evaluator-note (pin i): `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` or `npx` without saving a dependency is an accepted equivalent (`yaml` is not a repo package today). Do not add an npm `yaml` dependency — `package.json` is outside the write fence.

2. Existing jobs `quality-js`, `quality-rust`, and `build-tauri` remain present with the same
   job ids and the same `needs` / matrix platform list (`ubuntu-22.04`, `windows-latest`,
   `macos-latest`). — verification: file inspection — `grep -E '^  [a-z].*:$' -A0
   .github/workflows/ci.yml` lists the three jobs; `grep 'platform:' -A5
   .github/workflows/ci.yml` shows the three matrix entries unchanged.

3. Top-level `permissions` and per-job permission blocks are not weakened (no removal of
   `contents: write` where present today). — verification: file inspection — `grep -n
   'permissions:' .github/workflows/ci.yml` matches are `contents: write` or stricter; diff
   does not delete permission keys.

### Tag-gated signing on `tauri-apps/tauri-action` (tag builds only)

4. On tag builds, the `Build Tauri app` step passes `TAURI_SIGNING_PRIVATE_KEY` from
   `secrets.TAURI_SIGNING_PRIVATE_KEY`. — verification: condition inspection —
   `grep -A30 'uses: tauri-apps/tauri-action' .github/workflows/ci.yml` shows
   `TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}` (or equivalent
   `env:` mapping) inside a block gated by `github.ref_type == 'tag'` (direct `if:` on the
   step, conditional `${{ }}` expression, or a tag-only job — the secret reference MUST NOT
   be evaluated on non-tag events).
   evaluator-note (pin j): Satisfied by a tag-`if:` on the signing/publish step, a tag-only job, or a tag-conditional expression. Signing env on the always-on build step is acceptable only if missing/empty keys do not fail push/PR (same bar as criterion 13).

5. On tag builds, the step passes `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from
   `secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (may resolve to empty when the secret is
   unset — matching the empty-password keypair). — verification: condition inspection — same
   `grep` window as criterion 4 shows the password env var, tag-gated the same way.

6. On tag builds, `includeUpdaterJson` is `true`. — verification: condition inspection —
   `grep 'includeUpdaterJson' .github/workflows/ci.yml` shows a tag-conditional expression
   that evaluates to `true` when `github.ref_type == 'tag'` (e.g.
   `includeUpdaterJson: ${{ github.ref_type == 'tag' }}`).

7. On non-tag builds (push to `main`, pull_request), `includeUpdaterJson` is effectively
   `false` — same behavior as the pre-task workflow. — verification: condition inspection —
   the `includeUpdaterJson` expression evaluates to `false` when `github.ref_type != 'tag'`;
   no unconditional `includeUpdaterJson: true`.

8. No workflow step prints secret values (`echo`, `console.log`, or run scripts dumping
   `${{ secrets.* }}`). — verification: command output —
   `grep -nE 'echo.*secrets\.|print.*secrets\.' .github/workflows/ci.yml` returns no matches;
   manual review of `run:` blocks in the diff shows no secret interpolation to stdout.

### Cross-repo release publishing (tag builds only)

9. On tag builds, release publishing targets `owner: kdcllc`, `repo: fin-app-releases`. —
   verification: condition inspection — `grep -E 'owner:|repo:' .github/workflows/ci.yml`
   shows `kdcllc` and `fin-app-releases` on the `tauri-action` `with:` block (or equivalent
   documented inputs), active only when `github.ref_type == 'tag'`.

10. On tag builds, authentication to the releases repo uses `RELEASES_REPO_TOKEN` (PAT
    secret), not the default `GITHUB_TOKEN` alone for cross-repo publish. — verification:
    condition inspection — `grep 'RELEASES_REPO_TOKEN' .github/workflows/ci.yml` shows
    `${{ secrets.RELEASES_REPO_TOKEN }}` passed as the action token (e.g. `token:` input or
    `GITHUB_TOKEN:` env override), tag-gated; completion report quotes the exact input name
    from tauri-action v0 docs if ambiguous.
    evaluator-note (pin d): Stay on `tauri-apps/tauri-action@v0` (v0 `action.yml` has `includeUpdaterJson` and `owner`/`repo`; it has no `token:` input). Pass the PAT by overriding `env.GITHUB_TOKEN` (as today) unless the cited v0 README shows another hook. Completion report must quote the v0 docs/action.yml for that choice. Do not bump to `@v1` / `uploadUpdaterJson`.

11. `latest.json`, platform bundles, and `.sig` files land on the same GitHub Release in
    `fin-app-releases` that the app endpoint reads
    (`…/fin-app-releases/releases/latest/download/latest.json` per
    `src-tauri/tauri.conf.json`). — verification: docs review of workflow comments +
    `tauri-action` `with:` flags (`includeUpdaterJson: true`, release enabled on tag) +
    `jq -r '.plugins.updater.endpoints[0]' src-tauri/tauri.conf.json` matches the documented
    publish target host/repo.

12. On non-tag builds, no release is created or updated in `fin-app-releases` (or any repo). —
    verification: condition inspection — `tagName` / `releaseName` remain empty off-tag (as
    today: `${{ github.ref_type == 'tag' && github.ref_name || '' }}` or equivalent); no
    separate release-upload job runs without a tag `if:` guard.

13. On non-tag builds, `RELEASES_REPO_TOKEN` is never required — the workflow must not fail
    on PR/push for a missing PAT. — verification: condition inspection — every reference to
    `secrets.RELEASES_REPO_TOKEN` sits inside a tag-gated step/job; `grep
    'RELEASES_REPO_TOKEN' .github/workflows/ci.yml` cross-checked against adjacent `if:` /
    conditional expressions.

### Artifact upload unchanged for all events

14. The `Upload OS installers` step still runs on all matrix platforms for push, PR, and tag
    events (subject only to `!cancelled()` as today). — verification: condition inspection —
    `grep -A8 'Upload OS installers' .github/workflows/ci.yml` shows `if: ${{ !cancelled() }}`
    (or equivalent) without a tag-only guard; artifact `path:` globs unchanged for deb/AppImage/rpm/msi/nsis/dmg.

15. Non-tag CI behavior is provably preserved: same triggers (`push` branches/tags, `pull_request`),
    same quality gates, same artifact names (`fin-app-${{ matrix.platform }}`). — verification:
    condition inspection — `grep -E '^on:|branches:|tags:|pull_request:' .github/workflows/ci.yml`
    matches pre-task structure; diff hunks outside the `build-tauri` tauri-action block are
    absent or comment-only.
    evaluator-note (pin h): The "hunks outside tauri-action are comment-only" clause excludes (a) comments naming the race strategy, (b) tag-only `concurrency` / `max-parallel` / fan-in job implementing criteria 16–17, and (c) tag-gated `if:` on signing/publish. Non-tag triggers, quality jobs, artifact names/globs, and `includeUpdaterJson` effectively false off-tag remain required.

### Three-OS `latest.json` race handling

16. The workflow contains an explicit comment block naming the chosen strategy for the
    parallel-matrix `latest.json` race (either serialized release upload — e.g. job-level
    `concurrency:` group or `max-parallel: 1` on the release-bearing matrix — **or** a
    fan-in job that merges/regenerates `latest.json` after all three platforms finish). —
    verification: docs review — `grep -B2 -A6 -iE 'latest\.json|race|concurrency|fan-in|merge'
    .github/workflows/ci.yml` finds a human-readable comment stating which strategy was
    chosen and why.
    evaluator-note (pin a): Either serialized release upload or a fan-in merge/regenerate job is approved. The chosen strategy MUST be named in the workflow comment. A `latest.json` missing any of Linux/Windows/macOS is a failed release (criterion 17).

17. A `latest.json` missing any of the three platforms (Linux, Windows, macOS) causes a
    failed release — not a partial publish accepted as success. — verification: condition
    inspection + docs review — workflow implements at least one of: (a) fan-in validation
    step that checks all three platform entries before upload, (b) serialized uploads where
    the final writer validates completeness, or (c) a post-matrix job that fails if any
    platform artifact/`latest.json` fragment is missing; comment in criterion 16 references
    the failure mode.

### Missing secrets fail loudly on tag builds

18. If `TAURI_SIGNING_PRIVATE_KEY` is absent on a tag build, the pipeline fails at or before
    signing with a clear error — not a published unsigned release. — verification: docs
    review of workflow (optional explicit preflight step with `if: failure()` message) plus
    reliance on tauri-action/minisign failure when the env var is empty; completion report
    cites expected failure surface; no `continue-on-error: true` on the signing/build step.
    evaluator-note (pin e): Loud failure may be native tauri-action/minisign failure when the key env is empty, or an explicit tag-only preflight that fails with a clear message. No `continue-on-error` masking. An `if: failure()` notice after a failed step is extra, not a substitute for actually failing.

19. Workflow comments or `docs/RELEASING.md` state that tag releases require all three
    secrets configured before pushing a tag. — verification: docs review — `grep -iE
    'TAURI_SIGNING|RELEASES_REPO_TOKEN|required.*secret' docs/RELEASING.md` matches.

### `docs/RELEASING.md` runbook (new file)

20. `docs/RELEASING.md` exists and documents the one-command release flow: bump version in
    `src-tauri/tauri.conf.json` **and** `package.json` (same semver), create annotated tag
    `vX.Y.Z`, push the tag to trigger CI. — verification: docs review — file contains
    sections or steps referencing both JSON files, tag format `v*`, and `git push` of the tag.

21. Documents all three GitHub Actions secrets with scope guidance:
    `TAURI_SIGNING_PRIVATE_KEY` (minisign private key contents),
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `RELEASES_REPO_TOKEN` (PAT with `repo` scope
    on `kdcllc/fin-app-releases`). — verification: docs review — `grep -E
    'TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY_PASSWORD|RELEASES_REPO_TOKEN'
    docs/RELEASING.md` — each secret named with purpose and minimum PAT scopes.

22. Documents the **empty password** convention: the keypair was generated with an empty
    password; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` should remain **unset or empty** in GitHub
    Secrets (do not invent a password). — verification: docs review — `grep -iE 'empty
    password|unset|blank.*password|no password' docs/RELEASING.md` matches explicit guidance.
    evaluator-note (pin c): Unset-or-empty password documentation is approved as written — do not invent a password.

23. Documents private-key location and backup: local key at `~/.tauri/fin-app.key`; operator
    must back it up — losing the key strands existing installs (manual reinstall only). —
    verification: docs review — `grep '\.tauri/fin-app\.key' docs/RELEASING.md` and prose
    warning about key loss.
    evaluator-note (pin b): Document the actual key file `~/.tauri/fin-app.key` (tilde form `~/.tauri/fin-app.key` is the same path). `TAURI_SIGNING_PRIVATE_KEY` is that file's contents. Losing the key strands existing installs (manual reinstall only). Regenerating requires updating `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` and re-releasing.

24. One-time setup checklist: create the public `kdcllc/fin-app-releases` GitHub repo, store
    the three secrets in the private `fin-app` repo, confirm the updater endpoint in
    `tauri.conf.json` points at that repo. — verification: docs review — checklist section
    with `fin-app-releases` repo creation and secrets steps.

25. Documents why OS installers are unsigned (no Windows cert / Apple Developer ID) and the
    exact user-facing warnings: Windows SmartScreen ("Windows protected your PC" / unknown
    publisher) and macOS Gatekeeper ("cannot be opened because the developer cannot be
    verified"), each with the **right-click → Open** (or equivalent) workaround. —
    verification: docs review — `grep -iE 'SmartScreen|Gatekeeper|right.?click|Open'
    docs/RELEASING.md` matches both OS warnings.

26. Explains how the in-app updater verifies integrity: minisign signature on update
    artifacts checked against the pinned `pubkey` in `tauri.conf.json`; tampered or unsigned
    updates are rejected (OS signing is separate from updater signing). — verification: docs
    review — section referencing minisign, `.sig` files, and `plugins.updater.pubkey`.

27. Documents the post-merge verification limitation: full pipeline proof (signed artifacts +
    `latest.json` on `fin-app-releases`) requires a real tag build **after** the operator
    creates the public repo and secrets — contract-time CI cannot fully emulate that. —
    verification: docs review — `grep -iE 'tag build|after.*setup|post-merge|first release'
    docs/RELEASING.md` includes explicit limitation language.
    evaluator-note (pin g): Contract-time verification is YAML parse plus inspection of tag-gated conditions. A real tag build after the operator creates `kdcllc/fin-app-releases` and secrets is a documented limitation, not required for task PASS.

### README scope (conditional touch)

28. `README.md` is untouched unless a statement there becomes false due to this task; if
    edited, only incorrect release/distribution claims are corrected (Phase 6 owns broad doc
    alignment). — verification: `git diff README.md` empty OR diff only fixes a now-wrong
    release/install claim cited in the completion report.
    evaluator-note (pin f): README stays untouched unless a statement becomes false; if edited, the completion report cites the now-wrong claim. That single-file exception is the only override of criterion 29.

### Scope fence

29. Only the task ownership write set is modified: `.github/workflows/ci.yml`,
    `docs/RELEASING.md`. — verification: `git diff --name-only` lists only those paths
    (plus this contract file from contract mode).

30. No application code, `src-tauri/tauri.conf.json`, UI, Rust sources, or test files are
    changed. — verification: `git diff --name-only` excludes `src/`, `src-tauri/src/`,
    `src-tauri/tauri.conf.json`, `package.json`, and `tests/`.

## verification_environment

CLI (YAML validation via Node/`yaml` parse or equivalent lint) + docs inspection (`docs/RELEASING.md`, workflow comments). Full end-to-end release verification is operator-run after secrets/repo setup (documented in criterion 27); not required for contract-time evaluator PASS.

## out_of_scope

- Application code, UI, Rust modules, and tests.
- `src-tauri/tauri.conf.json` changes (owned by task `03-updater-config`; endpoint/pubkey already pinned).
- Creating the public `kdcllc/fin-app-releases` repo or GitHub Actions secrets (user one-time setup; documented in `docs/RELEASING.md`).
- OS code signing / notarization (documented trade-off only).
- Broad README or `docs/RESEARCH.md` alignment (Phase 6 / align-docs unless README claim is actively wrong).
- Delta/partial updates, downgrade flows, release channels.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T14:20:00-04:00
    note: Achievable within the two-file fence (.github/workflows/ci.yml targeted-insertion, docs/RELEASING.md); race strategy left to implementer choice per task.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T15:00:00-04:00
    note: Counter-signed with pins — race serialize-or-fan-in + 3-OS completeness fail; key ~/.tauri/fin-app.key empty password + pubkey regen on rekey; v0 GITHUB_TOKEN citation; loud fail no continue-on-error; README only if wrong; YAML-inspect not live tag; C15 allows race hunks.
revision: 0
```
