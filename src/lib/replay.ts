// Lyric replay (section loop).
//
// A replay is a *request* to keep playback inside a lyric line range. It is
// expressed in lyric timestamps and enforced by the same `media_seek` path as
// click-to-seek, so it never invents a second synchronization mechanism.
//
// All decision logic lives here as pure functions: the overlay only feeds them
// the current sample and performs whatever seek they ask for.

import type { LyricLine } from "../types";
import { isSeekable } from "./seek.ts";

export interface ReplayRange {
  /** First lyric line index, inclusive. */
  from: number;
  /** Last lyric line index, inclusive. */
  to: number;
  /** When true, reaching the end seeks back to the start instead of stopping. */
  loop: boolean;
}

export interface ReplayState {
  range: ReplayRange | null;
}

export function initialReplayState(): ReplayState {
  return { range: null };
}

/** Milliseconds of a line range, taken from the lyrics' own timestamps. */
export interface ReplayBounds {
  startMs: number;
  /** End of the last line, or +2s when the line has no end timestamp. */
  endMs: number;
}

/**
 * Start/end timestamps for a range, or `null` when the range is unusable.
 *
 * Requires both ends to have valid timestamps; a range whose boundary lines are
 * unsynced cannot be replayed accurately and is rejected rather than guessed.
 */
export function replayBounds(lines: LyricLine[], range: ReplayRange): ReplayBounds | null {
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  if (from < 0 || to >= lines.length) return null;
  const first = lines[from];
  const last = lines[to];
  if (!isSeekable(first) || !isSeekable(last)) return null;

  const startMs = Math.round(first.startMs);
  // A line's own end, or the next line's start, or a short fallback window.
  const next = lines[to + 1];
  const naturalEnd = isSeekable(next) ? next.startMs : last.endMs;
  let endMs = Math.round(naturalEnd);
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    endMs = startMs + Math.max(800, Math.round(last.endMs - last.startMs) || 2000);
  }
  return { startMs, endMs };
}

/** SECURITY/behaviour guard: never seek more often than this. */
export const REPLAY_MIN_GAP_MS = 700;

/**
 * Decides whether a replay needs to seek right now.
 *
 * Returns the target position in ms, or `null` when playback should be left
 * alone. Deliberately conservative:
 *  - playback before the range start is pulled back to the start;
 *  - playback past the range end rewinds when looping, or ends the replay when
 *    not looping (reported via `ended`);
 *  - a minimum gap prevents a burst of seeks while the player catches up.
 */
export function replayAction(
  lines: LyricLine[],
  state: ReplayState,
  positionMs: number,
  nowMs: number,
  lastSeekAt: number,
): { seekTo: number | null; ended: boolean } {
  if (!state.range) return { seekTo: null, ended: false };
  const bounds = replayBounds(lines, state.range);
  if (!bounds) return { seekTo: null, ended: true };

  if (nowMs - lastSeekAt < REPLAY_MIN_GAP_MS) return { seekTo: null, ended: false };

  // Before the section: jump forward to its start.
  if (positionMs < bounds.startMs - 60) {
    return { seekTo: bounds.startMs, ended: false };
  }
  // Past the section: loop, or stop.
  if (positionMs > bounds.endMs) {
    if (state.range.loop) return { seekTo: bounds.startMs, ended: false };
    return { seekTo: null, ended: true };
  }
  return { seekTo: null, ended: false };
}

/**
 * Ensures a replay range still belongs to the current lyrics.
 *
 * Called on track change: a range from the previous song must never be applied
 * to the new one, so it is dropped when the track key differs.
 */
export function replaySurvivesTrackChange(
  state: ReplayState,
  prevKey: string,
  nextKey: string,
): ReplayState {
  if (prevKey === nextKey) return state;
  return initialReplayState();
}
