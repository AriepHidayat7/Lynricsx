import type { LyricLine, TimedWord, TrackSnapshot } from "../types";

/**
 * Returns the index of the line that is currently active for `positionMs`.
 * Lines are sorted by `startMs`; the active line is the last one whose start
 * time is <= the current position. Returns -1 for unsynced/empty lyrics.
 */
export function activeLineIndex(lines: LyricLine[], positionMs: number): number {
  if (lines.length === 0) return -1;
  if (lines[0].startMs < 0) return -1; // plain lyrics have no timing
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Returns the index of the active word within a line for `positionMs`.
 *
 * Uses native word timestamps only — no invented timing. Returns -1 when the
 * line has no word data or the position precedes the first word.
 */
export function activeWordIndex(words: TimedWord[], positionMs: number): number {
  if (!words || words.length === 0) return -1;
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export type WordState = "upcoming" | "active" | "sung";

/**
 * Classifies a single word at `positionMs`:
 * - sung:     the word's end has passed
 * - active:   the word is being sung right now
 * - upcoming: the word has not started yet
 */
export function wordState(word: TimedWord, positionMs: number): WordState {
  if (positionMs >= word.endMs) return "sung";
  if (positionMs >= word.startMs) return "active";
  return "upcoming";
}

/**
 * Progress (0..1) through the currently active word, used to drive a smooth
 * fill/highlight that follows the real timestamp rather than a CSS duration.
 */
export function wordProgress(word: TimedWord | undefined, positionMs: number): number {
  if (!word) return 0;
  const span = word.endMs - word.startMs;
  if (span <= 0) return positionMs >= word.startMs ? 1 : 0;
  return Math.min(1, Math.max(0, (positionMs - word.startMs) / span));
}

/**
 * Extrapolates the playback position from the last known snapshot using the
 * wall clock, so lyrics advance smoothly between the ~1 Hz media updates.
 *
 * While paused, the reported position is used as-is (no drift).
 */
export function interpolatePosition(track: TrackSnapshot, now: number): number {
  if (!track.hasSession) return 0;
  let pos = track.positionMs;
  if (track.playbackState === "playing" && track.sampledAtMs > 0) {
    pos += now - track.sampledAtMs;
  }
  if (track.durationMs > 0 && pos > track.durationMs) {
    pos = track.durationMs;
  }
  return Math.max(0, pos);
}

/** Display clock resolution: positions closer than this reuse the last state. */
export const CLOCK_RESOLUTION_MS = 250;
/**
 * A backward move is always a discontinuity; a forward move is only treated as
 * one when it overshoots this much beyond ordinary playback progress.
 *
 * Must exceed the player's coarse update step (Spotify publishes ~4.5 s jumps),
 * otherwise every normal refresh would be mistaken for a scrub.
 */
export const SEEK_FORWARD_SLACK_MS = 6000;

/** How the overlay clock should react to a new sample. */
export interface ClockStep {
  /** The position to render. */
  position: number;
  /** True when the sample is a discontinuity (a seek), not playback progress. */
  seek: boolean;
  /** True when the rendered position should be updated at all. */
  update: boolean;
}

/**
 * Decides how to apply a newly sampled position.
 *
 * The critical property: a seek must be recognised and applied on the *same
 * frame*, in both directions, while ordinary playback is throttled to the
 * display resolution. Relying on "the position changed a lot" alone is what
 * previously left lyrics stuck after a scrub — a backward jump or a jump
 * smaller than the display threshold was swallowed.
 *
 * @param previous the position currently rendered
 * @param next     the freshly interpolated position
 */
export function clockStep(previous: number, next: number): ClockStep {
  const delta = next - previous;
  // Backwards can only be a seek: playback never rewinds.
  const seek = delta < 0 || delta > SEEK_FORWARD_SLACK_MS;
  const update = seek || Math.abs(delta) >= CLOCK_RESOLUTION_MS;
  return { position: next, seek, update };
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** A contiguous run of the natural line text sharing one highlight state. */
export interface CharSpan {
  text: string;
  state: WordState;
}

const isWhitespace = (ch: string) => ch === " " || ch === "\t" || ch === "\n";

/**
 * Reconstructs the natural display text of a lyric line while classifying each
 * character by the fragment (word / syllable / character) that covers it.
 *
 * The authoritative display source is `line.text`; timed fragments are used
 * ONLY for highlighting. Whitespace is never inserted between fragments — it is
 * taken verbatim from the original line text, so character-level timing can
 * never produce `"A s l o n g …"`.
 *
 * The result is a list of runs to render; runs of equal state are merged for a
 * small DOM footprint.
 */
export function classifyLine(line: LyricLine, position: number): CharSpan[] {
  const text = line.text ?? "";
  const words = line.words ?? [];

  if (!text) return [];
  if (words.length === 0) {
    return [{ text, state: "upcoming" }];
  }

  // Flatten every fragment into its raw characters (whitespace kept only so we
  // can lock-step past it), each tagged with that fragment's playback state.
  const fragChars: { ch: string; state: WordState }[] = [];
  for (const w of words) {
    const st = wordState(w, position);
    for (const ch of w.text) {
      fragChars.push({ ch, state: isWhitespace(ch) ? "upcoming" : st });
    }
  }

  const spans: CharSpan[] = [];
  let fi = 0;
  let prevState: WordState = "upcoming";

  const push = (ch: string, state: WordState) => {
    const last = spans[spans.length - 1];
    if (last && last.state === state) {
      last.text += ch;
    } else {
      spans.push({ text: ch, state });
    }
  };

  for (const ch of text) {
    if (isWhitespace(ch)) {
      // Consume a matching whitespace fragment (if the provider emitted one)
      // but never highlight a space as "active".
      if (fi < fragChars.length && isWhitespace(fragChars[fi].ch)) fi++;
      push(ch, prevState === "active" ? "upcoming" : prevState);
      continue;
    }
    // Defensively skip any interleaved fragment whitespace before aligning.
    while (fi < fragChars.length && isWhitespace(fragChars[fi].ch)) fi++;
    if (fi < fragChars.length) {
      prevState = fragChars[fi].state;
      push(ch, fragChars[fi].state);
      fi++;
    } else {
      push(ch, "upcoming");
    }
  }

  return spans;
}