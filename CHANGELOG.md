# Changelog

All notable changes to Lynricsx are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project intends to follow [Semantic Versioning](https://semver.org) once it
reaches 1.0.

## [Unreleased]

Nothing yet. This release marks the first public release preparation.

## [0.1.0] — first public release

First public release. Everything below is present in this version.

### Added

- **Media detection** through Windows GSMTC (`Windows.Media.Control`): title,
  artist, album, source app, playback state, position and duration, with
  event-driven updates plus a position clock, and seek detection.
- **Lyrics engine** with two providers — LiriQo (native word/syllable timing)
  and LRCLIB (line-synced LRC) — plus a plain-lyrics fallback, an LRC parser
  (multiple timestamps, `[offset:]`, enhanced word timestamps, metadata tags),
  duration-aware matching, request debouncing, and an on-disk cache.
- **Karaoke word sync** driven by real timestamps: upcoming / active / sung word
  states with timestamp-driven fill.
- **Code-style rendering**: lyric lines are composed into highlighted code using
  four composition styles (`flat`, `nested`, `comment`, `hybrid`) chosen from a
  deterministic per-track seed.
- **Desktop overlay**: frameless, always-on-top, draggable, click-through,
  configurable size and position, first-launch corner placement, and responsive
  wrapping.
- **Appearance**: three presets (`TERMINAL RED`, `CYBERPUNK`, `MINIMAL`),
  independent per-track syntax palettes, configurable font size, and a
  past-lyric appearance setting.
- **Typewriter animation** with six caret styles (block, line, underline, bar,
  hollow, off).
- **Playback controls** (previous / play-pause / next) through GSMTC.
- **Click-to-seek** on a lyric line and **lyric replay**.
- **Code Snapshot** PNG export.
- **Configurable lyric history** (1–20 lines, active line included) with
  focused behavior for the active expression.
- **Dynamic virtual filename** derived from track metadata (lowercased, accents
  folded, punctuation hyphenated), e.g. `backburner.niki.lyrics.ts`.
- **Live Terminal Session**: a real boot sequence, track initialisation,
  transition and playback messages, and status colours driven by actual events.
- **Easter egg system**: at most one cosmetic aside every four tracks, chosen
  deterministically from the track identity.
- **Ambient code activity** indicator reflecting playback state.
- **Cinematic track transitions** between two tracks.
- **Settings**: persisted JSON settings, start with Windows, cache size and
  clearing.

### Notes

- Windows only. macOS and Linux are not supported.
- No auto-updater; updates are manual installs.
