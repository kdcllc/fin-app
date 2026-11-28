# Releasing fin-app

This runbook covers publishing a signed release of fin-app. Releases are published
to this repo, [`kdcllc/fin-app`](https://github.com/kdcllc/fin-app/releases) (public):
release runs (a version bump merged to `main`, or a `v*` tag push — see [Release flow](#release-flow))
sign updater artifacts and attach installers, `.sig` files, and `latest.json` to the
GitHub Release for the `v<version>` tag.

## One-time setup checklist

Complete these steps **once** before your first tag release:

1. **Allow the workflow to write releases** — repo Settings → Actions → General →
   Workflow permissions → **Read and write permissions**. CI publishes with the
   workflow's own `GITHUB_TOKEN` (the workflow requests `contents: write`); no
   personal access token is needed.
2. **Confirm the updater endpoint** — `src-tauri/tauri.conf.json` must point at
   `https://github.com/kdcllc/fin-app/releases/latest/download/latest.json`.
3. **Store the signing secret** in the `fin-app` repo
   (Settings → Secrets and variables → Actions). It is **required before merging
   a version bump to `main` or pushing any `v*` tag**; a missing secret fails the release
   run loudly.
4. **Back up the minisign private key** — see [Private key backup](#private-key-backup).

## Required GitHub Actions secrets

| Secret | Purpose | How to set |
|--------|---------|------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key used to sign update bundles (`.sig` files) | Paste the **full contents** of `~/.tauri/fin-app.key` (local path: `~/.tauri/fin-app.key`). Never commit this file. |

Do **not** create a `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret. The keypair was
generated with an **empty password**. GitHub cannot store an empty secret value, and
a placeholder (such as a space) would be treated as the wrong password and minisign
decryption would fail.

The `tauri-apps/tauri-action@v0` step reads the token from the `GITHUB_TOKEN`
environment variable (it has no `token:` input); the workflow passes its own
`GITHUB_TOKEN`.

## Local builds and updater artifacts

`src-tauri/tauri.conf.json` sets `bundle.createUpdaterArtifacts: true` and pins an
updater public key. Any build that produces updater artifacts (including
`npm run tauri build` locally) requires the minisign private key exported as
`TAURI_SIGNING_PRIVATE_KEY` — either the full key contents or a path to
`~/.tauri/fin-app.key`. Without it, Tauri fails the bundle when a pubkey is
configured but no signing key is present.

In CI, the platform build jobs (`build-tauri`) run on PRs, pushes to `main`, and
`v*` tags. Non-release builds disable updater artifacts via a workflow overlay
(`src-tauri/ci-updater-off.json`, written at build time) so they never need the
signing secret, publish nothing, and run the three platforms in parallel; their
installers are uploaded as workflow artifacts and `verify-release` checks that
Linux, Windows, and macOS installers are all present. Because `fin-app` is a public
repo, these standard GitHub-hosted runner jobs (including macOS and Windows) do not
consume Actions minutes; the 10x/2x minute multipliers apply only to private repos.

## Private key backup

The minisign keypair lives at **`~/.tauri/fin-app.key`** (private) with the public
key pinned in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

**Back up the private key file** to secure offline storage. If you lose it:

- Existing installs can no longer verify updates signed with a new key.
- Users must **manually reinstall** from a fresh installer; the in-app updater
  cannot recover.

If you **regenerate** the keypair:

1. Update `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` with the new public key.
2. Update the `TAURI_SIGNING_PRIVATE_KEY` secret.
3. **Re-release all platforms** so every `latest.json` entry and `.sig` file matches
   the new key.

## Release flow

Releases are cut **automatically when a version bump is merged to `main`**:

1. **Bump the version** in a PR — the same semver in all three files (CI fails on a
   mismatch):
   - `src-tauri/tauri.conf.json` → `"version"`
   - `package.json` → `"version"` (and `package-lock.json`, e.g. `npm version 0.2.1 --no-git-tag-version`)
   - `src-tauri/Cargo.toml` → `version` (and the `fin-app` entry in `src-tauri/Cargo.lock`)
2. **Merge the PR to `main`.** The `release-meta` job reads the version; if no
   `v<version>` tag exists yet, this run is a release run: it builds and signs on all
   three platforms and creates the GitHub Release **and the `v<version>` tag** on the
   merge commit.
3. A merge that does not change the version (its `v<version>` tag already exists) runs
   the normal unsigned builds and publishes nothing.

Pushing a `v*` tag by hand still works (e.g. to re-run a release); the tag must equal
`v<version>` from `tauri.conf.json`, or CI fails.

CI on a release run:

- Runs quality gates (lint, tests, clippy).
- Builds installers on Linux, Windows, and macOS — on release runs these jobs are
  serialized to avoid a `latest.json` race (see workflow comments in
  `.github/workflows/ci.yml`); pushes to `main` never run concurrently.
- Signs updater artifacts with the minisign key.
- Publishes bundles, `.sig` files, and `latest.json` to
  the GitHub Release for the tag on `kdcllc/fin-app`.
- Runs `verify-release` to ensure `latest.json` includes Linux, Windows, and macOS.

## Unsigned installers (OS warnings)

fin-app does **not** use a Windows code-signing certificate or Apple Developer ID.
Installers are therefore **unsigned at the OS level**. The Tauri updater still
signs **update bundles** with minisign (see below) — OS signing and updater signing
are separate.

### Windows — SmartScreen

On first install, Windows may show **"Windows protected your PC"** / unknown publisher.

Workaround: click **More info**, then **Run anyway**.

### macOS — Gatekeeper

On first open, macOS may say the app **cannot be opened because the developer
cannot be verified**.

Workaround: **right-click** the app (or `.dmg`) → **Open** → confirm **Open** in
the dialog. You only need to do this once per install.

## How the in-app updater verifies integrity

1. On launch (and via Settings → Check for updates), the app fetches
   `latest.json` from the configured endpoint.
2. If a newer semver is available, it downloads the platform-specific update bundle.
3. The bundle's minisign **signature** (from the `.sig` file content embedded in
   `latest.json`) is checked against the pinned **`plugins.updater.pubkey`** in
   `tauri.conf.json`.
4. **Tampered or unsigned updates are rejected** — the app will not install them.

OS Gatekeeper/SmartScreen warnings apply to the **initial installer**, not to the
updater's minisign check.

## Post-merge verification limitation

Contract-time CI checks (YAML validity, tag-gated conditions) do **not** prove the
full release pipeline end-to-end. After you complete the [one-time setup](#one-time-setup-checklist),
run a **real tag build** (e.g. a patch release) and confirm:

- The GitHub Release appears on `kdcllc/fin-app` (Releases page).
- `latest.json` lists Linux, Windows, and macOS with `url` and `signature`.
- Installers and `.sig` assets are attached.
- An installed app can check for updates successfully.

Until that first tag build succeeds, treat the workflow as unverified in production.
