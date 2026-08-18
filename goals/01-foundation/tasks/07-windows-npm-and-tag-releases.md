# Task 01.7 — Skip test-native npm scripts on Tauri builds; release on v* tags

Status: done (judge PASS 5/5, 2026-08-18)
Depends on: 01.6 (parallel quality-js / quality-rust / build-tauri)

## Objective

Windows `build-tauri` no longer dies in `npm ci` compiling `better-sqlite3` (Vitest-only; the app uses rusqlite). Pushing a `v*` tag creates a GitHub Release and uploads the three-OS installers. Ordinary `main` / PR builds still compile all three platforms but **do not** create or update a Release. Signing and the in-app updater stay Goal 07.

## Diagnosis (Windows log, ~1m)

`npm ci` on `windows-latest` runs `better-sqlite3` `prebuild-install || node-gyp rebuild`. No win32 Node 20 prebuild; node-gyp cannot use VS 18 (`unknown version "undefined" at ...\Visual Studio\18\Enterprise`). The echarts `EPERM` lines are cleanup after that failure. `better-sqlite3` is a **devDependency** used only by `tests/support/test-db.ts`. `build-tauri` never runs Vitest.

## Notes

- Layer: `.github/workflows/ci.yml` only. Diff is that file only. Do not change `package.json`, lockfile, application source, or tests. Do not remove `better-sqlite3`.
- `quality-js` stays Ubuntu and keeps `npm ci` (no `--ignore-scripts`) so the native module still builds for tests.
- Lockfile install scripts are only `better-sqlite3`, `esbuild`, `fsevents`. `build-tauri` **Install JS dependencies** must be `npm ci --ignore-scripts` on all three OS so `better-sqlite3` never runs node-gyp. `tauri.conf.json` `beforeBuildCommand` is `npm run build` (`src` only). If that fails for a missing native binary after `--ignore-scripts`, **stop and report**. Do not add MSVC/node-gyp/Visual Studio steps.
- Stay on `tauri-apps/tauri-action@v0`. Do **not** bump to `@v1`. v0 updater-JSON input is `includeUpdaterJson` (default `true`). Always set `includeUpdaterJson: false`. Do not use the v1 name `uploadUpdaterJson`.
- `on.push.tags` includes `'v*'` (quote the glob). `on.push.branches` still has `main`. `pull_request` to `main` remains.
- `build-tauri` still runs on push to `main` and `pull_request` to `main` (same 3-OS matrix). **Never** put a tag-only `if` on the `build-tauri` **job** or on the `tauri-action` **step** — that step must always run the build. Use the empty-`tagName` `with:` block (not two steps) so non-tags build without uploading.
- `build-tauri` still `needs: [quality-js, quality-rust]`.
- `build-tauri` needs `permissions: contents: write`. `GITHUB_TOKEN` stays `${{ secrets.GITHUB_TOKEN }}`.
- Copy-paste `tauri-action` `with:` (v0 treats empty `tagName` as skip-upload):

```yaml
tagName: ${{ github.ref_type == 'tag' && github.ref_name || '' }}
releaseName: ${{ github.ref_type == 'tag' && format('fin-app {0}', github.ref_name) || '' }}
releaseDraft: false
prerelease: false
includeUpdaterJson: false
```

- Do **not** set `tagName: v__VERSION__` or any always-on tag.
- Do not add Apple/Windows signing, updater plugin, dual mac targets, a second workflow file, or self-hosted runners.

## Acceptance criteria

- Diff is `.github/workflows/ci.yml` only. No `package.json`, lockfile, application, or test changes. `better-sqlite3` stays a `devDependency`.
- `build-tauri` JS install is exactly `npm ci --ignore-scripts`. `quality-js` JS install remains `npm ci` (no `--ignore-scripts`).
- `on.push.tags` includes `'v*'`. `on.push.branches` still includes `main`. `pull_request` to `main` remains.
- `build-tauri` still runs on `push` to `main` and `pull_request` to `main` (ubuntu/windows/macos matrix). No job-level `if` that skips non-tags.
- `build-tauri` still `needs: [quality-js, quality-rust]`.
- `build-tauri` has `permissions.contents: write`.
- `tauri-apps/tauri-action@v0` (not `@v1`) sets `includeUpdaterJson: false` (required, not optional).
- `tagName` / `releaseName` use the tag-or-empty expressions above (or equivalent empty on non-tags). No `releaseId`. No `tagName: v__VERSION__`.
- `releaseDraft: false` and `prerelease: false`.
