# Task 01.5 — CI pipeline for 3-OS builds

Status: todo
Depends on: 01-scaffold-tauri (git repo + GitHub remote created there), 03-data-access-layer (tests to run)

## Objective

GitHub Actions workflow that lints, tests, and builds installable artifacts on Windows, macOS, and Linux (use `tauri-apps/tauri-action`).

**Prerequisite:** a GitHub remote. Task 01 creates only a local git repo (user decision 2026-07-28: local dev for now), so this task is **deferred/BLOCKED** until the user adds a remote. The workflow file may still be authored and committed locally so it activates on first push.

## Notes

- Matrix: `ubuntu-latest`, `windows-latest`, `macos-latest`; install Linux WebKitGTK deps in the Ubuntu job.
- Cache Rust (`Swatinem/rust-cache`) and npm to keep build times sane.
- Signing/notarization is deferred to Goal 07 — unsigned artifacts are fine here.

## Acceptance criteria

- Push to main runs lint + tests + 3-OS builds; artifacts (MSI/NSIS, DMG, deb/AppImage) downloadable from the workflow run.
- CI is red if tests or clippy fail.
