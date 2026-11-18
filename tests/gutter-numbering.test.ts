import { test } from "node:test";
import assert from "node:assert/strict";
import { codeComposition, codeLineText } from "../src/lib/codeview.ts";
import { composeLayout, trackSeed } from "../src/lib/compose.ts";
import type { LyricLine } from "../src/types.ts";

const mk = (text: string, i: number): LyricLine => ({
  startMs: i * 1000,
  endMs: (i + 1) * 1000,
  text,
  words: [],
});

const LYRICS: LyricLine[] = [
  "the superficial love",
  "fine at first",
  "but i want more",
  "i wanna know",
  "that you see",
  "cause i want",
  "authentic not just for fun",
  "",
  "and i will stay",
  "hold on",
].map(mk);

const rows = (active: number, seed: number) => {
  const layout = composeLayout(LYRICS, seed);
  return codeComposition(LYRICS, active, 999_999, LYRICS.length, layout);
};

/** Gutter numbers exactly as the overlay prints them. */
const gutter = (active: number, seed: number) => rows(active, seed).map((r) => r.index + 1);

test("gutter numbers are strictly sequential with no gaps or duplicates", () => {
  for (let seed = 0; seed < 60; seed++) {
    for (const active of [0, 3, LYRICS.length - 1]) {
      const nums = gutter(active, seed);
      // Continuous run starting at the first visible row's own number.
      assert.deepEqual(
        nums,
        nums.map((_, i) => nums[0] + i),
        `seed ${seed}, active ${active}: [${nums.join(",")}]`,
      );
      assert.equal(new Set(nums).size, nums.length, "duplicate number");
    }
  }
});

test("a scroll-back window continues the file's numbering", () => {
  // The overlay only renders a slice of history. Each window must resume at the
  // absolute row number it follows, otherwise a nested block appears to restart
  // at 1 while its children keep counting from where the opener was.
  for (let seed = 0; seed < 60; seed++) {
    const layout = composeLayout(LYRICS, seed);
    const full = codeComposition(LYRICS, LYRICS.length - 1, 999_999, LYRICS.length, layout);
    const fullNums = full.map((r) => r.index + 1);
    for (const before of [0, 1, 2, 3, 5]) {
      const win = codeComposition(LYRICS, LYRICS.length - 1, 999_999, before, layout);
      const nums = win.map((r) => r.index + 1);
      // The window is the tail of the full composition...
      assert.deepEqual(nums, fullNums.slice(fullNums.length - nums.length), `seed ${seed}`);
      // ...and stays perfectly continuous within itself.
      assert.deepEqual(nums, nums.map((_, i) => nums[0] + i), `seed ${seed}, before ${before}`);
    }
  }
});

test("the active line's rows share one lyric index but distinct numbers", () => {
  // A lyric that opens a block renders `{` and its statement on separate rows.
  let checked = 0;
  for (let seed = 0; seed < 60; seed++) {
    const comp = rows(LYRICS.length - 1, seed);
    const activeIdx = LYRICS.length - 1;
    const activeRows = comp.filter((r) => r.lyricIndex === activeIdx);
    if (activeRows.length < 2) continue;
    checked++;
    const nums = activeRows.map((r) => r.index + 1);
    assert.equal(new Set(nums).size, nums.length, "duplicate number on one lyric");
    assert.deepEqual(nums, nums.map((_, i) => nums[0] + i), "active rows must be consecutive");
  }
  assert.ok(checked > 0, "fixture never produced a multi-row active lyric");
});

test("a block opener gets its own number", () => {
  let checked = 0;
  for (let seed = 0; seed < 60; seed++) {
    for (const r of rows(LYRICS.length - 1, seed)) {
      if (r.kind !== "open") continue;
      checked++;
      assert.match(codeLineText(r).trim(), /^[{\[]$/, "opener must be a lone delimiter");
      assert.ok(!codeLineText(r).includes("\n"), "opener must be its own row");
    }
  }
  assert.ok(checked > 0, "no block opener found; fixture invalid");
});

test("a block closer gets its own number", () => {
  let checked = 0;
  for (let seed = 0; seed < 60; seed++) {
    for (const r of rows(LYRICS.length - 1, seed)) {
      if (r.kind === "close") {
        checked++;
        assert.ok(!codeLineText(r).includes("\n"), "closer must be its own row");
        assert.match(codeLineText(r).trim(), /^[}\]]$/);
      }
    }
  }
  assert.ok(checked > 0, "no block closer found; fixture invalid");
});

test("nested statements are separate numbered rows, indented by one level", () => {
  let checked = 0;
  for (let seed = 0; seed < 60; seed++) {
    const comp = rows(LYRICS.length - 1, seed);
    for (let i = 0; i < comp.length; i++) {
      if (comp[i].kind !== "open") continue;
      // The row right after an opener is its first member.
      const member = comp[i + 1];
      assert.ok(member, "opener must be followed by a member");
      if (member.kind !== "statement") continue;
      checked++;
      assert.equal(member.depth, 1, "member of a block sits one level in");
      // And it carries its own, different number.
      assert.equal(member.index, comp[i].index + 1);
    }
  }
  assert.ok(checked > 0, "no nested member found; fixture invalid");
});

test("no row ever contains an embedded newline (flat, one row per number)", () => {
  for (let seed = 0; seed < 60; seed++) {
    for (const r of rows(LYRICS.length - 1, seed)) {
      assert.ok(
        !codeLineText(r).includes("\n"),
        `seed ${seed}: row ${r.index + 1} embeds a newline: ${JSON.stringify(codeLineText(r))}`,
      );
    }
  }
});

test("blank lyric lines still render a numbered row", () => {
  // A blank separator must occupy exactly one row, so the sequence stays whole.
  const blankIdx = LYRICS.findIndex((l) => !(l.text ?? "").trim());
  assert.ok(blankIdx >= 0);
  const comp = rows(LYRICS.length - 1, 0);
  const blanks = comp.filter((r) => r.lyricIndex === blankIdx);
  assert.equal(blanks.length, 1, "a blank line is exactly one row");
  assert.ok(blanks[0].tokens.length > 0, "blank row still renders content");
  assert.equal(blanks[0].totalChars, 0, "blank row carries no lyric characters");
});

test("every row maps to a real lyric line", () => {
  for (let seed = 0; seed < 30; seed++) {
    for (const r of rows(LYRICS.length - 1, seed)) {
      assert.ok(r.lyricIndex >= 0 && r.lyricIndex < LYRICS.length);
    }
  }
});

test("numbering is continuous while the active line advances", () => {
  const layout = composeLayout(LYRICS, 5);
  for (let active = 0; active < LYRICS.length; active++) {
    const comp = codeComposition(LYRICS, active, active * 1000, LYRICS.length, layout);
    const nums = comp.map((r) => r.index + 1);
    assert.deepEqual(nums, nums.map((_, i) => i + 1));
    // The last row belongs to the active lyric line.
    assert.equal(comp[comp.length - 1].lyricIndex, active);
  }
});

test("the app's own seed also produces continuous numbering", () => {
  const seed = trackSeed("Oceans & Engines", "NIKI", "Nicole");
  const nums = gutter(LYRICS.length - 1, seed);
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});
