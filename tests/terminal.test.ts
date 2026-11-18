import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOT_LINES,
  MAX_LOG_LINES,
  applyLyricsStatus,
  applyTrack,
  initialTerminalState,
  pushLine,
  runBoot,
  trackKeyOf,
} from "../src/lib/terminal.ts";
import type { LyricsStatusEvent, TrackSnapshot } from "../src/types.ts";

const track = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  hasSession: true,
  title: "Backburner",
  artist: "NIKI",
  album: "Album",
  sourceAppId: "Spotify.exe",
  sourceAppName: "Spotify",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 200_000,
  sampledAtMs: 0,
  seekSeq: 0,
  trackSeq: 0,
  ...over,
});

const status = (over: Partial<LyricsStatusEvent> = {}): LyricsStatusEvent => ({
  state: "loading",
  message: "",
  synced: true,
  wordSynced: true,
  granularity: "word",
  instrumental: false,
  source: "liriqo",
  lineCount: 0,
  trackKey: trackKeyOf(track()),
  ...over,
});

const texts = (s: { log: { text: string }[] }) => s.log.map((l) => l.text);
const lastText = (s: { log: { text: string }[] }) => s.log[s.log.length - 1]?.text ?? "";
const countText = (s: { log: { text: string }[] }, t: string) =>
  s.log.filter((l) => l.text === t).length;

// Each simulated event happens on its own clock tick, like real backend events.
let NOW = 1_000_000;
const tick = () => (NOW += 1_000);

/** Applies one track snapshot at the next clock tick. */
const step = (
  s: ReturnType<typeof initialTerminalState>,
  t: TrackSnapshot,
  file = "f.lyrics.ts",
) => applyTrack(s, t, file, tick());

/** Applies one lyrics status at the next clock tick. */
const stage = (s: ReturnType<typeof initialTerminalState>, e: LyricsStatusEvent) =>
  applyLyricsStatus(s, e, tick());

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

test("boot emits INIT lines plus SUCCESS and the idle prompt", () => {
  const s = runBoot(initialTerminalState(), 1_000);
  assert.ok(s.booted);
  assert.equal(s.phase, "idle");
  assert.ok(BOOT_LINES.some((l) => l.tag === "INIT"));
  assert.equal(s.log[s.log.length - 2].tag, "SUCCESS");
  assert.match(lastText(s), /Waiting for media session/);
});

test("boot is deterministic and does not append twice", () => {
  const first = runBoot(initialTerminalState(), 1_000);
  const second = runBoot(first, 2_000);
  assert.equal(second.log.length, first.log.length);
});

test("boot does not block an already-playing track", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = step(s, track());
  assert.equal(s.phase, "detecting");
  assert.ok(texts(s).includes("Initializing music session..."));
});

test("the log is bounded", () => {
  let s = initialTerminalState();
  for (let i = 0; i < 100; i++) s = pushLine(s, "INFO", `message ${i}`, i * 1_000);
  assert.equal(s.log.length, MAX_LOG_LINES);
});

test("identical repeated messages are deduplicated within the window", () => {
  let s = initialTerminalState();
  s = pushLine(s, "INFO", "same", 1_000);
  s = pushLine(s, "INFO", "same", 1_050);
  s = pushLine(s, "INFO", "same", 1_100);
  assert.equal(s.log.length, 1, "polling repeats must not stack up");
  s = pushLine(s, "INFO", "same", 3_000);
  assert.equal(s.log.length, 2, "a later event with the same wording is recorded");
});

// ---------------------------------------------------------------------------
// Lyrics status -> terminal messages
// ---------------------------------------------------------------------------

test("cache hits report CACHE, not a network fetch", () => {
  const s = stage(initialTerminalState(), status({ state: "cache_hit" }));
  assert.deepEqual(texts(s), ["Restoring cached lyrics..."]);
});

test("provider queries name the provider actually being queried", () => {
  const liri = stage(initialTerminalState(), status({ state: "provider_query", source: "liriqo" }));
  assert.match(lastText(liri), /LiriQo/);

  const lrc = stage(initialTerminalState(), status({ state: "provider_query", source: "lrclib" }));
  assert.match(lastText(lrc), /LRCLIB/);
  assert.doesNotMatch(lastText(lrc), /LiriQo/, "only the queried provider is named");
});

test("a provider failure warns about that provider", () => {
  const s = stage(initialTerminalState(), status({ state: "provider_error", source: "lrclib" }));
  assert.equal(s.log[0].tag, "WARN");
  assert.match(s.log[0].text, /LRCLIB/);
});

