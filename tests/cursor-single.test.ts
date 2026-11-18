import { test } from "node:test";
import assert from "node:assert/strict";
import { codeComposition } from "../src/lib/codeview.ts";
import { composeLayout } from "../src/lib/compose.ts";
import type { LyricLine } from "../src/types.ts";

const line = (text: string, i: number): LyricLine => ({
  startMs: i * 1000,
  endMs: (i + 1) * 1000,
  text,
  words: [],
});

// A song that reliably produces blocks, arrays and comments.
const SONG: LyricLine[] = [
  "the superficial love",
  "fine at first",
  "but i want more than just what meets the eye",
  "i wanna know when you're looking at me",
  "that you see deep into my personality",
  "cause i want authentic not just for fun",
  "you been born to bleed",
  "little soldier",
  "with your magnet heart",
  "and sentimental boulder",
  "oh it pulled you down",
  "",
  "hold on tight",
  "and i will stay",
].map(line);

/** Mirrors the `cursorRow` selector in Overlay.tsx. */
function cursorRowOf(comp: ReturnType<typeof codeComposition>, activeIndex: number): number {
  if (comp.length === 0) return -1;
  const carry = comp.filter((cl) => cl.lyricIndex === activeIndex);
  const statement = carry.find((cl) => cl.kind === "statement");
  return (statement ?? carry[carry.length - 1] ?? comp[comp.length - 1]).index;
}

test("exactly one row owns the caret for every active line", () => {
  for (let seed = 0; seed < 40; seed++) {
    const layout = composeLayout(SONG, seed);
    for (let active = 0; active < SONG.length; active++) {
      const comp = codeComposition(SONG, active, active * 1000 + 500, SONG.length, layout);
      const owners = comp.filter((cl) => cl.index === cursorRowOf(comp, active));
      assert.equal(owners.length, 1, `seed ${seed} active ${active}: ${owners.length} caret rows`);
    }
  }
});

test("the caret row belongs to the lyric being sung", () => {
  for (let seed = 0; seed < 40; seed++) {
    const layout = composeLayout(SONG, seed);
    for (let active = 0; active < SONG.length; active++) {
      const comp = codeComposition(SONG, active, active * 1000 + 500, SONG.length, layout);
      const owner = comp.find((cl) => cl.index === cursorRowOf(comp, active));
      assert.equal(
        owner?.lyricIndex,
        active,
        `seed ${seed} active ${active}: caret landed on lyric ${owner?.lyricIndex}`,
      );
    }
  }
});

test("the caret prefers the statement row when a lyric has several rows", () => {
  // A lyric that opens a block renders `{` + statement (+ `}`). Only the
  // statement carries the typing frontier, so it must own the caret.
  let multiRow = 0;
  for (let seed = 0; seed < 40; seed++) {
    const layout = composeLayout(SONG, seed);
    for (let active = 0; active < SONG.length; active++) {
      const comp = codeComposition(SONG, active, active * 1000 + 500, SONG.length, layout);
      const carry = comp.filter((cl) => cl.lyricIndex === active);
      if (carry.length < 2) continue;
      multiRow++;
      const owner = comp.find((cl) => cl.index === cursorRowOf(comp, active));
      assert.equal(owner?.kind, "statement", `seed ${seed}: caret on '${owner?.kind}' row`);
    }
  }
  assert.ok(multiRow > 0, "fixture never produced a multi-row active lyric");
});

test("delimiter rows never own the caret", () => {
  for (let seed = 0; seed < 40; seed++) {
    const layout = composeLayout(SONG, seed);
    for (let active = 0; active < SONG.length; active++) {
      const comp = codeComposition(SONG, active, active * 1000 + 500, SONG.length, layout);
      const owner = comp.find((cl) => cl.index === cursorRowOf(comp, active));
      assert.notEqual(owner?.kind, "open", `seed ${seed}: caret on an opening delimiter`);
      assert.notEqual(owner?.kind, "close", `seed ${seed}: caret on a closing delimiter`);
    }
  }
});

test("numbering stays continuous and unique while the caret moves", () => {
  for (let seed = 0; seed < 40; seed++) {
    const layout = composeLayout(SONG, seed);
    for (let active = 0; active < SONG.length; active++) {
      const comp = codeComposition(SONG, active, active * 1000 + 500, SONG.length, layout);
      const nums = comp.map((c) => c.index);
      assert.deepEqual(nums, nums.map((_, i) => nums[0] + i), `seed ${seed} active ${active}`);
      assert.equal(new Set(nums).size, nums.length);
    }
  }
});

test("the caret owner advances by one line per lyric", () => {
  // Consecutive lyrics must not both claim the same row, which is what made two
  // cursors appear on adjacent lines during a transition.
  for (const seed of [0, 7, 77, 1000, 2024, 4242]) {
    const layout = composeLayout(SONG, seed);
    let prev = -1;
    for (let active = 0; active < SONG.length; active++) {
      const comp = codeComposition(SONG, active, active * 1000 + 500, SONG.length, layout);
      const row = cursorRowOf(comp, active);
      assert.ok(row > prev, `seed ${seed}: caret did not advance at lyric ${active}`);
      prev = row;
    }
  }
});
