import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLyricsStatus,
  applyTrack,
  initialTerminalState,
  runBoot,
  trackKeyOf,
} from "../src/lib/terminal.ts";
import { activeLineIndex, interpolatePosition } from "../src/lib/sync.ts";
import type { LyricsStatusEvent, LyricLine, TrackSnapshot } from "../src/types.ts";

const track = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  hasSession: true,
  title: "Kenangan Terindah",
  artist: "SAMSONS",
  album: "Naluri Lelaki",
  sourceAppId: "Spotify.exe",
  sourceAppName: "Spotify",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 247_000,
  sampledAtMs: 0,
  seekSeq: 0,
  trackSeq: 0,
  ...over,
});

let NOW = 5_000_000;
const tick = () => (NOW += 1_000);

test("an already-playing session is picked up without any playback event", () => {
  // The worker publishes an initial snapshot at startup; the overlay applies it
  // directly. No pause/play or metadata event is involved.
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track({ positionMs: 80_665 }), "kenangan-terindah.samsons.lyrics.ts", tick());

  assert.equal(s.phase, "detecting");
  assert.ok(
    s.log.some((l) => l.text.startsWith("Reading metadata:")),
    "initial metadata must be read",
  );
  assert.ok(s.trackKey.length > 0, "track identity must be established");
});

test("the initial position is usable for synchronization immediately", () => {
  const initial = track({ positionMs: 80_665, sampledAtMs: 10_000 });
  assert.equal(interpolatePosition(initial, 10_000), 80_665);

  const lines: LyricLine[] = Array.from({ length: 25 }, (_, i) => ({
    startMs: i * 10_000,
    endMs: (i + 1) * 10_000,
    text: `line ${i}`,
  }));
  assert.equal(activeLineIndex(lines, 80_665), 8, "must resolve to the real line at 80.7s");
});

test("a paused session found at startup is still detected", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track({ playbackState: "paused", positionMs: 95_822 }), "f.lyrics.ts", tick());
  assert.equal(s.phase, "detecting");
  assert.ok(s.log.some((l) => l.text === "Execution suspended."));
});

test("track identity is stable so repeated startup snapshots do not retrigger", () => {
  const a = trackKeyOf(track());
  const b = trackKeyOf(track({ positionMs: 123_456 }));
  assert.equal(a, b, "position changes must not change identity");
  assert.notEqual(a, trackKeyOf(track({ title: "Other" })));
});

test("Spotify launched after Lynricsx is detected when its session appears", () => {
  // Startup with nothing playing.
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track({ hasSession: false, playbackState: "closed" }), "idle.lyrics.ts", tick());
  assert.equal(s.phase, "disconnected");

  // Later a real session appears (SessionsChanged / first poll).
  s = applyTrack(s, track({ positionMs: 4_000 }), "song.artist.lyrics.ts", tick());
  assert.equal(s.phase, "detecting");
  assert.ok(s.log.some((l) => l.text === "Initializing music session..."));
});

test("a temporary disconnection is reported and a reconnection recovers", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track(), "f.lyrics.ts", tick());

  // Spotify quits.
  s = applyTrack(s, track({ hasSession: false, playbackState: "closed" }), "idle.ts", tick());
  assert.equal(s.phase, "disconnected");
  assert.equal(s.trackKey, "");

  // Spotify comes back on the same track at a new position.
  s = applyTrack(s, track({ positionMs: 42_000 }), "f.lyrics.ts", tick());
  assert.equal(s.phase, "detecting");
  assert.ok(s.trackKey.length > 0, "identity restored after reconnection");
});

test("a stale lyric status for an old track cannot replace the current one", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track({ title: "New Song" }), "new.song.lyrics.ts", tick());

  const stale: LyricsStatusEvent = {
    state: "ready",
    message: "",
    synced: true,
    wordSynced: false,
    granularity: "",
    instrumental: false,
    source: "liriqo",
    lineCount: 40,
    trackKey: "old-song\u0000old-artist\u0000old-album",
  };
  assert.equal(applyLyricsStatus(s, stale, tick()), s, "stale result must be ignored");
});

test("a seek never triggers a new track detection", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track(), "f.lyrics.ts", tick());
  const key = s.trackKey;
  const sessionId = s.session?.id;
  assert.equal(sessionId, 1, "first track opens session 1");

  s = applyTrack(s, track({ seekSeq: 1, positionMs: 12_000 }), "f.lyrics.ts", tick());
  s = applyTrack(s, track({ seekSeq: 2, positionMs: 200_000 }), "f.lyrics.ts", tick());

  assert.equal(s.trackKey, key);
  // A seek must not open a new session.
  assert.equal(s.session?.id, sessionId, "a seek must not start a new session");
  assert.equal(s.session?.archived, 0, "a seek must not archive a session");
});

test("a seek message is emitted per real seek counter only", () => {
  let s = runBoot(initialTerminalState(), 1_000);
  s = applyTrack(s, track(), "f.lyrics.ts", tick());
  // Each real seek emits the position change plus its follow-up lines, so count
  // the position-change line specifically rather than every SEEK-tagged line.
  const seeks = () =>
    s.log.filter((l) => l.tag === "SEEK" && l.text.startsWith("Position changed:")).length;

  s = applyTrack(s, track({ seekSeq: 1, positionMs: 30_000 }), "f.lyrics.ts", tick());
  assert.equal(seeks(), 1);
  s = applyTrack(s, track({ seekSeq: 1, positionMs: 30_000 }), "f.lyrics.ts", tick());
  assert.equal(seeks(), 1);
  s = applyTrack(s, track({ seekSeq: 2, positionMs: 10_000 }), "f.lyrics.ts", tick());
  assert.equal(seeks(), 2);
});
