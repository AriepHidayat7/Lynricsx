# Architecture

This document describes how Lynricsx is built. It reflects the code as it exists
in this repository — every component named here can be found in the tree.

Lynricsx is a **Tauri 2** desktop application with two webviews and a Rust
backend:

```
┌────────────────────────────┐   ┌────────────────────────────┐
│  Control panel (main)      │   │  Overlay window            │
│  index.html → main.tsx     │   │  overlay.html →            │
│  App.tsx                   │   │  overlay-main.tsx          │
└─────────────┬──────────────┘   └─────────────┬──────────────┘
              │  Tauri IPC (invoke / events)   │
              └───────────────┬────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Rust backend (src-tauri/src)                                │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ media_     │  │ lyrics/      │  │ settings.rs           │ │
│  │ worker.rs  │─▶│ liriqo.rs    │  │ autostart.rs          │ │
│  │ (GSMTC)    │  │ lrclib.rs    │  │ diag.rs               │ │
│  │ gsmtc.rs   │  │ lrc.rs       │  │ lib.rs (IPC surface)  │ │
│  └────────────┘  │ cache.rs     │  └───────────────────────┘ │
│                  │ selection.rs │                            │
│                  └──────────────┘                            │
└──────────────────────────────────────────────────────────────┘
                              ▼
       Windows GSMTC (Windows.Media.Control) + HTTP providers
```

## Process and window model

| Window | Label | HTML entry | Purpose |
| --- | --- | --- | --- |
| Control panel | `main` | `index.html` | Settings, now-playing info, cache management |
| Overlay | overlay | `overlay.html` | Frameless, always-on-top lyrics surface |

Only `main` is declared in `src-tauri/tauri.conf.json`; the overlay window is
created at runtime by the backend. Vite builds two entries (`main` and
`overlay`) — see `vite.config.ts` `rollupOptions.input`.


## Backend (`src-tauri/src`)

