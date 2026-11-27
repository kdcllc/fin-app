# Task 05: release-workflow

## Objective

The delivery pipeline: tag builds sign updater artifacts with the minisign key and
publish installers + `latest.json` to the public `kdcllc/fin-app-releases` repo, plus a
release runbook documenting the process, the required secrets, key-backup discipline,
and the unsigned-installer warnings users will see.

## Dependencies

- 03-updater-config (`createUpdaterArtifacts`, pubkey, endpoint exist)

```yaml
# --- task ownership contract ---
writes:
  - .github/workflows/ci.yml     # tauri-action signing env + updater json + cross-repo publish
  - docs/RELEASING.md
reads:
  - .github/workflows/ci.yml
  - src-tauri/tauri.conf.json
depends_on:
  - "03-updater-config"
owner: implementer
rewrite_semantics: targeted-insertion   # ci.yml edits are surgical
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] The existing `tauri-apps/tauri-action` step gains, on tag builds only:
      `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from
      secrets, `includeUpdaterJson: true`, and release publishing retargeted to the
      public repo — `owner: kdcllc`, `repo: fin-app-releases`, authenticated with a
      `RELEASES_REPO_TOKEN` PAT secret. Non-tag builds are provably byte-equivalent in
      behavior to today: `includeUpdaterJson` stays effectively false off-tag, no
      release step runs, `RELEASES_REPO_TOKEN` is never required on the PR/push path,
      artifacts still upload.
- [ ] `latest.json` ends up attached to the public release alongside all platform
      bundles + `.sig` files (that is: updater artifacts flow to the same release the
      configured endpoint reads from).
- [ ] The known 3-OS-matrix `latest.json` race in `tauri-action` (parallel platform
      jobs each rewriting the release's `latest.json`) is explicitly handled — pick
      one and document it in the workflow comments: serialize the matrix's release
      upload (e.g. `concurrency` group or `max-parallel: 1` on the upload step), or a
      final fan-in job that merges/regenerates `latest.json` after all platforms
      finish. A `latest.json` missing any of the three platforms is a failed release.
- [ ] Non-tag pushes/PRs are provably unaffected: same jobs, same conditions, no new
      required secrets on that path (workflow syntax-checked; conditions on
      `github.ref_type == 'tag'`).
- [ ] Missing secrets on a tag build fail loudly at the signing step with a clear
      message — never a silently unsigned release.
- [ ] `docs/RELEASING.md` covers: one-command release flow (bump `tauri.conf.json` +
      `package.json` versions → tag `vX.Y.Z` → push tag), required GitHub secrets
      (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
      `RELEASES_REPO_TOKEN` with scope guidance), the user's one-time setup checklist
      (create public `fin-app-releases` repo, store secrets, back up the private key —
      losing it strands users), why installers are unsigned and the exact
      SmartScreen/Gatekeeper warnings with the right-click-open workaround, and how the
      updater verifies the minisign signature.
- [ ] README's commands/notes stay accurate (only if a claim there becomes wrong —
      otherwise untouched; Phase 6 owns broad doc alignment).

## Files to Read

- `.github/workflows/ci.yml` — full current workflow (conditions, matrix, artifact
  paths)
- `goals/07-distribution/tasks/01-bundler-signing.md`, `02-auto-updater.md` — archived
  intent incl. signing trade-off documentation requirement
- `_goals/distribution-auto-update/goal.md` — discovery decisions

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: keep every existing CI job/condition working; YAML valid (`actionlint`-clean
  if available locally, otherwise careful review).
- Must NOT: print secret values in any step, weaken existing permission blocks, or
  touch application code.

## Verification

- Targeted test command: `npx yaml-lint .github/workflows/ci.yml` equivalent or a YAML
  parse via node one-liner; evidence of the tag-gated conditions quoted in the report.
- Note in report: full pipeline verification requires a real tag build after the user
  creates the repo + secrets (documented as a post-merge step in RELEASING.md).
