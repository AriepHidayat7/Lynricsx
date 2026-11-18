import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodeLine, codeComposition, codeLineRevealedText } from "../src/lib/codeview.ts";
import { composeLayout } from "../src/lib/compose.ts";
import type { LyricLine, TimedWord } from "../src/types.ts";

/**
 * Mirrors the emission rule in `CodeFragment` (Overlay.tsx).
 *
 * Written to follow `codeLineRevealedText` line for line, but keeping partial
 * lyric tokens so the caret's position can be observed. The two must agree;
 * the tests below assert that on every phrase and position.
 */
function renderedText(line: ReturnType<typeof buildCodeLine>, typewriter = true): string {
  let budget = typewriter ? line.revealedChars : line.wholeWordChars;
  let out = "";
  let wordDone = true;
  let lastWord: number | undefined;
  let typedInWord = 0;
  let wordLen = 0;
  let lastRunEnd = 0;
  let leading = true;
  tokens: for (let ti = 0; ti < line.tokens.length; ti++) {
    const tok = line.tokens[ti];
    if (tok.lyric) {
      leading = false;
      if (budget <= 0) break tokens;
      const take = Math.min(tok.text.length, budget);
      out += tok.text.slice(0, take);
      budget -= take;
      if (tok.word !== lastWord) {
        typedInWord = take;
        wordLen = (tok.sourceEnd ?? 0) - (tok.sourceStart ?? 0);
        lastWord = tok.word;
        lastRunEnd = tok.sourceEnd ?? 0;
      } else {
        typedInWord += take;
        wordLen += (tok.sourceEnd ?? 0) - Math.max(tok.sourceStart ?? 0, lastRunEnd);
        lastRunEnd = tok.sourceEnd ?? 0;
      }
      wordDone = wordLen > 0 && typedInWord >= wordLen;
      continue;
    }
    // Indentation, block delimiters and the `//` prefix lead the line and are
    // editor chrome.
    if (tok.kind === "comment" || (tok.kind === "syntax" && leading)) {
      out += tok.text;
      continue;
    }
    // Any other separator waits for the word before it to be fully typed, and
    // for the lyric it introduces to have started (see `codeLineRevealedText`).
    // The look-ahead skips runs of syntax tokens so a `(`, `"` wrapper cannot be
    // emitted with an empty argument.
    let introducesLyric = false;
    for (let j = ti + 1; j < line.tokens.length; j++) {
      if (line.tokens[j].lyric) {
        introducesLyric = true;
        break;
      }
    }
    if (line.complete || (wordDone && (!introducesLyric || budget > 0))) {
      out += tok.text;
      continue;
    }
    break;
  }
  return out;
}

// Word timings carry their original trailing space, exactly as the providers
// emit them.
const words = (text: string, step = 400): TimedWord[] => {
  const parts = text.split(" ");
  return parts.map((t, i) => ({
    text: i < parts.length - 1 ? `${t} ` : t,
    startMs: i * step,
    endMs: (i + 1) * step,
  }));
};

const line = (text: string, w: TimedWord[] = []): LyricLine => ({
  startMs: 0,
  endMs: Math.max(4000, w.length * 400),
  text,
  words: w,
});

const PHRASES = [
  "lookin in all the wrong places",
  "you i'm nothing without you",
  "like an angel in a nightmare",
  "you opened up my eyes",
  "hold on",
  "breathe",
  "a b",
  "cause i want authentic not just for fun",
];

test("rendered output is always a prefix of the full expression", () => {
  // A frozen or jumping caret shows up as a non-prefix: the DOM would contain
  // characters out of order or skip ahead of the reveal frontier.
  for (const text of PHRASES) {
    const l = line(text, words(text));
    const full = renderedText(buildCodeLine(l, 0, 999_999, "prev"));
    for (let pos = 0; pos <= l.endMs + 500; pos += 50) {
      const shown = renderedText(buildCodeLine(l, 0, pos, "active"));
      assert.ok(full.startsWith(shown), `"${shown}" not a prefix of "${full}" at ${pos}ms`);
    }
  }
});

