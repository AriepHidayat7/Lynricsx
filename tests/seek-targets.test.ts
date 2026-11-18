import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatClock,
  isSeekable,
  seekTargetForFraction,
  seekTargetForRow,
} from "../src/lib/seek.ts";
import type { LyricLine } from "../src/types.ts";

/**
 * Click-to-seek must resolve through the composition back to the ORIGINAL lyric
 * line, and must refuse to seek when a line has no usable timestamp. Timestamps
 * always come from the lyric data — never from a row's visual position.
 */

const line = (text: string, startMs: number, endMs = startMs + 1000): LyricLine => ({
  text,
  startMs,
  endMs,
});

const LINES: LyricLine[] = [
  line("first", 1000),
  line("second", 5000),
  line("third", 9000),
  { text: "unsynced", startMs: -1, endMs: -1 },
];

describe("click to seek: row resolution", () => {
  it("resolves a statement row to its lyric timestamp", () => {
    assert.deepEqual(seekTargetForRow({ lyricIndex: 1 }, LINES), {
      ms: 5000,
      lineIndex: 1,
    });
  });

  it("resolves every row of a nested block to the same lyric", () => {
    // A block renders `{`, the statement and `}` with distinct row indices but
    // one lyricIndex; all three must seek identically.
    const rows = [
      { lyricIndex: 2, index: 10 },
      { lyricIndex: 2, index: 11 },
      { lyricIndex: 2, index: 12 },
    ];
    const targets = rows.map((r) => seekTargetForRow(r, LINES));
    assert.deepEqual(
      targets.map((t) => t?.ms),
      [9000, 9000, 9000]
    );
    assert.ok(targets.every((t) => t?.lineIndex === 2));
  });

  it("seeks backwards and forwards from the same data", () => {
    const back = seekTargetForRow({ lyricIndex: 0 }, LINES);
    const fwd = seekTargetForRow({ lyricIndex: 2 }, LINES);
    assert.ok(back && fwd);
    assert.ok(back.ms < fwd.ms);
    // Neither value is derived from position: they are the lyrics' own starts.
    assert.equal(back.ms, LINES[0].startMs);
    assert.equal(fwd.ms, LINES[2].startMs);
  });

  it("refuses to seek a line without a valid timestamp", () => {
    assert.equal(seekTargetForRow({ lyricIndex: 3 }, LINES), null);
  });

  it("refuses out-of-range or missing rows", () => {
    assert.equal(seekTargetForRow({ lyricIndex: -1 }, LINES), null);
    assert.equal(seekTargetForRow({ lyricIndex: 99 }, LINES), null);
    assert.equal(seekTargetForRow(undefined, LINES), null);
    assert.equal(seekTargetForRow({ lyricIndex: 1.5 }, LINES), null);
  });

  it("treats negative and non-finite starts as unseekable", () => {
    assert.equal(isSeekable({ text: "x", startMs: -1, endMs: 0 }), false);
    assert.equal(isSeekable({ text: "x", startMs: NaN, endMs: 0 }), false);
    assert.equal(isSeekable({ text: "x", startMs: 0, endMs: 0 }), true);
    assert.equal(isSeekable(undefined), false);
  });
});

describe("mini progress indicator", () => {
  it("maps a fraction of the duration to a position", () => {
    assert.equal(seekTargetForFraction(0.5, 200_000), 100_000);
    assert.equal(seekTargetForFraction(0, 200_000), 0);
    assert.equal(seekTargetForFraction(1, 200_000), 200_000);
  });

  it("clamps fractions outside 0..1", () => {
    assert.equal(seekTargetForFraction(-0.5, 100_000), 0);
    assert.equal(seekTargetForFraction(1.5, 100_000), 100_000);
  });

  it("returns null when the duration is unknown", () => {
    assert.equal(seekTargetForFraction(0.5, 0), null);
    assert.equal(seekTargetForFraction(0.5, -1), null);
    assert.equal(seekTargetForFraction(NaN, 1000), null);
  });

  it("formats clocks for titles and terminal messages", () => {
    assert.equal(formatClock(0), "00:00");
    assert.equal(formatClock(42_000), "00:42");
    assert.equal(formatClock(155_000), "02:35");
    assert.equal(formatClock(-1), "--:--");
  });
});
