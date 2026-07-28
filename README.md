# fin-app

A cross-platform, local-first personal-finance desktop app that replaces a yearly Excel
bill-pay workbook and integrates with GnuCash: multi-year expense tracking, reports
(by category, payee, account, and trends over time), with all data stored on the local
machine — no cloud, no server. Built with Tauri 2.x (Rust core + React/TypeScript UI over
SQLite), the stack recommended in [docs/RESEARCH.md](docs/RESEARCH.md) §3.

## Development environment

### Prerequisites (all platforms)

- **Node.js** ≥ 20 (developed with v22) and npm
- **Rust** stable toolchain via [rustup](https://rustup.rs) (developed with 1.97),
  including `rustfmt` and `clippy` components:

  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain stable --component rustfmt --component clippy
  ```

### Linux

Tauri needs WebKitGTK and friends (Debian/Ubuntu package names):

```sh
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

`libwebkit2gtk-4.1-dev` pulls in the required GTK3, libsoup3, JavaScriptCoreGTK, and
D-Bus development libraries. For `.deb`/AppImage bundling also install `patchelf`.
See the [Tauri Linux prerequisites](https://tauri.app/start/prerequisites/) for other distros.

### Windows

- Microsoft Visual Studio C++ Build Tools (Desktop development with C++)
- WebView2 runtime (preinstalled on Windows 10 1803+ / Windows 11)

### macOS

- Xcode Command Line Tools: `xcode-select --install`

## Commands

| Command                | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `npm install`          | Install JS dependencies                                            |
| `npm run tauri dev`    | Launch the desktop app with hot reload (Vite on :1420)             |
| `npm run tauri build`  | Build the release binary + installers (`src-tauri/target/release`) |
| `npm run dev`          | Frontend-only Vite dev server                                      |
| `npm run build`        | Type-check (`tsc`) and build the frontend bundle                   |
| `npm run lint`         | ESLint over `src/`                                                 |
| `npm run format`       | Prettier write                                                     |
| `npm run format:check` | Prettier check (CI-safe)                                           |
| `cargo fmt --check`    | Rust formatting check (run in `src-tauri/`)                        |
| `cargo clippy`         | Rust lints (run in `src-tauri/`; needs Linux packages above)       |

### Linux Snap note (VS Code / Code Insiders)

When VS Code is installed via Snap, inherited GTK module paths can load Snap runtime
libraries (`/snap/core20/...`) that are ABI-incompatible with host `glibc`, causing:

- `symbol lookup error: ... libpthread.so.0: undefined symbol: __libc_pthread_init`

If that happens, run Tauri with Snap GTK environment variables removed:

```sh
env -u GTK_PATH -u GTK_EXE_PREFIX -u GTK_IM_MODULE_FILE npm run tauri dev
```

If `localhost:1420` is refused, check whether the Tauri process crashed with the symbol
lookup error above and restart using the command in this section.

## Project layout

- `src/` — React + TypeScript frontend
- `src-tauri/` — Rust backend (Tauri commands, config in `src-tauri/tauri.conf.json`)
- `docs/RESEARCH.md` — research report the project plan is based on
- `goals/` — goal and task breakdown driving implementation

> Note: `*.xlsx` files are git-ignored on purpose — the source workbook contains real
> personal financial data and must never be committed.
