import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLineIndex, interpolatePosition } from "../src/lib/sync.ts";
import { buildCodeLine } from "../src/lib/codeview.ts";
import type { LyricLine, TimedWord, TrackSnapshot } from "../src/types.ts";

const w = (text: string, startMs: number, endMs: number): TimedWord => ({ text, startMs, endMs });

const line = (startMs: number, text: string, words: TimedWord[] = []): LyricLine => ({
  startMs,
  endMs: startMs + 4000,
  text,
  words,
});

// A 60-second song, one line every 10 s.
const song: LyricLine[] = Array.from({ length: 6 }, (_, i) =>
  line(i * 10_000, `line ${i}`),
);

const track = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  hasSession: true,
  title: "t",
  artist: "a",
  album: "",
  sourceAppId: "",
  sourceAppName: "Spotify",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 60_000,
  sampledAtMs: 0,
  ...over,
});

test("forward seek moves the active line immediately, without pause", () => {
  // Playing, sampled at 5 s. Jumping the reported position to 35 s must resolve
  // to line 3 on the very next read — no pause/resume involved.
  const seeked = track({ positionMs: 35_000, sampledAtMs: 1_000 });
  const pos = interpolatePosition(seeked, 1_000); // no time has elapsed yet
  assert.equal(pos, 35_000);
  assert.equal(activeLineIndex(song, pos), 3);
});

test("backward seek moves the active line immediately", () => {
  const seeked = track({ positionMs: 12_000, sampledAtMs: 1_000 });
  assert.equal(activeLineIndex(song, interpolatePosition(seeked, 1_000)), 1);
});

test("a seek while paused is honoured exactly", () => {
  const paused = track({ playbackState: "paused", positionMs: 42_000, sampledAtMs: 1_000 });
  // Time passing must not advance a paused track.
  assert.equal(interpolatePosition(paused, 9_999), 42_000);
  assert.equal(activeLineIndex(song, 42_000), 4);
});

test("seeking backwards recomputes the reveal instead of keeping the old one", () => {
  const timed = line(0, "one two three four", [
    w("one ", 0, 500),
    w("two ", 500, 1000),
    w("three ", 1000, 1500),
    w("four", 1500, 2000),
  ]);

  const late = buildCodeLine(timed, 0, 1800, "active");
  const rewound = buildCodeLine(timed, 0, 200, "active");
  // The reveal follows the new position rather than latching at the old value.
  assert.ok(rewound.revealedChars < late.revealedChars);
  assert.equal(buildCodeLine(timed, 0, 1800, "active").revealedChars, late.revealedChars);
});

test("interpolation never runs past the track duration after a forward seek", () => {
  const nearEnd = track({ positionMs: 59_500, sampledAtMs: 1_000 });
  assert.equal(interpolatePosition(nearEnd, 5_000), 60_000);
  assert.equal(activeLineIndex(song, 60_000), 5);
});

test("a new track's snapshot starts from its own position, not the old one", () => {
  // Track B begins at 0 even though track A was at 55 s.
  const b = track({ title: "other", positionMs: 0, sampledAtMs: 2_000 });
  assert.equal(interpolatePosition(b, 2_000), 0);
  assert.equal(activeLineIndex(song, 0), 0);
});

test("invalid or missing timing falls back safely after a seek", () => {
  const unsynced = [line(-1, "plain")];
  assert.equal(activeLineIndex(unsynced, 30_000), -1);
  assert.equal(activeLineIndex([], 30_000), -1);
});
