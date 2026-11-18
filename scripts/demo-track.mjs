// Demo lyric content for the README screenshots.
//
// ORIGINAL WORK. Every line below was written for this project to replace
// commercial lyrics in the published screenshots. It is not copied from or
// adapted from any existing song. The fictional track is:
//
//     Midnight Syntax
//     Lynricsx Demo
//
// This file is throwaway tooling used only by `scripts/capture-screenshots.mjs`.
// Nothing here ships in the application, and no demo path exists in production
// code: the capture script pushes these payloads into the running overlay via
// the same `media:track` / `lyrics:context` events the backend itself emits.
//
// Timing is synthetic but internally consistent: word timings tile each line,
// lines are contiguous, and `WPM` keeps the reveal a plausible speed.

export const DEMO_TITLE = "Midnight Syntax";
export const DEMO_ARTIST = "Lynricsx Demo";
export const DEMO_ALBUM = "Demo Sessions";
export const DEMO_FILE = "midnight-syntax.lynricsx-demo.lyrics.ts";

/** Milliseconds between the start of consecutive lines. */
const LINE_GAP = 3600;
const LINE_0 = 1200;

/**
 * Lyrics, one entry per line. Each line becomes one lyric line; words are
 * split on spaces and given sequential timings inside the line's window.
 */
const LYRICS = [
  "the cursor blinks inside a quiet room",
  "and every heartbeat compiles into light",
  "i trace the edges of a midnight syntax",
  "where nothing broken stays broken tonight",
  "let the lexer pull the seams apart",
  "let the parser find the shape of me",
  "i am a function that never quite returns",
  "still running softly in the dark",
  "and when the morning patches over everything",
  "i will still remember what the night compiled",
];

/** Words that end a clause get a longer share of the line's time. */
const PAUSE_WORDS = new Set(["room", "light", "syntax", "tonight", "apart", "me"]);

/** Builds `TimedWord` entries that exactly tile `[start, end)`. */
function timeWords(text, start, end) {
  const words = text.split(" ").filter(Boolean);
  const weights = words.map((w) => (PAUSE_WORDS.has(w.replace(/[^a-z]/gi, "")) ? 1.6 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  let cursor = start;
  return words.map((w, i) => {
    const dur = Math.round((weights[i] / total) * span);
    const wordStart = cursor;
    cursor += dur;
    return { startMs: wordStart, endMs: i === words.length - 1 ? end : cursor, text: w };
  });
}

/** The full lyric timeline, as the backend would send it. */
export function demoTimeline() {
  let at = LINE_0;
  return LYRICS.map((text, i) => {
    // Longer lines get proportionally more time so reading speed stays even.
    const dur = LINE_GAP - 400 + Math.min(text.length, 44) * 18;
    const startMs = at;
    const endMs = startMs + dur;
    at = endMs + 300;
    return { startMs, endMs, text, words: timeWords(text, startMs, endMs) };
  });
}

export function demoDurationMs() {
  const tl = demoTimeline();
  return tl[tl.length - 1].endMs + 1500;
}

/**
 * `LyricContext` payload. `source` mirrors what the real providers report so
 * the overlay's sync badge renders identically; it is set to "LiriQo" because
 * the demo carries native word timings, which is exactly LiriQo's capability.
 */
export function demoContext() {
  return {
    lines: demoTimeline(),
    synced: true,
    wordSynced: true,
    wordGranularity: "word",
    instrumental: false,
    source: "LiriQo",
    title: DEMO_TITLE,
    artist: DEMO_ARTIST,
    album: DEMO_ALBUM,
    durationMs: demoDurationMs(),
  };
}

/** `TrackSnapshot` payload for a paused demo session at `positionMs`. */
export function demoTrack(positionMs, sampledAtMs = Date.now()) {
  return {
    hasSession: true,
    title: DEMO_TITLE,
    artist: DEMO_ARTIST,
    album: DEMO_ALBUM,
    sourceAppId: "",
    sourceAppName: "Demo",
    playbackState: "paused",
    positionMs,
    durationMs: demoDurationMs(),
    sampledAtMs,
    seekSeq: 0,
    trackSeq: 1,
  };
}
