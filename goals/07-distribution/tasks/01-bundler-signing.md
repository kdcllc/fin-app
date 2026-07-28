# Task 07.1 — Tauri bundler configuration & signing

Status: todo

## Objective

Production bundle configuration for all targets: MSI + NSIS (Windows), DMG (macOS), deb + rpm + AppImage (Linux) — with icons, metadata, and OS code signing where available.

## Notes

- macOS: signing + notarization needs an Apple Developer ID ($99/yr) — decide whether to pay or ship unsigned with documented right-click-open instructions. Windows: code-signing cert optional; SmartScreen warnings if unsigned — document the trade-off.
- Linux artifacts need no OS signing (updater signature covers integrity, Task 07.2).
- App icon set generated for all platforms (`tauri icon`).

## Acceptance criteria

- Release build installs and launches cleanly on all three OSes from the produced artifacts.
- Signing decision documented in the repo (what's signed, what warnings users will see).
