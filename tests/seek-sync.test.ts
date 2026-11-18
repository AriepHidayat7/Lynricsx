import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_RESOLUTION_MS,
  SEEK_FORWARD_SLACK_MS,
  activeLineIndex,
  activeWordIndex,
  classifyLine,
  clockStep,
  interpolatePosition,
  wordState,
} from "../src/lib/sync.ts";
import type { LyricLine, TimedWord, TrackSnapshot } from "../src/types.ts";

const w = (text: string, startMs: number, endMs: number): TimedWord => ({ text, startMs, endMs });

const line = (startMs: number, text: string, words: TimedWord[] = []): LyricLine => ({
  startMs,
  endMs: startMs + 10_000,
  text,
  words,
});

// A 60 s song: one line every 10 s.
const song: LyricLine[] = Array.from({ length: 6 }, (_, i) => line(i * 10_000, `line ${i}`));

const track = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  hasSession: true,
  title: "t",
  artist: "a",
  album: "",
  sourceAppId: "Spotify.exe",
  sourceAppName: "Spotify",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 60_000,
  sampledAtMs: 0,
  seekSeq: 0,
  trackSeq: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// Seek detection in the display clock
// ---------------------------------------------------------------------------

test("a backward jump is always treated as a seek", () => {
  const step = clockStep(30_000, 12_000);
  assert.equal(step.seek, true);
  assert.equal(step.update, true, "the position must be applied immediately");
  assert.equal(step.position, 12_000);
});

test("a small backward jump is still a seek, not throttled away", () => {
  // This is the regression: a <250 ms rewind previously failed the display
  // threshold and the lyrics stayed stuck.
  const step = clockStep(30_000, 29_900);
  assert.equal(step.seek, true);
  assert.equal(step.update, true);
});

test("a large forward jump is a seek", () => {
  const step = clockStep(10_000, 45_000);
  assert.equal(step.seek, true);
  assert.equal(step.update, true);
  assert.equal(step.position, 45_000);
});

test("normal playback progress is throttled, not flagged as a seek", () => {
  const small = clockStep(10_000, 10_100);
  assert.equal(small.seek, false);
  assert.equal(small.update, false, "below the display resolution");

  const normal = clockStep(10_000, 10_000 + CLOCK_RESOLUTION_MS);
  assert.equal(normal.seek, false);
  assert.equal(normal.update, true);
});

test("real Spotify coarse steps are not mistaken for seeks", () => {
  // Field observations: Spotify publishes ~4.5 s jumps on a ~4.5 s cadence.
  assert.equal(clockStep(77_546, 82_060).seek, false);
  assert.equal(clockStep(82_060, 86_568).seek, false);
  assert.equal(clockStep(86_568, 91_079).seek, false);
  assert.equal(clockStep(91_079, 95_586).seek, false);
});

test("a forward jump just inside the slack is playback, just outside is a seek", () => {
  assert.equal(clockStep(0, SEEK_FORWARD_SLACK_MS).seek, false);
  assert.equal(clockStep(0, SEEK_FORWARD_SLACK_MS + 1).seek, true);
});

test("a seek lands on the correct active line", () => {
  // Forward seek to 35 s -> line 3.
  const fwd = clockStep(5_000, 35_000);
  assert.equal(activeLineIndex(song, fwd.position), 3);

  // Backward seek to 12 s -> line 1.
  const back = clockStep(50_000, 12_000);
  assert.equal(activeLineIndex(song, back.position), 1);
});

test("interpolation anchors to the sample time so a seek is not absorbed", () => {
  // Sample taken at t=1000 reports 35 s. Read at t=1000 -> exactly 35 s.
  const seeked = track({ positionMs: 35_000, sampledAtMs: 1_000 });
  assert.equal(interpolatePosition(seeked, 1_000), 35_000);
  // A stale sample time would have overshot; the worker now stamps on publish.
  assert.equal(interpolatePosition(seeked, 1_500), 35_500);
});

test("interpolation never exceeds duration after a forward seek", () => {
  const nearEnd = track({ positionMs: 59_500, sampledAtMs: 1_000 });
  assert.equal(interpolatePosition(nearEnd, 9_000), 60_000);
});

// ---------------------------------------------------------------------------
// Reveal progress after seeking (word / syllable / character sync)
// ---------------------------------------------------------------------------

test("word sync recomputes sung/active/upcoming after a backward seek", () => {
  const words = [w("one ", 0, 500), w("two ", 500, 1000), w("three ", 1000, 1500)];
  const l = line(0, "one two three", words);

  // Before the seek we are on the last word.
  assert.equal(activeWordIndex(words, 1_400), 2);
  assert.equal(wordState(words[2], 1_400), "active");

  // After rewinding to 100 ms the first word is active again.
  const after = clockStep(1_400, 100);
  const idx = activeWordIndex(words, after.position);
  assert.equal(idx, 0);
  assert.equal(wordState(words[idx], after.position), "active");
  // Word 2 must be upcoming again, not "sung".
  assert.equal(wordState(words[2], after.position), "upcoming");
});

test("seeking within one line updates the reveal, not just the line", () => {
  const words = [w("hold ", 0, 400), w("on ", 400, 800), w("tight", 800, 1200)];
  const l = line(0, "hold on tight", words);

  // Both positions are inside line 0, so the active line is unchanged...
  assert.equal(activeLineIndex([l], 300), 0);
  assert.equal(activeLineIndex([l], 1_000), 0);

  // ...but the word classification inside the line differs.
  assert.equal(wordState(words[activeWordIndex(words, 300)], 300), "active");
  assert.equal(activeWordIndex(words, 300), 0);
  assert.equal(activeWordIndex(words, 1_000), 2);
});

test("character/syllable classifyLine follows a seek in both directions", () => {
  // A single word split into syllable fragments.
  const frags = [w("ba", 0, 200), w("ck", 200, 400), w("burn", 400, 800), w("er", 800, 1000)];
  const l = line(0, "backburner", frags);

  const at500 = classifyLine(l, 500);
  assert.equal(at500.map((s) => s.text).join(""), "backburner");

  const at100 = classifyLine(l, 100);
  assert.equal(at100.map((s) => s.text).join(""), "backburner");
  // Earlier fragments are sung later in the track, so the states differ.
  assert.notDeepEqual(
    at500.map((s) => s.state),
    at100.map((s) => s.state),
  );
  // Rewinding must not report future fragments as sung.
  const statesAt100 = at100.map((s) => s.state);
  assert.equal(statesAt100[statesAt100.length - 1], "upcoming");
});
