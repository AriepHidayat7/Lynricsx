# Contributing to Lynricsx

Thanks for taking the time to contribute. This document describes how the
project is actually structured, so your change fits the existing conventions.

## Before you start

- **Platform:** Lynricsx is Windows-only. The backend binds WinRT
  (`Windows.Media.Control`) and the Win32 registry directly; there is no
  cross-platform abstraction, so a PR that only works on macOS or Linux cannot
  be merged.
- **Scope:** the project is feature-complete for its current roadmap. Bug fixes,
  performance work, provider improvements and test coverage are the easiest
  things to get merged. For a new feature, please open an issue first so we can
  agree on the design before you write it.

## Getting set up

See [docs/BUILDING.md](docs/BUILDING.md) for prerequisites and exact commands.
The short version:

```powershell
npm install
npm run tauri:dev      # run the app
npm test               # 302 frontend tests
npx tsc --noEmit       # type check
```

## Project conventions

### Keep logic out of React

Anything with non-trivial behaviour belongs in `src/lib/*` as plain TypeScript
with **no React and no DOM dependency**. That is why the test suite can import
`.ts` sources directly under `node --test`, with no bundler and no jsdom.

If you put logic in a component, it becomes untestable here. Existing examples
to follow: `codeview.ts`, `sync.ts`, `compose.ts`, `seek.ts`, `replay.ts`,
`history.ts`, `position.ts`, `fileName.ts`, `pastLyrics.ts`.

### Tests

- **Frontend:** `tests/*.test.ts`, run by `node --test tests/`. No framework —
  `node:test` and `node:assert/strict` only. Don't add Jest/Vitest.
- **Backend:** `#[cfg(test)]` modules in the Rust files. Use MSVC for running
  them; see the known issue in [docs/BUILDING.md](docs/BUILDING.md#known-issue-cargo-test-on-the-gnu-target).

A bug fix should come with a test that **fails before the fix**. For CSS and
layout regressions, a source-contract test is acceptable and often the only
option — for example `tests/terminal-cursor-alignment.test.ts` reads
`terminal.css` and asserts `.term-pending` does not grow, because the failure
mode (a caret drifting to the right edge) is invisible to the type checker.

### Comments

Explain *why*, not *what*. The codebase deliberately carries comments describing
the reason a constraint exists (e.g. "the payload is emitted before the overlay
mounts, so the overlay also fetches settings on mount"). Match that tone.

### Settings and IPC

The overlay settings payload is duplicated by design: it is emitted from
`src-tauri/src/lib.rs` and projected in `overlaySettingsOf()` in
`src/lib/tauri.ts`. **If you add a field to one, add it to the other in the same
commit**, and update `tests/overlay-settings-bootstrap.test.ts`.

Adding a settings field also means updating `settings.rs` (struct + `Default`),
`src/types.ts`, and the docs table in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Backward compatibility

`settings.json` is user data. Old files must keep loading:

- Don't add `deny_unknown_fields`; unknown keys must be ignored.
- New fields need a sensible `Default`.
- Don't rename stored keys to fix a label. The past-lyric values are still
  `muted`/`dim`/`accent` while the UI says SUBTLE/BALANCED/STRONG — that
  mismatch is intentional.

Do **not** change the bundle identifier (`com.redlyrics.app`) or the Cargo
package name. Both would break existing installs, upgrade paths or autostart
entries.

### Commits and pull requests

Write commit messages in the imperative mood with a short scope prefix, e.g.
`overlay: keep caret adjacent to the status text`. Keep PRs focused; a PR that
mixes a refactor with a behaviour change is hard to review.

Before submitting:

```powershell
npm test
npx tsc --noEmit
npm run build
```

## Reporting bugs

Please include:

- Windows version and whether WebView2 is installed.
- The music player and how it was playing (the overlay reads **GSMTC**, so a
  player that does not publish a media session cannot provide lyrics).
- Whether the failure is in detection, lyric lookup or rendering.
- `%LOCALAPPDATA%\Lynricsx\logs\gsmtc.log` if media detection is involved.

For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.

By contributing, you agree that your contributions are licensed under the same
license as the project.