test("ready moves through fetch/process/success/ready in order", () => {
  const s = stage(initialTerminalState(), status({ state: "ready", lineCount: 42 }));
  assert.deepEqual(
    s.log.map((l) => l.tag),
    ["FETCH", "PROCESS", "SUCCESS", "READY"],
  );
  assert.equal(s.phase, "ready");
});

test("not found and hard errors stay concise and non-technical", () => {
  const nf = stage(initialTerminalState(), status({ state: "not_found" }));
  assert.equal(nf.log[0].tag, "WARN");
  const err = stage(initialTerminalState(), status({ state: "error" }));
  assert.equal(err.log[0].tag, "ERROR");
  assert.doesNotMatch(err.log[0].text, /panic|unwrap|thread|0x/);
});

test("statuses for a previous track are ignored", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = step(s, track());
  const stale = status({ state: "ready", trackKey: "some-old-track" });
  assert.equal(stage(s, stale), s, "stale status must not modify state");
});

// ---------------------------------------------------------------------------
// Track events
// ---------------------------------------------------------------------------

test("a new track produces a detection sequence with its filename", () => {
  const s = step(runBoot(initialTerminalState(), 1_000), track(), "backburner.niki.lyrics.ts");
  assert.equal(s.phase, "detecting");
  assert.ok(texts(s).includes("Initializing music session..."));
  assert.ok(texts(s).some((t) => t.includes("backburner.niki.lyrics.ts")));
});

test("changing track closes the previous session first", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track(), "a.lyrics.ts");
  const seqBefore = s.seq;
  s = step(s, track({ title: "Other", artist: "Someone" }), "other.someone.lyrics.ts");
  // The transition is a real close-then-open pair: both messages are appended
  // (the bounded log keeps only the tail, so compare the sequence counter).
  assert.ok(s.seq > seqBefore, "the transition must append log entries");
  assert.ok(
    texts(s).includes("Releasing previous track context..."),
    `missing release message; log=${JSON.stringify(texts(s))}`,
  );
  assert.ok(s.log.some((l) => l.text.startsWith("Reading metadata:")));
});

test("duplicate metadata events do not duplicate detection", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track());
  const before = s.log.length;
  s = step(s, track());
  s = step(s, track({ positionMs: 5_000 }));
  s = step(s, track({ positionMs: 9_000 }));
  assert.equal(s.log.length, before, "position ticks must not log track events");
  assert.equal(countText(s, "Initializing music session..."), 1);
});

test("seeking does not trigger a track transition", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track());
  const key = s.trackKey;
  s = step(s, track({ seekSeq: 1, positionMs: 90_000 }));
  assert.equal(s.trackKey, key, "track identity must be unchanged");
  assert.equal(countText(s, "Initializing music session..."), 1);
  assert.equal(lastText(s), "Jumping to timestamp...");
});

test("seek direction is reported truthfully", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track({ positionMs: 60_000 }));
  s = step(s, track({ seekSeq: 1, positionMs: 120_000 }));
  assert.equal(lastText(s), "Jumping to timestamp...");
  s = step(s, track({ seekSeq: 2, positionMs: 15_000 }));
  assert.equal(lastText(s), "Restoring previous position...");
});

test("a seek message appears once per real seek counter", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track());
  // A real seek now logs the position change plus follow-up SYNC lines; count
  // the position-change line, which is emitted exactly once per counter bump.
  const seeks = () =>
    s.log.filter((l) => l.tag === "SEEK" && l.text.startsWith("Position changed:")).length;
  s = step(s, track({ seekSeq: 1 }));
  assert.equal(seeks(), 1);
  s = step(s, track({ seekSeq: 1 }));
  assert.equal(seeks(), 1, "same counter must not log again");
  s = step(s, track({ seekSeq: 2 }));
  assert.equal(seeks(), 2);
});

// ---------------------------------------------------------------------------
// Playback feedback
// ---------------------------------------------------------------------------

test("pause / resume produce distinct messages exactly once each", () => {
  // Start from a clean playing state so the first transitions are unambiguous.
  let s = step(runBoot(initialTerminalState(), 1_000), track({ playbackState: "playing" }));
  assert.equal(lastText(s).startsWith("Reading metadata:") || s.lastPlayback === "playing", true);

  s = step(s, track({ playbackState: "paused" }));
  assert.equal(lastText(s), "Execution suspended.");
  s = step(s, track({ playbackState: "paused" }));
  assert.equal(countText(s, "Execution suspended."), 1, "repeats must not stack");

  // Resuming after a pause says so.
  s = step(s, track({ playbackState: "playing" }));
  assert.equal(lastText(s), "Resuming session...");

  s = step(s, track({ playbackState: "paused" }));
  assert.equal(lastText(s), "Execution suspended.");
  s = step(s, track({ playbackState: "playing" }));
  assert.equal(lastText(s), "Resuming session...");
});

