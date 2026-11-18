import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodeLine,
  codeComposition,
  codeLineLyricText,
  codeLineRevealedText,
  codeLineText,
  pickSyntaxTheme,
  SYNTAX_THEMES,
} from "../src/lib/codeview.ts";
import { trackSeed } from "../src/lib/compose.ts";
import type { LyricLine, TimedWord } from "../src/types.ts";

const w = (text: string, startMs: number, endMs: number): TimedWord => ({
  text,
  startMs,
  endMs,
});

const line = (startMs: number, text: string, words: TimedWord[] = []): LyricLine => ({
  startMs,
  endMs: startMs + 4000,
  text,
  words,
});

/** Alphabetic runs of a string, lowercased, in order. */
const alpha = (s: string): string[] => s.toLowerCase().match(/[a-z]+/g) ?? [];

test("flat expressions keep natural readability", () => {
  const cases: [string, string][] = [
    // 4+ words: head + property are underscore-joined identifiers, the quoted
    // argument keeps real spaces so it reads like the original lyric.
    ["I keep dreaming of you tonight", 'i_keep.dreaming("of you tonight");'],
    ["You said that we were forever", 'you_said.that("we were forever");'],
    ["But morning took you away", 'but_morning.took("you away");'],
    // 1-3 words use no quotes at all.
    ["Stay here", "stay_here;"],
    ["I keep dreaming", "i_keep.dreaming;"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(codeLineText(buildCodeLine(line(0, text), 0, 0, "prev")), expected);
  }
});

test("formatted line keeps every alphabetic lyric word in order", () => {
  const text = "As long as we keep talking";
  const cl = buildCodeLine(line(0, text), 0, 0, "active");
  assert.deepEqual(alpha(codeLineText(cl)), alpha(text));
});

test("lyric text is recoverable with words separated by single spaces", () => {
  const cl = buildCodeLine(line(0, "Hold On Tight"), 0, 0, "active");
  assert.equal(codeLineLyricText(cl), "hold on tight");
});

test("short lines use the matching formatting layout", () => {
  assert.equal(codeLineText(buildCodeLine(line(0, "Breathe"), 0, 0, "prev")), "breathe;");
  assert.equal(codeLineText(buildCodeLine(line(0, "Hold on"), 0, 0, "prev")), "hold_on;");
  assert.equal(
    codeLineText(buildCodeLine(line(0, "Hold on tight"), 0, 0, "prev")),
    "hold_on.tight;",
  );
});

test("reveal fraction is driven by word timestamps", () => {
  const words = [
    w("one ", 0, 1000),
    w("two ", 1000, 2000),
    w("three ", 2000, 3000),
    w("four", 3000, 4000),
  ];
  const l = line(0, "one two three four", words);
  assert.equal(buildCodeLine(l, 0, -1, "active").reveal, 0);
  const mid = buildCodeLine(l, 0, 1500, "active").reveal;
  // "one" is finished and "two" is half typed: a partial, not whole-word, reveal.
  assert.ok(mid > 0 && mid < 6 / 15, `reveal should be partial, got ${mid}`);
  assert.equal(buildCodeLine(l, 0, 99_999, "active").reveal, 1);
});

test("inactive lines are fully revealed and add no extra words", () => {
  const l = line(0, "prev lyric", [w("prev ", 0, 500), w("lyric", 500, 900)]);
  const cl = buildCodeLine(l, 0, 0, "prev");
  assert.equal(cl.reveal, 1);
  assert.equal(codeLineText(cl), "prev_lyric;");
});

test("line-level sync without word timings still reveals progressively", () => {
  const l = line(1000, "plain synced line", []);
  assert.equal(buildCodeLine(l, 0, 1000, "active").reveal, 0);
  const mid = buildCodeLine(l, 0, 3000, "active").reveal;
  assert.ok(mid > 0 && mid < 1, `expected partial reveal, got ${mid}`);
  assert.equal(buildCodeLine(l, 0, 99_999, "active").reveal, 1);
});

test("composition keeps completed lines and hides upcoming ones", () => {
  const lines = ["one", "two", "three", "four", "five"].map((t, i) => line(i * 1000, t));
  const comp = codeComposition(lines, 2, 2500, 1);
  // Only the completed line and the active line are built.
  assert.deepEqual(
    comp.map((c) => c.lyricIndex),
    [1, 2],
  );
  // No future expression is ever returned.
  assert.ok(!comp.some((c) => c.lyricIndex > 2));
});

/**
 * Every lyric token must point back into `line.text`, so the rendered
 * expression stays traceable to the original lyric.
 */
test("lyric tokens map back to their source characters", () => {
  const text = "I keep dreaming of you tonight";
  const l = line(0, text);
  const cl = buildCodeLine(l, 0, 0, "active");

  const lyric = cl.tokens.filter((t) => t.kind === "lyric");
  assert.ok(lyric.length > 0);

  // Concatenating each token's source slice must rebuild the original lyric.
  const rebuilt = lyric
    .map((t) => text.slice(t.sourceStart, t.sourceEnd).toLowerCase())
    .join(" ");
  assert.equal(rebuilt, text.toLowerCase());
});

test("underscores map to the original inter-word spaces", () => {
  // Two-word line: the single space becomes one underscore.
  const two = buildCodeLine(line(0, "Hold on"), 0, 0, "active");
  const twoSpaces = two.tokens.filter((t) => t.kind === "space");
  assert.equal(twoSpaces.length, 1);
  assert.equal(twoSpaces[0].text, "_");

  // Four-word line: only the leading pair is underscore-joined; the quoted
  // argument keeps a natural space.
  const four = buildCodeLine(line(0, "a b c d"), 0, 0, "active");
  assert.equal(codeLineText(four), 'a_b.c("d");');
  assert.equal(four.tokens.filter((t) => t.kind === "space").length, 1);

  // A longer tail uses real spaces inside the quotes, not underscores.
  const five = buildCodeLine(line(0, "a b c d e"), 0, 0, "active");
  assert.equal(codeLineText(five), 'a_b.c("d e");');
  assert.ok(!codeLineText(five).includes("d_e"), "argument must not be underscored");
});

test("generated punctuation carries no fabricated lyric timing", () => {
  const cl = buildCodeLine(line(0, "But morning took you away"), 0, 0, "active");
  const syntax = cl.tokens.filter((t) => t.kind === "syntax");
  assert.ok(syntax.length > 0);
  // Every generated character is punctuation only — never an alphabetic word.
  for (const t of syntax) {
    assert.ok(!/[a-z0-9]/i.test(t.text), `unexpected word in syntax: ${t.text}`);
    assert.equal(t.timing, null);
  }
});

test("lyric tokens inherit the timings of their source words", () => {
  const words = [w("one ", 0, 500), w("two ", 500, 1000), w("three ", 1000, 1500), w("four", 1500, 2000)];
  const l = line(0, "one two three four", words);
  const cl = buildCodeLine(l, 0, 1200, "active");

  const timed = cl.tokens.filter((t) => t.kind === "lyric" && t.timing);
  assert.ok(timed.length > 0);

  // Every reported window must match one of the original word timestamps.
  const allowed = words.map((x) => `${x.startMs}-${x.endMs}`);
  for (const t of timed) {
    assert.ok(
      allowed.includes(`${t.timing!.startMs}-${t.timing!.endMs}`),
      `fabricated timing ${t.timing!.startMs}-${t.timing!.endMs}`,
    );
  }
});

test("line-level sync gives lyric tokens the line window, not a word window", () => {
  const l = line(1000, "plain synced line", []);
  const cl = buildCodeLine(l, 0, 1500, "active");
  const timed = cl.tokens.filter((t) => t.kind === "lyric");
  assert.ok(timed.length > 0);
  for (const t of timed) {
    assert.equal(t.timing!.startMs, 1000);
    assert.equal(t.timing!.endMs, 5000);
  }
});

test("revealed character count grows with word timings", () => {
  const words = [w("one ", 0, 500), w("two ", 500, 1000), w("three ", 1000, 1500), w("four", 1500, 2000)];
  const l = line(0, "one two three four", words);

  const before = buildCodeLine(l, 0, -1, "active");
  const atStart = buildCodeLine(l, 0, 0, "active");
  const end = buildCodeLine(l, 0, 99_999, "active");

  assert.equal(before.revealedChars, 0, "nothing typed before the first word");
  assert.equal(atStart.revealedChars, 0, "first frame reveals no letters yet");
  assert.equal(end.revealedChars, end.totalChars, "fully typed at the end");

  // Inside a single word the letters appear one by one (interpolation).
  // "two" spans 500..1000: no letter yet at 600, first at 700, then two, three.
  const at = (pos: number) => buildCodeLine(l, 0, pos, "active").revealedChars;
  assert.equal(at(600), 3, "active word contributes nothing before its first letter");
  assert.equal(at(700), 4, "first letter of the active word appears");
  assert.equal(at(850), 5, "letters accumulate inside the word");
  assert.equal(at(1000), 6, "whole word typed once its window ends");
  // Strictly increasing while the word is being typed.
  assert.ok(at(700) < at(850) && at(850) < at(1000));
});

test("non-typewriter reveal shows whole words, never a partial word", () => {
  const words = [w("one ", 0, 500), w("two ", 500, 1000), w("three ", 1000, 1500), w("four", 1500, 2000)];
  const l = line(0, "one two three four", words);
  const whole = (pos: number) => buildCodeLine(l, 0, pos, "active").wholeWordChars;

  // Before the first word nothing is shown.
  assert.equal(whole(-1), 0);
  // Inside the first word it counts as shown in full (3 letters; the trailing
  // space is formatting, not lyric text).
  assert.equal(whole(250), 3, "the word being sung is shown whole");
  // Second word in progress: "one" complete plus "two" in full.
  assert.equal(whole(750), 6, "finished word plus the in-progress word");
  // Once every word has been sung the whole expression is revealed.
  const end = buildCodeLine(l, 0, 99_999, "active");
  assert.equal(whole(99_999), end.totalChars);
});

test("non-typewriter reveal never lags behind the typewriter reveal", () => {
  const words = [w("hold ", 0, 500), w("on ", 500, 1000), w("tight", 1000, 1500)];
  const l = line(0, "hold on tight", words);
  for (const pos of [0, 100, 499, 600, 900, 1200, 1500, 5000]) {
    const cl = buildCodeLine(l, 0, pos, "active");
    assert.ok(
      cl.wholeWordChars >= cl.revealedChars,
      `pos ${pos}: ${cl.wholeWordChars} < ${cl.revealedChars}`,
    );
    assert.ok(cl.wholeWordChars <= cl.totalChars, `pos ${pos}: exceeded total`);
  }
});

test("completed lines are fully revealed in both reveal modes", () => {
  const l = line(0, "one two three", [w("one ", 0, 500), w("two ", 500, 1000), w("three", 1000, 1500)]);
  const prev = buildCodeLine(l, 0, 0, "prev");
  assert.equal(prev.revealedChars, prev.totalChars);
  assert.equal(prev.wholeWordChars, prev.totalChars);
});

test("pausing holds the reveal and resuming continues it", () => {
  const words = [w("hold ", 0, 500), w("on ", 500, 1000), w("tight", 1000, 1500)];
  const l = line(0, "hold on tight", words);

  // Paused playback keeps reporting the same position.
  const paused = buildCodeLine(l, 0, 700, "active").revealedChars;
  assert.equal(buildCodeLine(l, 0, 700, "active").revealedChars, paused);

  // Resuming advances the same clock further.
  assert.ok(buildCodeLine(l, 0, 1200, "active").revealedChars > paused);
});

test("seeking backward reduces the reveal, seeking forward advances it", () => {
  const words = [w("one ", 0, 500), w("two ", 500, 1000), w("three ", 1000, 1500), w("four", 1500, 2000)];
  const l = line(0, "one two three four", words);

  const late = buildCodeLine(l, 0, 1800, "active").revealedChars;
  const early = buildCodeLine(l, 0, 200, "active").revealedChars;
  assert.ok(early < late, "seeking backward rewinds the reveal");
  assert.equal(buildCodeLine(l, 0, 200, "active").revealedChars, early);
});

test("a new track resets the reveal of every line", () => {
  const oldTrack = [
    line(0, "one two three four", [w("one ", 0, 500), w("two ", 500, 1000), w("three ", 1000, 1500), w("four", 1500, 2000)]),
  ];
  const newTrack = [line(0, "brand new song line", [w("brand ", 0, 500), w("new ", 500, 1000), w("song ", 1000, 1500), w("line", 1500, 2000)])];

  assert.ok(buildCodeLine(oldTrack[0], 0, 1900, "active").revealedChars > 0);
  // At the very start of the new track nothing has been typed yet.
  const fresh = buildCodeLine(newTrack[0], 0, 0, "active");
  assert.equal(fresh.revealedChars, 0);
  assert.equal(codeLineRevealedText(fresh), "");
});

test("unicode lyrics survive the transformation and mapping", () => {
  const text = "Café déjà vu";
  const l = line(0, text);
  const cl = buildCodeLine(l, 0, 0, "prev");
  assert.equal(codeLineText(cl), 'café_déjà.vu;');
  assert.equal(codeLineLyricText(cl), text.toLowerCase());
});

test("contractions, apostrophes and meaningful punctuation are preserved in lowercase", () => {
  const l = line(0, "You're not dreaming, don't stop");
  assert.equal(
    codeLineText(buildCodeLine(l, 0, 0, "active")),
    `you're_not.dreaming("don't stop");`,
  );
});

// ---------------------------------------------------------------------------
// Progressive typewriter visibility. These assert what is actually rendered
// (the revealed text prefix), not CSS opacity.
// ---------------------------------------------------------------------------

/** A line whose words are each 1s long, starting at 0. */
const seqLine = (text: string) => {
  const words = text.split(" ");
  return line(
    0,
    text,
    words.map((t, i) => w(i === words.length - 1 ? t : `${t} `, i * 1000, (i + 1) * 1000)),
  );
};

test("an expression starts empty and reveals only its typed prefix", () => {
  const l = seqLine("I keep dreaming of you tonight");

  // Nothing rendered before the line begins.
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, -1, "active")), "");

  // The prefix grows; the full expression is NOT present early.
  const early = codeLineRevealedText(buildCodeLine(l, 0, 1500, "active"));
  assert.ok(early.startsWith("i_k"), `unexpected prefix "${early}"`);
  assert.ok(early.length < 6, `expected a short prefix, got "${early}"`);
  assert.ok(!early.includes("dreaming"), "future words must not be rendered");
  assert.ok(codeLineText(buildCodeLine(l, 0, 1500, "active")).length > early.length);

  // Mid-way through the third word.
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 2700, "active")), "i_keep.dream");
});

