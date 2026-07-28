# Goal 07 — Distribution & Auto-Update

**Milestone:** release · **Depends on:** Goal 01

## Objective

Installable, signed, auto-updating builds for Windows, macOS, and Linux using Tauri's built-in bundler and updater plugin, served from GitHub Releases — plus user-data backup/restore so updates are never scary.

## Success criteria

- One release workflow produces MSI/NSIS (Windows), DMG (macOS), and deb/rpm/AppImage (Linux) artifacts.
- Updater: app detects a new GitHub Release, verifies the minisign-style signature, and self-updates on all three OSes.
- Book file backup/restore: automatic rotating backups before schema migrations and on a schedule; one-click restore.

## Tasks

1. [Tauri bundler configuration & signing](tasks/01-bundler-signing.md)
2. [Auto-updater via GitHub Releases](tasks/02-auto-updater.md)
3. [Backup & restore of the book file](tasks/03-backup-restore.md)