test("the reveal frontier is monotonic while a line plays", () => {
  // What the caret follows. If this ever decreases mid-line the cursor appears
  // to stall or jump backwards.
  for (const text of PHRASES) {
    const l = line(text, words(text));
    let last = -1;
    for (let pos = 0; pos <= l.endMs + 500; pos += 25) {
      const shown = renderedText(buildCodeLine(l, 0, pos, "active")).length;
      assert.ok(shown >= last, `reveal went backwards at ${pos}ms (${last} -> ${shown})`);
      last = shown;
    }
  }
});

test("the rendered text agrees with codeLineRevealedText at every position", () => {
  // The overlay must not invent its own reveal rule. If it does, the caret
  // (which follows the last emitted character) drifts away from the frontier
  // that the timestamps describe.
  for (const text of PHRASES) {
    const l = line(text, words(text));
    for (let pos = 0; pos <= l.endMs + 500; pos += 50) {
      const built = buildCodeLine(l, 0, pos, "active");
      assert.equal(
        renderedText(built),
        codeLineRevealedText(built),
        `diverged at ${pos}ms for "${text}"`,
      );
    }
  }
});

test("a completed line renders the whole lyric, and the caret sits where it ends", () => {
  for (const text of PHRASES) {
    const l = line(text, words(text));
    const done = buildCodeLine(l, 0, 999_999, "active");
    const shown = renderedText(done);
    // Every lyric word is present...
    for (const w of text.split(" ")) {
      assert.ok(shown.toLowerCase().includes(w.toLowerCase()), `"${w}" missing from "${shown}"`);
    }
    // ...and the caret lands at the end of what is shown, which is where the
    // DOM places it (budget is exhausted, so `cursorPlaced` is the last token).
    assert.ok(shown.length > 0);
    if (done.complete) {
      assert.ok(shown.endsWith(";"), `finished expression should end in ';': "${shown}"`);
    }
  }
});

test("nothing is revealed before the lyric starts", () => {
  for (const text of PHRASES) {
    const l = line(text, words(text));
    const shown = renderedText(buildCodeLine(l, 0, 0, "active"));
    assert.equal(shown, "", `leaked "${shown}" before singing began`);
  }
});

test("typewriter off still reveals whole words, never partial characters", () => {
  const text = "lookin in all the wrong places";
  const l = line(text, words(text));
  const full = renderedText(buildCodeLine(l, 0, 999_999, "prev"));
  for (let pos = 0; pos <= l.endMs + 500; pos += 50) {
    const shown = renderedText(buildCodeLine(l, 0, pos, "active"), false);
    assert.ok(full.startsWith(shown), `not a prefix at ${pos}ms`);
    // Whatever is shown must end at a word or punctuation boundary, never
    // halfway through a word.
    if (shown.length > 0 && shown.length < full.length) {
      const next = full[shown.length];
      const atBoundary = !/[a-z]/.test(next) || /[\s_.("]/.test(shown.slice(-1));
      assert.ok(atBoundary, `split a word at ${pos}ms: "${shown}" | "${next}"`);
    }
  }
});

test("every row of the active lyric is marked active, not just its statement", () => {
  // `isActive` is keyed on the lyric, so a block opener (`{`) and its closing
  // `}` carry the caret too. A row-based key left them without one.
  const S = Array.from({ length: 24 }, (_, i) => line(`line ${i} a b c d`, words("a b c d")));
  let multiRowLyrics = 0;
  for (let seed = 0; seed < 60; seed++) {
    const layout = composeLayout(S, seed);
    const active = 20;
    const comp = codeComposition(S, active, 0, 19, layout);
    const activeRows = comp.filter((r) => r.lyricIndex === active);
    assert.ok(activeRows.length >= 1, `active lyric ${active} missing from the window`);
    // Exactly one statement row carries the reveal frontier.
    assert.equal(
      activeRows.filter((r) => r.kind === "statement").length,
      1,
      "exactly one statement row per active lyric",
    );
    if (activeRows.length > 1) multiRowLyrics++;
    // Row numbers stay unique and continuous (the numbering fix must survive).
    const nums = comp.map((r) => r.index);
    assert.deepEqual(nums, nums.map((_, i) => nums[0] + i), `seed ${seed} numbering broke`);
  }
  assert.ok(multiRowLyrics > 0, "no multi-row active lyric was exercised");
});