test("the revealed prefix is always a prefix of the full expression", () => {
  const l = seqLine("I keep dreaming of you tonight");
  const full = codeLineText(buildCodeLine(l, 0, 99_999, "active"));
  for (const pos of [-1, 0, 500, 1500, 2600, 4100, 5200, 9999]) {
    const shown = codeLineRevealedText(buildCodeLine(l, 0, pos, "active"));
    assert.ok(full.startsWith(shown), `"${shown}" is not a prefix at ${pos}ms`);
    assert.ok(shown.length <= full.length);
  }
});

test("upcoming expressions are never part of the composition", () => {
  const lines = ["a one", "b two", "c three", "d four", "e five"].map((t, i) =>
    line(i * 4000, t),
  );
  const comp = codeComposition(lines, 1, 4500, 3);
  // Only index 0 (completed) and 1 (active) are built.
  assert.deepEqual(comp.map((c) => c.lyricIndex), [0, 1]);
  const rendered = comp.map(codeLineText).join(" ").toLowerCase();
  for (const future of ["three", "four", "five"]) {
    assert.ok(!rendered.includes(future), `future lyric "${future}" leaked into the output`);
  }
});

test("completed expressions stay visible while the active one types", () => {
  const lines = ["first line", "second line"].map((t, i) => line(i * 4000, t));
  const comp = codeComposition(lines, 1, 4000, 3);
  assert.equal(comp.length, 2);
  assert.equal(comp[0].lyricIndex, 0);
  assert.equal(codeLineRevealedText(comp[0]), "first_line;", "completed expression is fully typed");
  assert.equal(codeLineRevealedText(comp[1]), "", "active line starts empty");

test("a future expression appears only once its timing arrives", () => {
  const lines = [line(0, "one two"), line(4000, "three four"), line(8000, "five six")];
  // Before index 1 starts, only line 0 exists.
  assert.deepEqual(codeComposition(lines, 0, 3500, 3).map((c) => c.lyricIndex), [0]);
  // The moment it becomes active it is included with nothing typed yet.
  const atBoundary = codeComposition(lines, 1, 4000, 3);
  assert.deepEqual(atBoundary.map((c) => c.lyricIndex), [0, 1]);
  assert.equal(codeLineRevealedText(atBoundary[1]), "");
});

test("formatting punctuation appears only when the frontier reaches it", () => {
  const l = seqLine("I keep dreaming of you tonight");
  // Before the first word ends there is no separator or dot yet.
  assert.ok(!codeLineRevealedText(buildCodeLine(l, 0, 500, "active")).includes("_"));
  // After "keep" completes, the underscore separator is typed.
  assert.ok(codeLineRevealedText(buildCodeLine(l, 0, 2050, "active")).includes("i_keep"));
  // The trailing call/quote/semicolon punctuation is absent until fully typed.
  const mid = codeLineRevealedText(buildCodeLine(l, 0, 3000, "active"));
  assert.ok(!mid.includes(")"), "closing punctuation must not be typed early");
  assert.ok(!mid.includes(";"), "semicolon must not be typed early");
  assert.ok(codeLineRevealedText(buildCodeLine(l, 0, 99_999, "active")).includes(");"));
});

test("reveal never inserts spaces between characters", () => {
  const l = seqLine("I keep dreaming of you tonight");
  for (const pos of [0, 800, 1500, 2600]) {
    const shown = codeLineRevealedText(buildCodeLine(l, 0, pos, "active"));
    assert.ok(!/[a-z] [a-z]/.test(shown), `artificial spacing in "${shown}"`);
  }
});

test("character-level timing reveals every character of the line in order", () => {
  const text = "abcde";
  const l = line(
    0,
    text,
    text.split("").map((ch, i) => w(ch, i * 100, (i + 1) * 100)),
  );
  // One word: the expression is `abcde;`.
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 100, "active")), "a");
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 300, "active")), "abc");
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 500, "active")), "abcde;");
});