| File | Responsibility |
| --- | --- |
| `main.rs` | Thin binary entry; delegates to the library. |
| `lib.rs` | Tauri builder, command registration, IPC surface, overlay window creation. |
| `media_worker.rs` | Samples the dominant media session and publishes snapshots. |
| `gsmtc.rs` | WinRT `Windows.Media.Control` integration, playback event subscription. |
| `lyrics/mod.rs` | Provider-agnostic trait and shared types. |
| `lyrics/liriqo.rs` | LiriQo provider (native word/syllable timing). |
| `lyrics/lrclib.rs` | LRCLIB provider (line-synced LRC). |
| `lyrics/lrc.rs` | LRC parser (`[mm:ss.cc]`, multiple timestamps, `[offset:]`, enhanced word timestamps, metadata tags). |
| `lyrics/cache.rs` | On-disk lyrics cache. |
| `lyrics/selection.rs` | Provider priority and duration-aware matching. |
| `settings.rs` | Persisted settings model and defaults. |
| `autostart.rs` | "Start with Windows" via the Startup folder. |
| `diag.rs` | Diagnostic log under `%LOCALAPPDATA%\Lynricsx\logs\`. |

### Media detection

`media_worker.rs` samples the GSMTC session roughly every 250 ms and returns
title, artist, album, source app, playback state, position and duration. A
snapshot is published when the track or state changes, once per position second
while playing, and immediately when a seek is detected (a position jump the
elapsed wall clock cannot explain). It also subscribes to
`PlaybackInfoChanged`, re-arming the subscription when the dominant session
changes.

### Lyrics selection

`lyrics/selection.rs` applies a fixed priority:

1. Native word/syllable timing (LiriQo)
2. LRCLIB line-synced LRC
3. LiriQo line-synced LRC
4. Plain (untimed) lyrics

The reported sync level is always the level actually obtained — the UI never
claims word sync when only line timing was returned.


## Frontend (`src`)

| Area | Files |
| --- | --- |
| Entries | `main.tsx` (control panel), `overlay-main.tsx` (overlay) |
| Screens | `App.tsx`, `components/Overlay.tsx`, `components/SettingsPanel.tsx` |
| Overlay chrome | `components/TerminalView.tsx`, `components/ActivityBars.tsx`, `components/PlaybackControls.tsx`, `components/SnapshotToast.tsx` |
| Pure lyric logic | `lib/codeview.ts`, `lib/compose.ts`, `lib/sync.ts`, `lib/history.ts`, `lib/position.ts` |
| Interaction | `lib/seek.ts`, `lib/replay.ts` |
| Presentation | `lib/snapshot.ts`, `lib/terminal.ts`, `lib/termFit.ts`, `lib/easterEggs.ts`, `lib/pastLyrics.ts`, `lib/fileName.ts` |
| IPC | `lib/tauri.ts` |
| Styles | `styles/overlay.css`, `styles/terminal.css`, `styles/app.css` |

### Pure logic vs. React

Anything with interesting behaviour is kept in `src/lib/*` as plain TypeScript
with no React or DOM dependency (`codeview.ts`, `sync.ts`, `compose.ts`,
`seek.ts`, `replay.ts`, `history.ts`, `position.ts`, `fileName.ts`,
`pastLyrics.ts`). This is what makes the test suite possible: `node --test`
imports the `.ts` sources directly, with no bundler and no jsdom.

### Rendering pipeline

1. `codeview.ts` turns each lyric line into `CodeToken`s. Every lyric token
   keeps a character range back into `line.text` and an optional timing window,
   so display never loses the source.
2. `compose.ts` picks one of four composition styles (`flat`, `nested`,
   `comment`, `hybrid`) from a per-track deterministic seed. A song has a
   dominant style, but groups rotate through the others.
3. `Overlay.tsx` runs a `requestAnimationFrame` loop that binary-searches the
   active line and word from the extrapolated position and re-renders only when
   the line/word state actually changes.
4. Word fill follows the real word timestamps, not CSS animation durations.
5. `history.ts` keeps completed lines for the configured history size and
   `pastLyrics.ts` supplies their opacity.
6. `snapshot.ts` serialises the rendered rows to SVG, rasterises them to a
   canvas and downloads a PNG.

### Settings and IPC contract

`lib/tauri.ts` mirrors the Rust settings model. Because the overlay receives its
configuration through an `overlay:settings` event that fires before the overlay's
listener mounts, `Overlay.tsx` also calls `getSettings()` once on mount and
projects it with `overlaySettingsOf()` — this closes the bootstrap race where the
overlay could stay on its defaults.

Any field added to the payload emitted from `lib.rs` must be added to
`overlaySettingsOf()` in the same change; the function's doc comment states this.

## Tests

Frontend: `npm test` (`node --test tests/`). Backend: `cargo test` in
`src-tauri`. See [BUILDING.md](./BUILDING.md).

Tests split into three kinds:

- **Pure-logic tests** import from `src/lib/*` and assert behaviour
  (`codeview`, `sync`, `compose`, `seek`, `replay`, `snapshot`, …).
- **Source-contract tests** read a component or stylesheet as text and assert a
  structural property that TypeScript cannot express — for example that
  `.term-pending` does not use `flex-grow: 1`, or that the About page never
  prints the legacy bundle identifier (`tests/about-paths.test.ts`,
  `tests/terminal-cursor-alignment.test.ts`).
- **Settings-contract tests** guard the IPC payload shape
  (`tests/overlay-settings-bootstrap.test.ts`).

## Identifiers and backward compatibility

| Identifier | Value | Status |
| --- | --- | --- |
| Tauri `productName` | `Lynricsx` | Public brand |
| Bundle identifier | `com.redlyrics.app` | **Frozen** — changing it would orphan existing settings and caches |
| Cargo package / binary | `redlyrics` / `redlyrics_lib` | Internal only; the installer, shortcuts and version info all say "Lynricsx" |

The legacy identifier is intentionally retained so upgrades keep user data.
`SettingsPanel.tsx` collapses it to `Roaming\\…` / `Local\\…` before display so
the old name never appears in the UI, and `tests/about-paths.test.ts` pins that
rule.

## Deliberate limits

- **Windows only.** The backend binds WinRT (`Windows.Media.Control`,
  `Windows.System.Registry`) through the `windows` crate; there is no
  cross-platform abstraction.
- **No simulated data.** Every overlay message is derived from a real event.
  The activity bars reflect playback state, not audio analysis.
- **No auto-updater.** Bundling targets NSIS only; updates are manual installs.
