# Task 07.2 — Auto-updater via GitHub Releases

Status: todo

## Objective

Wire up `tauri-plugin-updater`: generate the updater signing keypair, sign artifacts in the release workflow, publish `latest.json` + artifacts to GitHub Releases, and add in-app update UX.

## Notes

- Keep the updater private key out of the repo (GitHub Actions secret); losing it means users must manually reinstall — document key backup.
- In-app UX: check on launch (and manual "Check for updates"), changelog display, download progress, restart prompt. Never auto-restart while an import/write session is running.
- Version bump + tag → release workflow builds, signs, uploads — one-command releases.

## Acceptance criteria

- v0.0.1 → v0.0.2 test release: app detects, downloads, verifies signature, and updates itself on Linux, Windows, and macOS.
- Tampered artifact (bad signature) is rejected.
