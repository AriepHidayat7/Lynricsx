import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodeLine,
  codeLineRevealedText,
  codeLineText,
  type CodeLine,
} from "../src/lib/codeview.ts";
import type { LyricLine } from "../src/types.ts";

/**
 * Regression tests for the parenthesis / detached-syntax effect.
 *
 * A lyric line can contain "words" that are pure punctuation (`-`, `—`, `...`)
 * or a parenthetical aside (`(oh)`). Those used to be counted when choosing the
 * statement layout but produced little or no visible lyric text, so the writer's
 * punctuation was left stranded — `oh_baby.-;`, `wait_-`, `three("...");`.
 * These tests pin the invariant that the rendered expression is always balanced
 * against the words actually shown.
 */

const mk = (text: string, words?: string[], wordMs = 500): LyricLine => ({
  text,
  startMs: 0,
  endMs: 4000,
  words: (words ?? text.split(/\s+/)).map((w, i) => ({
    text: w,
    startMs: i * wordMs,
    endMs: (i + 1) * wordMs,
  })),
});

const render = (line: LyricLine, position: number): string =>
  codeLineRevealedText(buildCodeLine(line, 0, position, "active"));

/** Fully revealed text of a line. */
const complete = (line: LyricLine): string =>
  codeLineText(buildCodeLine(line, 0, 99999, "active"));

/** Balanced delimiters and no orphaned statement punctuation. */
function assertWellFormed(out: string, label: string, done = false) {
  // Parentheses and quotes only balance once the lyric is fully typed — while
  // the argument is still being revealed, `it("no` is correct.
  if (done) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    assert.equal(opens, closes, `${label}: unbalanced parentheses in ${JSON.stringify(out)}`);
    const quotes = (out.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `${label}: unbalanced quotes in ${JSON.stringify(out)}`);
  }
  assert.ok(!/_[.;]/.test(out), `${label}: orphaned separator in ${JSON.stringify(out)}`);
  assert.ok(!/\.[.;]/.test(out), `${label}: double member dot in ${JSON.stringify(out)}`);
}

describe("parenthesis effect: punctuation-only words", () => {
  it("drops a trailing bare hyphen instead of orphaning '.-;'", () => {
    const line = mk("oh baby -");
    for (const pos of [0, 700, 1200, 1800, 2600, 4000, 9999]) {
      const out = render(line, pos);
      assertWellFormed(out, `hyphen tail @${pos}`);
      assert.ok(!/\.-/.test(out), `stray hyphen dot at @${pos}: ${JSON.stringify(out)}`);
    }
    assert.equal(complete(line), "oh_baby;");
  });

  it("drops a mid-line hyphen without leaving 'wait_-'", () => {
    const line = mk("wait - for it now");
    for (const pos of [0, 600, 1200, 2400, 3600, 9999]) {
      const out = render(line, pos);
      assertWellFormed(out, `hyphen middle @${pos}`);
      assert.ok(
        !/_-/.test(out),
        `orphaned underscore before hyphen at @${pos}: ${JSON.stringify(out)}`
      );
    }
    assert.equal(complete(line), 'wait_for.it("now");');
  });

  it("never produces an empty argument list for an ellipsis word", () => {
    const line = mk("one two three ...");
    for (const pos of [0, 800, 1500, 2200, 3000, 9999]) {
      const out = render(line, pos);
      assertWellFormed(out, `ellipsis tail @${pos}`);
      assert.ok(!/\(""\)/.test(out), `empty call at @${pos}: ${JSON.stringify(out)}`);
    }
    assert.equal(complete(line), "one_two.three;");
  });

  it("treats an em dash like any other punctuation-only word", () => {
    const line = mk("x \u2014 y z w");
    for (const pos of [0, 700, 1400, 2800, 9999]) {
      assertWellFormed(render(line, pos), `em dash @${pos}`);
    }
    assert.equal(complete(line), 'x_y.z("w");');
  });

  it("keeps the lyric letters of a parenthetical aside", () => {
    const line = mk("hold on (yeah)");
    assert.equal(complete(line), "hold_on.yeah;");
    for (const pos of [0, 900, 1800, 3600, 9999]) {
      assertWellFormed(render(line, pos), `paren aside @${pos}`);
    }
  });

  it("counts a parenthetical aside as one word, matching its rendering", () => {
    const line = mk("a (b) c d");
    assert.equal(complete(line), 'a_b.c("d");');
  });

  it("keeps a mixed line balanced through the whole reveal", () => {
    const line = mk("i am (not) okay now");
    const seen: string[] = [];
    for (let pos = 0; pos <= 5000; pos += 250) {
      const out = render(line, pos);
      assertWellFormed(out, `mixed @${pos}`);
      seen.push(out);
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(
        seen[i].length >= seen[i - 1].length,
        `reveal shrank at step ${i}: ${JSON.stringify(seen[i - 1])} -> ${JSON.stringify(seen[i])}`
      );
    }
    assert.equal(seen[seen.length - 1], 'i_am.not("okay now");');
    assertWellFormed(seen[seen.length - 1], "mixed final", true);
  });
});

