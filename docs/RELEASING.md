# Releasing fin-app

This runbook covers publishing a signed release to the public
[`kdcllc/fin-app-releases`](https://github.com/kdcllc/fin-app-releases) repo.
The private `fin-app` repo runs CI; tag builds sign updater artifacts and publish
installers, `.sig` files, and `latest.json` to the releases repo.

## One-time setup checklist

Complete these steps **once** before your first tag release:

1. **Create the public releases repo** — `kdcllc/fin-app-releases` (public). Initialize it
   with at least one commit on `main` (e.g. add a README). A zero-commit repo cannot host
   a GitHub Release. CI publishes releases against the `main` ref of that repo
   (`releaseCommitish` in the workflow).
2. **Confirm the updater endpoint** — `src-tauri/tauri.conf.json` must point at
   `https://github.com/kdcllc/fin-app-releases/releases/latest/download/latest.json`
   (already configured when this goal shipped).
3. **Store GitHub Actions secrets** in the private `fin-app` repo
   (Settings → Secrets and variables → Actions). Both are **required before
   pushing any `v*` tag**; missing secrets fail the pipeline loudly.
4. **Back up the minisign private key** — see [Private key backup](#private-key-backup).

## Required GitHub Actions secrets

| Secret | Purpose | How to set |
|--------|---------|------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key used to sign update bundles (`.sig` files) | Paste the **full contents** of `~/.tauri/fin-app.key` (local path: `~/.tauri/fin-app.key`). Never commit this file. |
| `RELEASES_REPO_TOKEN` | PAT that lets CI write to `kdcllc/fin-app-releases` | Fine-grained PAT recommended: **Contents → Read and write** on `kdcllc/fin-app-releases` only. Classic PAT alternative: `repo` scope limited to that repository. |

Do **not** create a `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret. The keypair was
generated with an **empty password**. GitHub cannot store an empty secret value, and
a placeholder (such as a space) would be treated as the wrong password and minisign
decryption would fail.

CI uses `RELEASES_REPO_TOKEN` by overriding the `GITHUB_TOKEN` environment variable
on the `tauri-apps/tauri-action@v0` step (`tauri-action@v0` has no `token:` input).

## Local builds and updater artifacts

`src-tauri/tauri.conf.json` sets `bundle.createUpdaterArtifacts: true` and pins an
updater public key. Any build that produces updater artifacts (including
`npm run tauri build` locally) requires the minisign private key exported as
`TAURI_SIGNING_PRIVATE_KEY` — either the full key contents or a path to
`~/.tauri/fin-app.key`. Without it, Tauri fails the bundle when a pubkey is
configured but no signing key is present.

CI disables updater artifacts on non-tag builds (PRs and pushes to `main`) via a
workflow overlay so those jobs do not need the signing secret. Tag releases still
sign and publish updater artifacts as described below.

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

1. **Bump the version** (same semver in both files):
   - `src-tauri/tauri.conf.json` → `"version"`
   - `package.json` → `"version"`
2. **Commit** the version bump to `main`.
3. **Create an annotated tag** matching the version, e.g. `v0.1.2`:
   ```bash
   git tag -a v0.1.2 -m "fin-app v0.1.2"
   ```
4. **Push the tag** (triggers CI on the private repo):
   ```bash
   git push origin v0.1.2
   ```

CI then:

- Runs quality gates (lint, tests, clippy).
- Builds installers on Linux, Windows, and macOS (serialized on tag builds to avoid
  a `latest.json` race — see workflow comments in `.github/workflows/ci.yml`).
- Signs updater artifacts with the minisign key.
- Publishes bundles, `.sig` files, and `latest.json` to
  `kdcllc/fin-app-releases` under the tag.
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

- The GitHub Release appears on `kdcllc/fin-app-releases`.
- `latest.json` lists Linux, Windows, and macOS with `url` and `signature`.
- Installers and `.sig` assets are attached.
- An installed app can check for updates successfully.

Until that first tag build succeeds, treat the workflow as unverified in production.
