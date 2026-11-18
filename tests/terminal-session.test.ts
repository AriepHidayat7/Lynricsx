import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initialTerminalState,
  runBoot,
  applyTrack,
  formatMs,
  MAX_LOG_LINES,
} from "../src/lib/terminal.ts";
import type { TrackSnapshot } from "../src/types.ts";

/**
 * Live terminal session.
 *
 * One virtual session per track. Opening a session must be driven by a real
 * track-identity change only, so seeks, position updates and repeated metadata
 * polls cannot spam or reset it.
 */

let t = 1000;
const tick = () => (t += 10);

const track = (o: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  hasSession: true,
  title: "Song",
  artist: "Artist",
  album: "Album",
  sourceAppId: "Spotify.exe",
  sourceAppName: "Spotify",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 200_000,
  sampledAtMs: 0,
  seekSeq: 0,
  trackSeq: 0,
  ...o,
});

describe("terminal session lifecycle", () => {
  it("opens session 1 for the first track with real metadata", () => {
    const s = applyTrack(runBoot(initialTerminalState(), 1), track(), "f.ts", tick());
    assert.equal(s.session?.id, 1);
    assert.equal(s.session?.label, "Artist — Song");
    assert.equal(s.session?.archived, 0);
    const texts = s.log.map((l) => l.text);
    assert.ok(texts.some((x) => x.startsWith("Artist: Artist")));
    assert.ok(texts.some((x) => x.startsWith("Track: Song")));
  });

  it("opens a new session and archives the previous one on a track change", () => {
    let s = applyTrack(runBoot(initialTerminalState(), 1), track(), "a.ts", tick());
    s = applyTrack(s, track({ title: "Other" }), "b.ts", tick());
    assert.equal(s.session?.id, 2);
    assert.equal(s.session?.archived, 1);
    assert.equal(s.session?.label, "Artist — Other");
  });

  it("does not open a new session for repeated identical metadata", () => {
    let s = applyTrack(runBoot(initialTerminalState(), 1), track(), "f.ts", tick());
    const id = s.session?.id;
    for (let i = 0; i < 5; i++) {
      s = applyTrack(s, track({ positionMs: 1000 * i }), "f.ts", tick());
    }
    assert.equal(s.session?.id, id);
    assert.equal(s.session?.archived, 0);
  });

  it("logs a real seek with both timestamps", () => {
    let s = applyTrack(runBoot(initialTerminalState(), 1), track({ positionMs: 155_000 }), "f.ts", tick());
    s = applyTrack(s, track({ seekSeq: 1, positionMs: 42_000 }), "f.ts", tick());
    assert.ok(
      s.log.some((l) => l.text === "Position changed: 02:35 → 00:42"),
      "seek must report the real before/after positions"
    );
    assert.equal(s.session?.id, 1, "a seek must not open a session");
  });

  it("keeps the log bounded", () => {
    let s = applyTrack(runBoot(initialTerminalState(), 1), track(), "f.ts", tick());
    for (let i = 0; i < 40; i++) {
      s = applyTrack(s, track({ title: `T${i}` }), "f.ts", tick());
      assert.ok(s.log.length <= MAX_LOG_LINES, "log must stay bounded");
    }
  });

  it("closes the session when the media session disconnects", () => {
    let s = applyTrack(runBoot(initialTerminalState(), 1), track(), "f.ts", tick());
    s = applyTrack(s, track({ hasSession: false, title: "", artist: "" }), "f.ts", tick());
    assert.equal(s.phase, "disconnected");
    assert.equal(s.trackKey, "");
  });

  it("formats terminal clock values", () => {
    assert.equal(formatMs(0), "00:00");
    assert.equal(formatMs(42_000), "00:42");
    assert.equal(formatMs(155_000), "02:35");
    assert.equal(formatMs(-1), "--:--");
  });
});