describe("parenthesis effect: reveal sequencing", () => {
  it("only reveals closing punctuation once the lyric is complete", () => {
    const line = mk("normal lyric here");
    const partial = render(line, 1200);
    assert.ok(!partial.endsWith(";"), `punctuation leaked early: ${JSON.stringify(partial)}`);
    assert.equal(render(line, 9999), "normal_lyric.here;");
  });

  it("opens the call wrapper only when an argument word is reached", () => {
    const line = mk("normal lyric here today");
    const early = render(line, 200);
    assert.ok(!early.includes("("), `call opened too early: ${JSON.stringify(early)}`);
    assert.equal(render(line, 9999), 'normal_lyric.here("today");');
  });

  it("keeps every line of a mixed window balanced", () => {
    const lines = [
      mk("oh baby -"),
      mk("wait - for it now"),
      mk("one two three ..."),
      mk("hold on (yeah)"),
    ];
    for (const line of lines) {
      assertWellFormed(complete(line), `window "${line.text}"`, true);
    }
  });

  it("keeps line-level sync (no word timings) balanced too", () => {
    const line: LyricLine = { text: "oh baby -", startMs: 0, endMs: 3000, words: [] };
    for (const pos of [0, 500, 1500, 2500, 5000]) {
      assertWellFormed(render(line, pos), `line sync @${pos}`);
    }
    assert.equal(complete(line), "oh_baby;");
  });

  it("preserves source ranges for the words that remain", () => {
    const line = mk("wait - for it now");
    const row: CodeLine = buildCodeLine(line, 0, 9999, "active");
    const lyricTokens = row.tokens.filter((t) => t.lyric);
    assert.ok(lyricTokens.length > 0);
    for (const t of lyricTokens) {
      assert.equal(typeof t.sourceStart, "number");
      assert.equal(typeof t.sourceEnd, "number");
      assert.ok(t.sourceEnd! > t.sourceStart!, "source range must be non-empty");
      assert.ok(t.sourceEnd! <= line.text.length, "source range must stay in bounds");
    }
    assert.ok(
      !lyricTokens.some((t) => t.text.trim() === "-"),
      "a bare hyphen must not become lyric text"
    );
  });

  it("keeps the reveal budget tied only to surviving lyric words", () => {
    const line = mk("wait - for it now");
    const row = buildCodeLine(line, 0, 9999, "active");
    const expected = row.tokens
      .filter((t) => t.lyric)
      .reduce((n, t) => n + t.text.length, 0);
    assert.equal(row.totalChars, expected, "totalChars must match visible lyric length");
    assert.equal(row.revealedChars, expected, "a complete line reveals all lyric chars");
  });

  it("never fabricates syntax for an all-punctuation line", () => {
    // A bar like `- - -` has no lyric content. It used to render `-_-.-;`
    // (and `_.("");` in the wild); it must now be a single blank row.
    for (const text of ["- - -", "...", "-", "_", "! ?"]) {
      for (const withWords of [true, false]) {
        const line: LyricLine = withWords
          ? mk(text)
          : { text, startMs: 0, endMs: 3000, words: [] };
        const out = complete(line);
        assert.equal(
          out,
          " ",
          `${JSON.stringify(text)} (${withWords ? "word" : "line"} sync) => ${JSON.stringify(out)}`
        );
        assert.ok(!/[()";.]/.test(out), "no statement punctuation for a contentless line");
      }
    }
  });

  it("keeps such a line blank throughout its reveal", () => {
    const line = mk("- - -");
    for (let pos = 0; pos <= 4000; pos += 250) {
      assert.equal(render(line, pos), " ", `@${pos}`);
    }
  });

  it("does not emit a member dot before the word it introduces begins", () => {
    // Word 0 and 1 typed, word 2 not started. Previously revealed `aaa_bbb.`,
    // leaving a dot attached to nothing — the detached fragment seen live.
    const line = mk("aaa bbb ccc");
    for (let pos = 0; pos <= 3000; pos += 100) {
      const out = render(line, pos);
      assert.ok(
        !out.endsWith("."),
        `trailing dot with no member at ${pos}ms: ${JSON.stringify(out)}`
      );
    }
    // The growth sequence must attach the dot to the third word.
    assert.equal(render(line, 600), "aaa");
    assert.equal(render(line, 1000), "aaa_bbb");
    assert.equal(render(line, 1500), "aaa_bbb.ccc;");
  });

  it("keeps a long-word line attached through its reveal", () => {
    const line = mk("liberationemie x y");
    for (let pos = 0; pos <= 3000; pos += 100) {
      const out = render(line, pos);
      assert.ok(!out.endsWith("_"), `floating separator at ${pos}ms: ${JSON.stringify(out)}`);
      assert.ok(!out.endsWith("."), `floating dot at ${pos}ms: ${JSON.stringify(out)}`);
    }
    assert.equal(render(line, 1000), "liberationemie_x");
    assert.equal(render(line, 1500), "liberationemie_x.y;");
  });

  it("never emits a call wrapper around an empty argument", () => {
    // Live capture from "Rock That Body" on the installed build:
    //   tk-str "space" (sung) | "(" | '"' | ");"
    // The old guard only inspected `tokens[idx+1]`, which for `(` is the `"`
    // (syntax), so it concluded "no lyric follows" and emitted `(");` with an
    // empty argument. The look-ahead must skip the whole syntax run.
    for (const text of [
      "i wanna dance i wanna dance",
      "space space space space",
      "rock that body right now yeah",
    ]) {
      const line = mk(text);
      for (let pos = 0; pos <= 8000; pos += 5) {
        const out = render(line, pos);
        assert.ok(
          !/\(\s*"\s*\);/.test(out),
          `empty call at ${pos}ms: ${JSON.stringify(out)}`
        );
        assert.ok(
          !out.endsWith('(");') && !out.endsWith('(")'),
          `wrapper closed with no argument at ${pos}ms: ${JSON.stringify(out)}`
        );
      }
    }
  });

  it("grows the call wrapper only with real argument text", () => {
    const line = mk("i wanna dance i wanna dance");
    // No wrapper until the argument starts.
    assert.equal(render(line, 1500), "i_wanna.dance");
    assert.equal(render(line, 2000), 'i_wanna.dance("i');
    assert.equal(render(line, 999_999), 'i_wanna.dance("i wanna dance");');
  });

  it("never renders a closing wrapper without its opener", () => {
    // The live bug: the overlay emitted `");` at the end of a partial line while
    // the opening `("` was still withheld, because closing syntax has no lyric
    // after it and was therefore not gated on the line being complete.
    // An unmatched OPENER (`lookin("f`) is the normal mid-typing state; an
    // unmatched CLOSER (`lookin");`) is the defect.
    const phrases = [
      "everywhere i'm lookin for the answer",
      "i can see your halo (halo) halo",
      "they didn't even put up a fight",
      "i wanna dance i wanna dance",
      "one two three",
      "a b c d e",
    ];
    for (const text of phrases) {
      const line = mk(text);
      for (let pos = 0; pos <= 8000; pos += 5) {
        const out = render(line, pos);
        const opens = (out.match(/\(/g) ?? []).length;
        const closes = (out.match(/\)/g) ?? []).length;
        assert.ok(
          closes <= opens,
          `orphan closer at ${pos}ms for ${JSON.stringify(text)}: ${JSON.stringify(out)}`
        );
        assert.ok(
          !out.startsWith('");') && !out.startsWith(');'),
          `stray closer at ${pos}ms: ${JSON.stringify(out)}`
        );
      }
    }
  });

  it("grows the opening wrapper with the argument text", () => {
    const line = mk("everywhere i'm lookin for the answer");
    // The opener appears once the argument starts, not only at completion.
    const at1750 = render(line, 1750);
    assert.ok(at1750.includes('("'), `opener missing mid-reveal: ${JSON.stringify(at1750)}`);
    assert.ok(!at1750.includes(")"), `closer leaked early: ${JSON.stringify(at1750)}`);
  });

  it("always renders the comment marker, even before any text", () => {
    const line = mk("a b c");
    const row = buildCodeLine(line, 0, 0, "active", { comment: true });
    assert.equal(codeLineRevealedText(row), "// ");
  });
});