test("a track that starts already paused reports the paused state", () => {
  const s = step(runBoot(initialTerminalState(), 1_000), track({ playbackState: "paused" }));
  assert.equal(lastText(s), "Execution suspended.");
  assert.equal(s.lastPlayback, "paused");
});


test("disconnection is reported once and clears the current track", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track());
  s = step(s, track({ hasSession: false, playbackState: "closed" }));
  assert.equal(s.phase, "disconnected");
  assert.equal(s.trackKey, "");
  assert.equal(lastText(s), "Media session disconnected.");
  const n = s.log.length;
  s = step(s, track({ hasSession: false, playbackState: "closed" }));
  assert.equal(s.log.length, n);
});

test("stopped playback is reported", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track());
  s = step(s, track({ playbackState: "stopped" }));
  assert.equal(lastText(s), "Playback terminated.");
});

test("in-flight lyric loading is not overridden by playback ticks", () => {
  let s = step(runBoot(initialTerminalState(), 1_000), track());
  s = stage(s, status({ state: "provider_query", source: "liriqo" }));
  assert.equal(s.phase, "searching");
  s = step(s, track({ positionMs: 1_000 }));
  assert.equal(s.phase, "searching", "a playing tick must not downgrade the phase");
});




// --- Phase settlement ------------------------------------------------------
// Regression: a lyric load left over from the PREVIOUS track used to pin the
// phase to "processing" forever, which made the header's activity indicator
// pulse indefinitely on a track that had already finished loading.

test("a new track is not frozen by a late status from the previous track", () => {
  const first = track({ title: "First", artist: "A", trackSeq: 0 });
  const firstKey = trackKeyOf(first);
  let s = step(initialTerminalState(), first);
  s = stage(s, status({ state: "media_ready", trackKey: firstKey }));
  assert.equal(s.phase, "processing", `trackKey mismatch: ${s.trackKey} vs ${firstKey}`);

  // The user skips; the new track's snapshot arrives while the old load is still
  // resolving. That snapshot must be able to take back control of the phase.
  s = step(s, track({ title: "Second", artist: "B", trackSeq: 1 }));
  s = step(s, track({ title: "Second", artist: "B", trackSeq: 1, positionMs: 2_000, seekSeq: 1 }));

  // Then the stale status for the OLD track lands late.
  const after = stage(s, status({ state: "media_ready", trackKey: firstKey }));
  assert.notEqual(
    after.phase,
    "processing",
    "a late status from the previous track must not pin this track's phase",
  );
});

test("the new track's own status drives the phase again", () => {
  const second = track({ title: "Second", artist: "B", trackSeq: 1 });
  let s = step(initialTerminalState(), track({ title: "First", artist: "A" }));
  s = step(s, second);
  s = stage(s, status({ state: "provider_query", trackKey: trackKeyOf(second) }));
  assert.equal(s.phase, "searching");
  s = stage(s, status({ state: "ready", trackKey: trackKeyOf(second), lineCount: 12 }));
  assert.equal(s.phase, "ready");
});

test("this track's own in-flight load still wins over playback state", () => {
  const t = track({ title: "Backburner", artist: "NIKI" });
  let s = step(initialTerminalState(), t);
  s = stage(s, status({ state: "provider_query", trackKey: trackKeyOf(t) }));
  assert.equal(s.phase, "searching");
  // A position update for the same track must not clobber the in-flight phase.
  s = step(s, track({ title: "Backburner", artist: "NIKI", positionMs: 5_000, seekSeq: 1 }));
  assert.equal(s.phase, "searching", "same-track load keeps priority");
});

test("a ready status for this track restores the playing phase", () => {
  const t = track({ title: "Backburner", artist: "NIKI" });
  const key = trackKeyOf(t);
  let s = step(initialTerminalState(), t);
  s = stage(s, status({ state: "media_ready", trackKey: key }));
  assert.equal(s.phase, "processing");
  s = stage(s, status({ state: "ready", trackKey: key, lineCount: 40 }));
  assert.equal(s.phase, "ready");
  s = step(s, track({ title: "Backburner", artist: "NIKI", positionMs: 9_000 }));
  assert.equal(s.phase, "playing", "playback resumes control once loaded");
});
