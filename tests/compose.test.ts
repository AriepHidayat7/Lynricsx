// Tests for the automatic randomized lyric composition engine.
//
// The composition engine only chooses *formatting* (indentation, `{}`/`[]`
// blocks, `//` comments). Lyric words are never touched, so these tests focus on
// determinism, balance, and that no lyric content is lost or invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeLayout,
  mulberry32,
  pickStyle,
  trackSeed,
  type ComposeStyle,
} from "../src/lib/compose.ts";
import {
  buildCodeLine,
  codeLineLyricText,
  codeLineRevealedText,
  codeComposition,
} from "../src/lib/codeview.ts";
import type { LyricLine } from "../src/types.ts";

const line = (startMs: number, text: string): LyricLine => ({
  startMs,
  endMs: startMs + 4000,
  text,
  words: [],
});

const SONG = [
  "i guess i never mattered",
  "you are a backburner",
  "it's pathetic but at least",
  "we tried to make it work",
  "and now the summer's over",
  "i'm still waiting here",
  "for something that won't come",
  "so tell me what to do",
];

const song = (): LyricLine[] => SONG.map((t, i) => line(i * 4000, t));

const STYLES: ComposeStyle[] = ["flat", "nested", "comment", "hybrid"];

test("every lyric word survives composition, in order", () => {
  const lines = song();
  for (const style of STYLES) {
    const layout = composeLayout(lines, trackSeed("Song", "Artist"), style);
    assert.equal(layout.length, lines.length);
    const built = lines.map((l, i) => buildCodeLine(l, i, 0, "prev", layout[i]));
    built.forEach((cl, i) => {
      assert.equal(
        codeLineLyricText(cl),
        (lines[i].text ?? "").toLowerCase(),
        `style ${style} line ${i} changed the lyric words`,
      );
    });
  }
});

test("composition never introduces programming keywords", () => {
  const forbidden = [
    "function",
    "return",
    "const",
    "class",
    "while",
    "promise",
    "memories",
    "lyrics",
  ];
  const lines = song();
  for (const style of STYLES) {
    const layout = composeLayout(lines, 12345, style);
    const rendered = lines
      .map((l, i) => buildCodeLine(l, i, 0, "prev", layout[i]))
      .map((cl) => codeLineRevealedText(cl))
      .join(" ")
      .toLowerCase();
    for (const word of forbidden) {
      assert.ok(!rendered.includes(word), `invented keyword "${word}" in ${style}`);
    }
  }
});

test("style selection is deterministic for the same seed", () => {
  assert.deepEqual(composeLayout(song(), 4242), composeLayout(song(), 4242));
});

test("different tracks produce different compositions", () => {
  const a = composeLayout(song(), trackSeed("Backburner", "NIKI"));
  const b = composeLayout(song(), trackSeed("Dynamite", "BTS"));
  assert.notDeepEqual(a, b);
});

test("trackSeed is stable and case/space insensitive", () => {
  assert.equal(trackSeed("Backburner", "NIKI"), trackSeed("backburner", "niki"));
  assert.equal(trackSeed(" A ", "B"), trackSeed("a", "b"));
  assert.notEqual(trackSeed("A", "B"), trackSeed("A", "C"));
  assert.notEqual(trackSeed("A", "B", "X"), trackSeed("A", "B", "Y"));
});

