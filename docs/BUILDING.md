# Building Lynricsx

Everything here was executed on this project before being written down. Commands
are PowerShell unless stated otherwise.

Lynricsx builds **only on Windows**. The backend calls WinRT
(`Windows.Media.Control`) and the Win32 registry through the `windows` crate, so
there is no macOS or Linux build.

## Two toolchains

| Toolchain | Needs | Status |
| --- | --- | --- |
| `x86_64-pc-windows-gnu` | rustup + MinGW `windres` | **Default.** No administrator rights; used by `npm run tauri:build`. |
| `x86_64-pc-windows-msvc` | Visual Studio Build Tools with the C++ workload | Optional; simpler, but needs an elevated install of ~2–5 GB. |

`src-tauri/.cargo/config.toml` pins `rust-lld` as the GNU linker, so no extra
linker is required beyond `windres` for the resource file.

## Prerequisites

1. **Node.js 18+** with npm.
2. **Rust via rustup**, with the GNU toolchain:

   ```powershell
   winget install Rustlang.Rustup
   rustup toolchain install stable-x86_64-pc-windows-gnu
   rustup default stable-x86_64-pc-windows-gnu
   ```

3. **MinGW `windres`** (binutils) to compile `build.rs`'s resource:

   ```powershell
   winget install BrechtSanders.WinLibs.POSIX.UCRT
   ```

   `scripts/with-tools.mjs` looks for `windres.exe` in, in order:
   `%LOCALAPPDATA%\Microsoft\WinGet\Packages\*\mingw64\bin`,
   `C:\Program Files\WinLibs`, `C:\WinLibs`, `C:\mingw64`.
   If it finds none it warns and the resource step fails, so make sure one of
   those paths exists.

4. **WebView2 runtime** — preinstalled on Windows 10 1803+ and Windows 11.
   Only needed at build time for `cargo test` (see *Known issues*).

## Install dependencies

```powershell
npm install
```

`package-lock.json` and `src-tauri/Cargo.lock` are committed; keep them.

## Run in development

```powershell
npm run tauri:dev
```

This starts Vite on `http://localhost:1420` (strict port) and launches the Tauri
window. `npm run dev` alone starts only the web UI — the Rust IPC bridge and the
overlay window will be missing, so most of the app will not work.

## Build the installer

```powershell
npm run tauri:build
```

Outputs:

```
src-tauri\target\release\redlyrics.exe
src-tauri\target\release\bundle\nsis\Lynricsx_0.1.0_x64-setup.exe
```

The installer is **per-user** (`installMode: "currentUser"`) and needs no
administrator rights.

### Using MSVC instead

```powershell
rustup default stable-x86_64-pc-windows-msvc
npx tauri build
```

Skip `scripts/with-tools.mjs` for MSVC — `windres` is only needed for the GNU
target. Build with `cargo tauri build` directly, not via `npm run tauri:build`,
which forces the GNU toolchain.

## Tests and checks

| Command | What it covers | Verified |
| --- | --- | --- |
| `npm test` | 302 frontend tests (`node --test tests/`) | ✅ passes |
| `npx tsc --noEmit` | TypeScript, no emit | ✅ clean |
| `npm run build` | `tsc` + Vite production bundle | ✅ succeeds |
| `cargo check --target x86_64-pc-windows-gnu --tests` | Type-checks all Rust code incl. tests | ✅ exits 0 |
| `cargo test --target x86_64-pc-windows-gnu --lib` | Runs 65 Rust unit tests | ⚠️ see below |

### Known issue: `cargo test` on the GNU target

The Rust test binary links the whole Tauri stack. On the GNU target it fails to
start before any test executes, with `0xC0000139`
(`STATUS_ENTRYPOINT_NOT_FOUND`). The cause is that the project depends on
`windows` **0.58** while Tauri 2.12 pulls in `windows` **0.62**; both versions of
the COM bindings end up in the same image.

Putting the test executable's directory on `PATH` (for `WebView2Loader.dll`) does
**not** fix this.

Workarounds, in order of preference:

1. **Run the tests with MSVC** — on a machine with the Visual Studio C++ workload:

   ```powershell
   rustup default stable-x86_64-pc-windows-msvc
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

   This is what CI uses, where the runner already has the C++ workload.
2. **Type-check only** on GNU: `cargo check --tests` (no test execution).
3. The real fix is migrating to `windows` 0.62, which changes the WinRT
   `IAsyncOperation` and event-handler APIs in `gsmtc.rs` and `media_worker.rs`.
   That is a deliberate change, tracked separately.

Until this is resolved, **do not treat a GNU `cargo test` failure as a product
regression**.

## Icons

The committed icon set in `src-tauri/icons/` is generated from `app-icon.png`:

```powershell
npm run icon
```

`app-icon.png` is an intermediate (gitignored); the generated icons are
committed because Tauri needs them at build time.