test("syllable-level timing reveals syllables progressively", () => {
  const l = line(0, "Kini ku", [w("Ki", 0, 400), w("ni", 400, 800), w("ku", 800, 1200)]);
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 0, "active")), "");
  // Partially typed syllables stay a clean prefix of the expression.
  const mid = codeLineRevealedText(buildCodeLine(l, 0, 600, "active"));
  assert.ok("kini_ku;".startsWith(mid), `"${mid}" is not a prefix`);
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 1200, "active")), "kini_ku;");
});

test("line-level fallback types across the line's own window", () => {
  const l = line(1000, "one two three", []);
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 1000, "active")), "");
  const full = codeLineText(buildCodeLine(l, 0, 9999, "active"));
  const mid = codeLineRevealedText(buildCodeLine(l, 0, 3000, "active"));
  assert.ok(mid.length > 0 && mid.length < full.length, `expected partial typing, got "${mid}"`);
  assert.equal(codeLineRevealedText(buildCodeLine(l, 0, 9999, "active")), full);
});

});

test("visible history respects the configured limit", () => {
  const lines = Array.from({ length: 10 }, (_, i) => line(i * 1000, `line ${i}`));
  assert.equal(codeComposition(lines, 9, 9500, 2).length, 3);
  assert.deepEqual(codeComposition(lines, 9, 9500, 2).map((c) => c.lyricIndex), [7, 8, 9]);
  assert.equal(codeComposition(lines, 9, 9500, 0).length, 1);
});

