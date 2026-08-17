# Task 01.5 — CI pipeline for 3-OS builds

Status: done (this cycle 2026-08-17); leftover 3-OS artifacts deferred
Depends on: 01-scaffold-tauri (git repo + GitHub remote created there), 03-data-access-layer (tests to run)

## Objective

GitHub Actions workflow that lints, tests, and builds installable artifacts on Windows, macOS, and Linux (use `tauri-apps/tauri-action`).

## This cycle (2026-08-17) — quality-checks Linux deps only

User confirmed: do **not** finish the leftover 3-OS artifact publishing in this cycle. A GitHub remote now exists (`kdcllc/fin-app`). Push to `main` runs CI, but **Lint, Tests, and Clippy** fails in ~2 minutes with 2 annotations and the Tauri matrix build is skipped.

Diagnosis (local gates green; Actions logs unread — `gh` is a different GitHub user): `quality-checks` runs `cargo test` and `cargo clippy` on `ubuntu-latest` without installing WebKitGTK/GTK. Those packages exist only on the later `build-tauri` Ubuntu matrix leg, which never starts. Two missing-library errors match the 2 annotations.

When this cycle is done: `quality-checks` can compile the Tauri Rust crate on Ubuntu the same way `build-tauri` already can.

## Notes

- Layer(s) touched: CI workflow only (`.github/workflows/ci.yml`). Do not change application source, tests, or Goal 04 reporting files.
- `quality-checks` is `ubuntu-latest` only. Copy the `build-tauri` Ubuntu **script** (`sudo apt-get update` + the five packages). Do **not** copy `if: matrix.platform == 'ubuntu-latest'` — `quality-checks` has no matrix, so that guard would skip the install.
- Install exactly: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`. The step must run unconditionally and **before** `cargo test` / `cargo clippy`. `apt-get` can run after checkout; it does not need to precede Node/Rust setup.
- If cargo still fails after that install, **stop and report**. Do not change application, test, or Goal 04 sources in this cycle.
- Do not invent extra packages, a new workflow file, or a self-hosted runner.
- Signing/notarization stays deferred to Goal 07.
- Leftover (out of scope this cycle): downloadable MSI/NSIS, DMG, deb/AppImage artifacts from the workflow run.

## Acceptance criteria (this cycle)

- `.github/workflows/ci.yml` `quality-checks` has an **unconditional** step (no `if: matrix.platform`, no matrix context) that runs `sudo apt-get update` and installs exactly `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, and that step is **before** `cargo test` and `cargo clippy`.
- `quality-checks` still runs `npm run lint`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
- `build-tauri` still `needs: quality-checks` and still installs those packages on `ubuntu-latest` (do not remove them from the build job).
- Diff is `.github/workflows/ci.yml` only. No application source, test, or Goal 04 reporting change.

## Leftover acceptance criteria (not this cycle)

- Push to main produces downloadable 3-OS artifacts (MSI/NSIS, DMG, deb/AppImage).