test("mulberry32 is a deterministic stream in [0,1)", () => {
  const r1 = mulberry32(99);
  const r2 = mulberry32(99);
  for (let i = 0; i < 20; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test("pickStyle only ever returns one of the four styles", () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    assert.ok(STYLES.includes(pickStyle(rand)));
  }
});

test("nested style emits balanced brackets", () => {
  const lines = song();
  const layout = composeLayout(lines, 1000, "nested");
  const opens = layout.filter((l) => l.open).length;
  const closes = layout.filter((l) => l.close).length;
  assert.equal(opens, closes, "every opened block must be closed");
  assert.ok(opens > 0, "nested style should open at least one block");
  for (let i = 0; i < layout.length; i++) {
    const opener = layout[i].open;
    if (!opener) continue;
    const want = opener === "{" ? "}" : "]";
    const closer = layout.find((l, j) => j > i && l.close === want);
    assert.ok(closer, `unclosed ${opener} block opened at line ${i}`);
  }
});

test("comment style renders lines as comment tokens with //", () => {
  const lines = song().slice(0, 4);
  const layout = composeLayout(lines, 77, "comment");
  assert.ok(layout.some((l) => l.comment), "comment style should comment lines");

  lines.forEach((l, i) => {
    if (!layout[i].comment) return;
    const cl = buildCodeLine(l, i, 0, "prev", layout[i]);
    assert.equal(cl.comment, true);
    const text = codeLineRevealedText(cl);
    assert.ok(text.startsWith("// "), `expected a // prefix, got "${text}"`);
    const lyricToks = cl.tokens.filter((t) => t.lyric);
    assert.ok(lyricToks.length > 0);
    for (const t of lyricToks) {
      assert.equal(t.tok, "comment", "comment words must use the comment colour");
      assert.equal(t.kind, "comment");
    }
    // A comment never keeps statement punctuation or quotes.
    assert.ok(!text.includes("("), `statement punctuation in "${text}"`);
    assert.ok(!text.includes('"'), `quotes in comment "${text}"`);
  });
});

test("flat composition adds no comments or brackets", () => {
  for (const l of composeLayout(song(), 555, "flat")) {
    assert.equal(l.comment, false);
    assert.equal(l.open, undefined);
    assert.equal(l.close, undefined);
  }
});

test("hybrid composition mixes commented and plain lines", () => {
  const layout = composeLayout(song(), 2024, "hybrid");
  const commented = layout.filter((l) => l.comment).length;
  assert.ok(commented > 0, "hybrid should comment some lines");
  assert.ok(commented < layout.length, "hybrid should leave some lines as statements");
});

test("blank lyric lines are never commented or bracketed", () => {
  const lines = [line(0, "one"), line(4000, "   "), line(8000, "three")];
  for (const style of STYLES) {
    const layout = composeLayout(lines, 31, style);
    assert.equal(layout[1].comment, false, `${style} commented a blank line`);
    assert.equal(layout[1].open, undefined);
    assert.equal(layout[1].close, undefined);
  }
});

test("nesting depth stays bounded", () => {
  for (const seed of [1, 2, 3, 400, 99999]) {
    for (const l of composeLayout(song(), seed)) {
      assert.ok(l.depth >= 0 && l.depth <= 3, `depth ${l.depth} out of range`);
    }
  }
});

test("formatting does not alter lyric reveal progress", () => {
  const lines = song();
  for (const pos of [4200, 6000, 9000, 15_000]) {
    const plain = buildCodeLine(lines[1], 1, pos, "active");
    const decorated = buildCodeLine(lines[1], 1, pos, "active", {
      depth: 2,
      comment: false,
      open: "{",
    });
    assert.equal(decorated.revealedChars, plain.revealedChars);
    assert.equal(decorated.totalChars, plain.totalChars);
  }
});

test("upcoming lines are still excluded when a layout exists", () => {
  const lines = song();
  const layout = composeLayout(lines, 4242);
  const comp = codeComposition(lines, 2, 8500, 1, layout);
  // The composition holds rows, not lyric lines: with a layout each lyric can
  // flatten into more than one row, so the numbering is continuous from the
  // first visible row rather than restarting at 1 per lyric.
  assert.deepEqual(comp.map((c) => c.index), [1, 2]);
  const all = comp.map((c) => codeLineRevealedText(c)).join(" ");
  assert.ok(!all.includes("we tried to make it work"));
});

test("quoted arguments use natural spaces, never underscores", () => {
  const l = line(0, "You're not dreaming, don't stop");
  const cl = buildCodeLine(l, 0, 0, "prev");
  const text = codeLineRevealedText(cl);
  // The quoted tail is prose: `don't stop`, not `don't_stop`.
  assert.ok(text.includes('"don\'t stop"'), `quoted tail should keep spaces: "${text}"`);
  assert.ok(!text.includes("don't_stop"), "argument must not be underscore-joined");
  // Underscores appear only in the leading identifier `you're_not`.
  assert.ok(text.startsWith("you're_not."), `unexpected head: "${text}"`);
});

test("comment lines read as prose without statement punctuation", () => {
  const lines = SONG.slice(0, 2);
  const layout = composeLayout(lines, 77, "comment");
  lines.forEach((l, i) => {
    if (!layout[i].comment) return;
    const cl = buildCodeLine(l, i, 0, "prev", layout[i]);
    const text = codeLineRevealedText(cl);
    assert.ok(text.startsWith("// "), `comment should start with // : "${text}"`);
    assert.ok(!text.includes("(") && !text.includes('"') && !text.includes(";"),
      `comment keeps statement punctuation: "${text}"`);
    // Comments join words with spaces, matching a real code comment.
    const body = text.slice(3);
    assert.ok(!body.includes("_"), `comment body should use spaces not underscores: "${text}"`);
  });
});

test("a bracket never shares a line with a comment or a lyric word", () => {
  const lines = song();
  for (const seed of [1, 2, 3, 77, 1000, 2024, 4242, 99999]) {
    const layout = composeLayout(lines, seed);
    for (const entry of layout) {
      // Brackets and comments are mutually exclusive on one layout entry.
      if (entry.open || entry.close) {
        assert.equal(entry.comment, false, "brace + comment on the same line");
      }
    }
    // Each opener has a matching closer of the same kind.
    let depth = 0;
    const stack: string[] = [];
    for (const entry of layout) {
      if (entry.open) stack.push(entry.open);
      if (entry.close) {
        const opener = stack.pop();
        const want = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
        assert.equal(entry.close, want, "unbalanced bracket");
      }
    }
    assert.equal(stack.length, 0, "unclosed bracket remains");
  }
});

test("rendered code lines never emit a malformed identifier", () => {
  // A stray comma or period inside an identifier would read as a syntax error.
  const lines = song();
  const layout = composeLayout(lines, 4242);
  lines.forEach((l, i) => {
    const text = codeLineRevealedText(buildCodeLine(l, i, 0, "prev", layout[i]));
    // Inside a statement, `,` is only ever part of the quote-delimited prose.
    if (!text.includes('"')) {
      assert.ok(!text.includes(","), `unquoted comma in "${text}"`);
    }
  });
});

test("composed lines stay prefix-consistent while seeking", () => {
  const lines = song();
  const layout = composeLayout(lines, trackSeed("X", "Y"));
  for (const pos of [0, 5000, 16_500, 40_000, 1000]) {
    const comp = codeComposition(lines, 4, pos, 3, layout);
    comp.forEach((cl) => {
      // `index` is the rendered row number, which is not the lyric index once a
      // lyric flattens into several rows — use `lyricIndex` to rebuild the row.
      const full = codeLineRevealedText(
        buildCodeLine(lines[cl.lyricIndex], cl.lyricIndex, 999_999, "prev", layout[cl.lyricIndex]),
      );
      assert.ok(full.startsWith(codeLineRevealedText(cl)), `not a prefix at ${pos}ms`);
    });
  }
});