test("ten-line history keeps the active line plus nine completed lines", () => {
  const lines = Array.from({ length: 20 }, (_, i) => line(i * 1000, `line ${i}`));
  const comp = codeComposition(lines, 15, 15_500, 9);
  assert.equal(comp.length, 10);
  assert.deepEqual(comp.map((c) => c.lyricIndex), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

  // Advancing one line rolls the oldest off, no duplicates.
  const next = codeComposition(lines, 16, 16_500, 9);
  assert.equal(next.length, 10);
  assert.deepEqual(next.map((c) => c.lyricIndex), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test("character-sync comments keep natural word spacing", () => {
  const text = "as long as we keep talking";
  // Character sync: one timed word per character (space glyphs included for
  // alignment), 50ms each.
  const chars = text.split("");
  const l = line(0, text, chars.map((ch, i) => w(ch, i * 50, (i + 1) * 50)));
  const layout = { depth: 0, comment: true };

  const full = codeLineRevealedText(buildCodeLine(l, 0, 99_999, "active", layout));
  assert.equal(full, "// as long as we keep talking");

  // Throughout the typewriter the comment must be a clean prefix of the complete
  // line — never "l o n g", never a run-on of single letters.
  for (const pos of [0, 100, 250, 400, 600, 799, 1000, 99_999]) {
    const shown = codeLineRevealedText(buildCodeLine(l, 0, pos, "active", layout));
    assert.ok(full.startsWith(shown), `"${shown}" is not a prefix of "${full}" at ${pos}ms`);
  }
});

test("comment prefix does not add spacing around reveal", () => {
  const text = "a b c";
  const l = line(0, text, ["a", " ", "b", " ", "c"].map((ch, i) => w(ch, i * 100, (i + 1) * 100)));
  const cl = buildCodeLine(l, 0, 0, "active", { comment: true });
  // Nothing typed yet: only the `// ` prefix should be present, with a single
  // trailing space and no extra gaps.
  assert.equal(codeLineRevealedText(cl), "// ");
});

test("two-character syllable fragments concatenate without spaces", () => {
  // The provider's natural text is "backburner"; timing units are 2-char
  // fragments. They must render as one continuous word.
  const l = line(0, "backburner", ["ba", "ck", "bu", "rn", "er"].map((t, i) => w(t, i * 100, (i + 1) * 100)));
  assert.equal(codeLineText(buildCodeLine(l, 0, 0, "prev")), "backburner;");
  const revealed = codeLineRevealedText(buildCodeLine(l, 0, 150, "active"));
  assert.ok("backburner;".startsWith(revealed), `"${revealed}" is not a clean prefix`);
});

test("syllable fragments keep natural word boundaries", () => {
  // Natural text has two words; fragments "you"+"ve" and "be"+"en" belong to
  // the contracted words "you've" and "been". Only the real word boundary keeps
  // a space/underscore; syllables within a word never do.
  const l = line(0, "you've been", ["you", "ve", "be", "en"].map((t, i) => w(t, i * 100, (i + 1) * 100)));
  assert.equal(codeLineText(buildCodeLine(l, 0, 0, "prev")), "you've_been;");
});

test("comment line renders syllable fragments as a continuous word", () => {
  const l = line(0, "backburner", ["ba", "ck", "bu", "rn", "er"].map((t, i) => w(t, i * 100, (i + 1) * 100)));
  const cl = buildCodeLine(l, 0, 99_999, "prev", { comment: true });

test("syntax palette selection is deterministic and stable", () => {
  const seed = trackSeed("Backburner", "NIKI");
  const a = pickSyntaxTheme(seed);
  // Selection is pure: it never depends on render count or playback position.
  for (let i = 0; i < 5; i++) {
    assert.equal(pickSyntaxTheme(seed).id, a.id);
  }
});

test("syntax palettes are well-formed and distinct", () => {
  const ids = new Set(SYNTAX_THEMES.map((t) => t.id));
  assert.equal(ids.size, SYNTAX_THEMES.length, "theme ids must be unique");
  for (const t of SYNTAX_THEMES) {
    assert.ok(t.id.length > 0 && t.label.length > 0);
    // Only valid CSS identifier characters, since it becomes `data-syntax`.
    assert.ok(/^[a-z0-9-]+$/.test(t.id), `bad data-syntax id: ${t.id}`);
  }
  assert.ok(SYNTAX_THEMES.length >= 4, "expect a variety of palettes");
});

test("different tracks can select different palettes", () => {
  const seeds = [
    trackSeed("Backburner", "NIKI"),
    trackSeed("Dynamite", "BTS"),
    trackSeed("December", "Neck Deep"),
    trackSeed("X", "Y"),
  ];
  const picked = new Set(seeds.map((s) => pickSyntaxTheme(s).id));
  assert.ok(picked.size > 1, "at least two tracks should differ in palette");
});

test("pickSyntaxTheme always returns a known theme", () => {
  for (const seed of [0, 1, 42, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    const t = pickSyntaxTheme(seed);
    assert.ok(SYNTAX_THEMES.includes(t), `seed ${seed} produced an unknown theme`);
  }
});

  assert.equal(codeLineRevealedText(cl), "// backburner");
});
