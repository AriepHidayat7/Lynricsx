# Third-Party Licenses and Attributions

Lynricsx is built on the work of others. This document lists the third-party
dependencies and services it uses, and how each is licensed.

**Status:** reviewed for the first public release; no incompatible or unclear
licenses were found. See [Upstream projects](#upstream-projects-and-services)
for the projects that need attribution but are not dependencies.

## Summary

| Category | Count | Licenses |
| --- | --- | --- |
| Bundled fonts, images, sounds | **0** | Nothing is bundled |
| Direct npm dependencies | 3 runtime + 6 dev | MIT, Apache-2.0 |
| Direct Rust crates | 8 | MIT / Apache-2.0 (all permissive) |
| Network services | 2 | Used over public HTTP APIs |

Nothing in the project is copied code: no vendored files, no copied snippets, no
inlined third-party source.

## Assets

Lynricsx ships **no** third-party fonts, images, sounds or other media:

- **Fonts** are referenced by name only, from the system font stack
  (`Cascadia Code`, `Consolas`, `Cascadia Mono`, `Courier New`, `monospace`).
  Nothing is downloaded or embedded. Rendering therefore depends on what the
  user has installed, and no font license needs to be redistributed.
- **Icons** in `src-tauri/icons/` are generated from the project's own
  `app-icon.png`.
- **Snapshot export** rasterises the user's own on-screen lyrics with the
  browser canvas; it bundles no artwork.

## npm dependencies

Runtime:

| Package | License |
| --- | --- |
| `react` | MIT |
| `react-dom` | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |

Development:

| Package | License |
| --- | --- |
| `@tauri-apps/cli` | Apache-2.0 OR MIT |
| `@vitejs/plugin-react` | MIT |
| `vite` | MIT |
| `typescript` | Apache-2.0 |
| `@types/react` | MIT |
| `@types/react-dom` | MIT |

Exact resolved versions are pinned in `package-lock.json`.

## Rust crates

Direct dependencies from `src-tauri/Cargo.toml`:

| Crate | License (typical) |
| --- | --- |
| `tauri`, `tauri-build` | Apache-2.0 OR MIT |
| `serde`, `serde_json` | MIT OR Apache-2.0 |
| `log` | MIT OR Apache-2.0 |
| `reqwest` | MIT OR Apache-2.0 |
| `tokio` | MIT |
| `windows` | MIT OR Apache-2.0 |

All are permissively licensed and are compatible with MIT, Apache-2.0 and
GPL-3.0 project licenses. Transitive versions are pinned in
`src-tauri/Cargo.lock`; note that `Cargo.lock` currently resolves both
`windows` 0.58 and 0.62 (see [BUILDING.md](./BUILDING.md#known-issue-cargo-test-on-the-gnu-target)).

> Licenses above reflect each crate's declared license. For a legally binding
> statement, consult the `LICENSE*` file in each crate's source.

## Upstream projects and services

These are not linked into the binary, but Lynricsx exists because of them and
they are credited in the README:

| Project | Role | Notes |
| --- | --- | --- |
| [Tauri](https://tauri.app) | Application framework | Apache-2.0 OR MIT |
| [React](https://react.dev) | UI library | MIT |
| [Vite](https://vite.dev) | Frontend build tool | MIT |
| [LiriQo](https://github.com/AlFarrizi-Studio/LiriQo) | Lyrics provider | **Accessed over HTTP**; no code is vendored |
| [LRCLIB](https://lrclib.net) | Lyrics provider | Public service; no code is vendored |

### About the lyric providers

Lynricsx does **not** copy or redistribute lyric data or provider code. It sends
a track query over HTTPS, parses the response at runtime, and caches the result
locally for that user. The displayed lyrics remain the property of their
respective rights holders and providers.

LiriQo is accessed only through its public API endpoint
(`api.liriqo-alfarrizi.my.id`), and LRCLIB through `lrclib.net`. If a provider
changes its terms, that is a service-usage question rather than a licensing
question for this repository — but it should be reviewed before a release if
either provider publishes new terms.

## Windows platform components

- **WebView2** (Microsoft Edge WebView2 Runtime) renders the UI and is a
  redistributable Microsoft runtime, preinstalled on Windows 10/11.
- **Windows GSMTC** (`Windows.Media.Control`) is a Windows system API.

Neither is redistributed by this repository.

## Reporting a licensing problem

If you believe a dependency or asset is misattributed here, please open an issue
or report it privately per [SECURITY.md](../SECURITY.md). We would rather fix an
attribution error than ship it.
