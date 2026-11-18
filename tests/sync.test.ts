import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeLineIndex,
  activeWordIndex,
  classifyLine,
  formatTime,
  interpolatePosition,
  wordProgress,
  wordState,
} from "../src/lib/sync.ts";
import type { LyricLine, TimedWord, TrackSnapshot } from "../src/types.ts";

const w = (text: string, startMs: number, endMs: number): TimedWord => ({
  text,
  startMs,
  endMs,
});

const line = (startMs: number, text = "line", words: TimedWord[] = []): LyricLine => ({
  startMs,
  endMs: -1,
  text,
  words,
});

// A realistic word-timed line: "we will rock you"
const karaokeLine = line(10_000, "we will rock you", [
  w("we ", 10_000, 10_400),
  w("will ", 10_400, 10_900),
  w("rock ", 10_900, 11_500),
  w("you", 11_500, 12_200),
]);

test("activeLineIndex follows the last line whose start <= position", () => {
  const lines = [line(0), line(10_000), line(20_000), line(30_000)];
  assert.equal(activeLineIndex(lines, 0), 0);
  assert.equal(activeLineIndex(lines, 9_999), 0);
  assert.equal(activeLineIndex(lines, 10_000), 1);
  assert.equal(activeLineIndex(lines, 19_999), 1);
  assert.equal(activeLineIndex(lines, 29_999), 2);
  assert.equal(activeLineIndex(lines, 999_000), 3);
});

test("activeLineIndex returns -1 for unsynced/empty lyrics", () => {
  assert.equal(activeLineIndex([], 5_000), -1);
  assert.equal(activeLineIndex([line(-1), line(-1)], 5_000), -1);
});

test("activeWordIndex resolves the word under the playhead", () => {
  const words = karaokeLine.words!;
  assert.equal(activeWordIndex(words, 9_000), -1); // before the line
  assert.equal(activeWordIndex(words, 10_000), 0);
  assert.equal(activeWordIndex(words, 10_399), 0);
  assert.equal(activeWordIndex(words, 10_400), 1);
  assert.equal(activeWordIndex(words, 11_500), 3);
  assert.equal(activeWordIndex(words, 99_000), 3); // last word holds
});

test("activeWordIndex returns -1 when a line has no word timing", () => {
  assert.equal(activeWordIndex([], 10_500), -1);
});

test("wordState classifies upcoming / active / sung", () => {
  const words = karaokeLine.words!;
  assert.equal(wordState(words[0], 9_500), "upcoming");
  assert.equal(wordState(words[0], 10_200), "active");
  assert.equal(wordState(words[0], 10_400), "sung");
  assert.equal(wordState(words[3], 11_700), "active");
});

test("wordProgress tracks real timestamps, never CSS duration", () => {
  const word = karaokeLine.words![1]; // 10400 -> 10900
  assert.equal(wordProgress(word, 10_400), 0);
  assert.equal(wordProgress(word, 10_650), 0.5);
  assert.equal(wordProgress(word, 10_900), 1);
  assert.equal(wordProgress(word, 20_000), 1); // clamped
  assert.equal(wordProgress(undefined, 10_000), 0);
});

test("formatTime renders m:ss", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65_000), "1:05");
  assert.equal(formatTime(605_000), "10:05");
  assert.equal(formatTime(-1), "0:00");
});

test("interpolatePosition extrapolates only while playing", () => {
  const base: TrackSnapshot = {
    hasSession: true,
    title: "t",
    artist: "a",
    album: "",
    sourceAppId: "",
    sourceAppName: "",
    playbackState: "playing",
    positionMs: 10_000,
    durationMs: 100_000,
    sampledAtMs: 1_000,
  };
  assert.equal(interpolatePosition(base, 3_500), 12_500);
  const paused = { ...base, playbackState: "paused" as const };
  assert.equal(interpolatePosition(paused, 99_000), 10_000);
  const clamped = { ...base, positionMs: 98_000 };
  assert.equal(interpolatePosition(clamped, 1_000_000), 100_000);
});

test("pause/resume: words freeze while paused and resume from the same word", () => {
  const words = karaokeLine.words!;
  const paused: TrackSnapshot = {
    hasSession: true,
    title: "t",
    artist: "a",
    album: "",
    sourceAppId: "",
    sourceAppName: "",
    playbackState: "paused",
    positionMs: 10_500,
    durationMs: 200_000,
    sampledAtMs: 1_000,
  };
  // Ten seconds of wall clock later the position has not moved.
  const frozen = interpolatePosition(paused, 11_000);
  assert.equal(frozen, 10_500);
  assert.equal(activeWordIndex(words, frozen), 1);

  // Resuming continues from the same reported position.
  const resumed: TrackSnapshot = { ...paused, playbackState: "playing", sampledAtMs: 50_000 };
  assert.equal(interpolatePosition(resumed, 50_500), 11_000);
  assert.equal(activeWordIndex(words, 11_000), 2);
});

