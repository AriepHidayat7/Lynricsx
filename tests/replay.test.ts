import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REPLAY_MIN_GAP_MS,
  initialReplayState,
  replayAction,
  replayBounds,
  replaySurvivesTrackChange,
  type ReplayRange,
} from "../src/lib/replay.ts";
import type { LyricLine } from "../src/types.ts";

/**
 * Lyric replay is expressed purely in lyric timestamps and enforced through the
 * same seek path as click-to-seek, so it can never invent a second sync path.
 */

const LINES: LyricLine[] = [
  { text: "a", startMs: 0, endMs: 1000 },
  { text: "b", startMs: 1000, endMs: 2000 },
  { text: "c", startMs: 2000, endMs: 3000 },
  { text: "d", startMs: 3000, endMs: 4000 },
];

const range = (from: number, to: number, loop = false): ReplayRange => ({ from, to, loop });
const state = (r: ReplayRange | null) => ({ range: r });

describe("lyric replay: bounds", () => {
  it("uses the first line's start and the next line's start as the end", () => {
    assert.deepEqual(replayBounds(LINES, range(1, 2)), { startMs: 1000, endMs: 3000 });
  });

  it("falls back to the last line's end when there is no following line", () => {
    assert.deepEqual(replayBounds(LINES, range(2, 3)), { startMs: 2000, endMs: 4000 });
  });

  it("rejects a range whose boundary lines are unsynced", () => {
    const withGap: LyricLine[] = [
      { text: "a", startMs: 0, endMs: 1000 },
      { text: "x", startMs: -1, endMs: -1 },
    ];
    assert.equal(replayBounds(withGap, range(0, 1)), null);
  });

  it("rejects out-of-bounds ranges", () => {
    assert.equal(replayBounds(LINES, range(-1, 1)), null);
    assert.equal(replayBounds(LINES, range(0, 99)), null);
  });
});

describe("lyric replay: loop control", () => {
  const NOW = 10_000;
  const past = NOW - (REPLAY_MIN_GAP_MS + 1);

  it("pulls playback back when it sits before the section", () => {
    const res = replayAction(LINES, state(range(2, 3)), 1200, NOW, past);
    assert.deepEqual(res, { seekTo: 2000, ended: false });
  });

  it("does nothing while inside the section", () => {
    const res = replayAction(LINES, state(range(1, 2)), 2500, NOW, past);
    assert.deepEqual(res, { seekTo: null, ended: false });
  });

  it("loops back to the start when looping and past the end", () => {
    const res = replayAction(LINES, state(range(1, 2, true)), 5000, NOW, past);
    assert.deepEqual(res, { seekTo: 1000, ended: false });
  });

  it("ends the replay when not looping and past the end", () => {
    const res = replayAction(LINES, state(range(1, 2, false)), 5000, NOW, past);
    assert.deepEqual(res, { seekTo: null, ended: true });
  });

  it("does nothing when no replay is active", () => {
    const res = replayAction(LINES, initialReplayState(), 5000, NOW, past);
    assert.deepEqual(res, { seekTo: null, ended: false });
  });

  it("rate-limits seeks so a catching-up player is not spammed", () => {
    const recent = NOW - 10;
    const res = replayAction(LINES, state(range(2, 3, true)), 9000, NOW, recent);
    assert.deepEqual(res, { seekTo: null, ended: false });
  });

  it("ends the replay if the range becomes unusable", () => {
    const res = replayAction(LINES, state(range(5, 9)), 0, NOW, past);
    assert.deepEqual(res, { seekTo: null, ended: true });
  });
});

describe("lyric replay: track changes", () => {
  it("drops an active replay when the track changes", () => {
    const active = { range: range(1, 2, true) };
    assert.deepEqual(replaySurvivesTrackChange(active, "song-a", "song-b"), {
      range: null,
    });
  });

  it("keeps the replay for the same track", () => {
    const active = { range: range(1, 2, true) };
    assert.equal(replaySurvivesTrackChange(active, "song-a", "song-a"), active);
  });
});
