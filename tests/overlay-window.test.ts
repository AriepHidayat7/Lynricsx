import { test } from "node:test";
import assert from "node:assert/strict";
import { codeComposition } from "../src/lib/codeview.ts";
import { completedLinesFor, MAX_HISTORY_LINES, MIN_HISTORY_LINES } from "../src/lib/history.ts";
import type { LyricLine } from "../src/types.ts";

const line = (i: number): LyricLine => ({
  startMs: i * 1000,
  endMs: (i + 1) * 1000,
  text: `line ${i}`,
  words: [],
});

const lines: LyricLine[] = Array.from({ length: 40 }, (_, i) => line(i));

/** Builds the window the overlay renders for a given history size. */
function windowFor(historyLines: number, activeIndex: number) {
  return codeComposition(lines, activeIndex, activeIndex * 1000 + 500, completedLinesFor(historyLines));
}

test("each history size yields exactly that many visible lines", () => {
  // The active line is index 25, so there is plenty of history behind it.
  for (const n of [1, 3, 6, 10, 20]) {
    const w = windowFor(n, 25);
    assert.equal(w.length, n, `${n} lines requested, got ${w.length}`);
  }
});

test("the active line is always the last visible line", () => {
  for (const n of [1, 5, 10, 20]) {
    const w = windowFor(n, 25);
    assert.equal(w[w.length - 1].lyricIndex, 25, `active line missing for n=${n}`);
  }
});

test("oldest lines are dropped once the limit is exceeded", () => {
  const ten = windowFor(10, 25);
  assert.equal(ten[0].lyricIndex, 16);
  assert.equal(ten[9].lyricIndex, 25);

  // Growing the window pulls older lines back in rather than duplicating.
  const twenty = windowFor(20, 25);
  assert.equal(twenty[0].lyricIndex, 6);
  assert.equal(twenty.length, 20);
});

test("no upcoming lines are ever revealed", () => {
  for (const n of [1, 3, 10, MAX_HISTORY_LINES]) {
    const w = windowFor(n, 25);
    for (const cl of w) {
      assert.ok(cl.lyricIndex <= 25, `upcoming line ${cl.lyricIndex} leaked (n=${n})`);
    }
  }
});

test("no duplicate lines in the window", () => {
  for (const n of [1, 3, 10, 20]) {
    const w = windowFor(n, 25);
    const idx = w.map((c) => c.lyricIndex);
    assert.equal(new Set(idx).size, idx.length, `duplicates for n=${n}`);
  }
});

test("early in the track the window is limited by available history", () => {
  // Active index 2: only lines 0..2 exist, so a 10-line window shows 3.
  const w = windowFor(10, 2);
  assert.deepEqual(w.map((c) => c.lyricIndex), [0, 1, 2]);
});

test("the smallest window shows only the active line", () => {
  const w = windowFor(MIN_HISTORY_LINES, 25);
  assert.equal(w.length, 1);
  assert.equal(w[0].lyricIndex, 25);
});
