// Click-to-seek target resolution.
//
// The overlay renders *rows* (opening delimiter, statement, closing delimiter),
// but seek targets are *lyric lines*. A click on any row of a block — brace,
// indentation, comment or statement — must resolve to the same logical lyric.
//
// Everything here is pure so the mapping can be verified without a window, and
// no timestamp is ever derived from a visual position: the target always comes
// from the lyric line's own `startMs`.

import type { LyricLine } from "../types";
import type { CodeLine } from "./codeview";

/** A seek target in milliseconds. */
export interface SeekTarget {
  /** Position to seek to. */
  ms: number;
  /** Index of the lyric line in `context.lines`. */
  lineIndex: number;
}

/**
 * Whether a lyric line carries a usable timestamp.
 *
 * Lyrics without sync (`startMs < 0`) cannot be seeked to: guessing would move
 * playback to the wrong place, so such lines are simply not clickable.
 */
export function isSeekable(line: LyricLine | undefined): boolean {
  return !!line && Number.isFinite(line.startMs) && line.startMs >= 0;
}

/**
 * Resolves the seek target for a rendered code row.
 *
 * `row` is a `CodeLine` from the composition, whose `lyricIndex` points back at
 * the originating lyric line. That index is preserved through flattening, so a
 * delimiter row seeks to the same moment as the statement it surrounds.
 *
 * Returns `null` when the row has no backing lyric, the lyric has no valid
 * timestamp, or the index is out of range — the caller then does nothing rather
 * than seeking somewhere arbitrary.
 */
export function seekTargetForRow(
  row: Pick<CodeLine, "lyricIndex"> | undefined,
  lines: LyricLine[],
): SeekTarget | null {
  if (!row) return null;
  const lineIndex = row.lyricIndex;
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }
  const line = lines[lineIndex];
  if (!isSeekable(line)) return null;
  return { ms: Math.round(line.startMs), lineIndex };
}

/**
 * Resolves a seek target from a 0..1 fraction of the track.
 *
 * Backs the mini progress indicator. `durationMs` comes from the media session,
 * not from the lyrics, so the result is correct even for unsynced tracks.
 */
export function seekTargetForFraction(fraction: number, durationMs: number): number | null {
  if (!Number.isFinite(fraction) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * durationMs);
}

/** `mm:ss` for timestamps and terminal messages. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