test("seek: jumping forward/backward selects the correct line and word", () => {
  const lines = [line(0), karaokeLine, line(20_000)];
  const words = karaokeLine.words!;
  // Jump forward into the middle of the karaoke line.
  const seeked = 11_600;
  assert.equal(activeLineIndex(lines, 0), 0);
  assert.equal(activeLineIndex(lines, seeked), 1);
  assert.equal(activeWordIndex(words, seeked), 3);
  // Seek backwards before the line again.
  assert.equal(activeLineIndex(lines, 2_000), 0);
});

test("missing word timing falls back to line-level behaviour", () => {
  const plainLine = line(10_000, "no karaoke here");
  assert.equal(activeLineIndex([plainLine], 11_000), 0);
  assert.equal(activeWordIndex(plainLine.words ?? [], 11_000), -1);
  assert.equal(wordProgress(undefined, 11_000), 0);
});

// ---------------------------------------------------------------------------
// Natural text reconstruction for character / syllable / word sync.
// ---------------------------------------------------------------------------

const joined = (line: LyricLine, position: number) =>
  classifyLine(line, position)
    .map((s) => s.text)
    .join("");

test("character timing preserves natural spaces (no space fragments)", () => {
  const words: TimedWord[] = [
    "Aslongaswekeeptalking",
  ]
    .join("")
    .split("")
    .map((ch, i) => w(ch, i * 100, i * 100 + 100));

  const l: LyricLine = {
    startMs: 0,
    endMs: 10_000,
    text: "As long as we keep talking",
    words,
  };

  // The rendered string must equal the original line text exactly.
  assert.equal(joined(l, 500), "As long as we keep talking");
  // Never insert a space between characters.
  assert.ok(!joined(l, 500).includes("A s"));
  assert.ok(joined(l, 500).includes("As long"));
});

test("character highlighting follows playback timestamps", () => {
  const text = "As long as";
  const letters = text.replace(/\s/g, "");
  const words: TimedWord[] = letters
    .split("")
    .map((ch, i) => w(ch, i * 100, i * 100 + 100));

  const l: LyricLine = { startMs: 0, endMs: 10_000, text, words };

  // At 150ms the 2nd character ("s") is active.
  const active150 = classifyLine(l, 150)
    .filter((s) => s.state === "active")
    .map((s) => s.text);
  assert.deepEqual(active150, ["s"]);

  // At 450ms the 5th character ("n") is active.
  const active450 = classifyLine(l, 450)
    .filter((s) => s.state === "active")
    .map((s) => s.text);
  assert.deepEqual(active450, ["n"]);

  // Whitespace is never active.
  assert.ok(
    classifyLine(l, 450).every((s) => s.state !== "active" || !s.text.includes(" ")),
  );
});

test("punctuation and capitalization are preserved", () => {
  const text = "I'm, in the stars!";
  const letters = text.replace(/\s/g, "");
  const words: TimedWord[] = letters
    .split("")
    .map((ch, i) => w(ch, i * 100, i * 100 + 100));
  const l: LyricLine = { startMs: 0, endMs: 10_000, text, words };

  assert.equal(joined(l, 500), text);
  assert.ok(joined(l, 500).includes("I'm,"));
  assert.ok(joined(l, 500).includes("stars!"));
});

test("syllable timing does not introduce spaces inside words", () => {
  // Syllables "Ki"+"ni" must render as "Kini", not "Ki ni".
  const l: LyricLine = {
    startMs: 0,
    endMs: 10_000,
    text: "Kini ku harus",
    words: [w("Ki", 0, 500), w("ni", 500, 900), w("ku", 900, 1300), w("ha", 1300, 1700), w("rus", 1700, 2200)],
  };
  assert.equal(joined(l, 400), "Kini ku harus");
  assert.ok(joined(l, 400).includes("Kini"));
  assert.ok(!joined(l, 400).includes("Ki ni"));
});

test("word timing remains unchanged", () => {
  // Natural words carry no trailing spaces; spacing comes from line.text.
  const l: LyricLine = {
    startMs: 0,
    endMs: 10_000,
    text: "we will rock you",
    words: [w("we", 0, 400), w("will", 400, 900), w("rock", 900, 1500), w("you", 1500, 2200)],
  };
  assert.equal(joined(l, 200), "we will rock you");
});

test("missing timing data falls back to plain text", () => {
  const l: LyricLine = { startMs: 0, endMs: 10_000, text: "plain lyric line", words: [] };
  const spans = classifyLine(l, 0);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "plain lyric line");
  assert.equal(spans[0].state, "upcoming");
});
