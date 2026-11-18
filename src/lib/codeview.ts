// Lyric to code visualization layer.
//
// Re-formats a lyric line so it reads like a line of code. The only characters
// added are formatting marks: underscores replace spaces, and periods,
// parentheses, quotation marks and semicolons structure the line. Every
// alphabetic character shown comes from the lyric line, in its original order.
//
// Timing (`line.words`) only drives highlight and reveal progress.

import type { LyricLine } from "../types.ts";
import { wordState, type WordState } from "./sync.ts";
import type { LineLayout } from "./compose.ts";

/** Syntax roles used for highlighting. */
export type Tok = "fn" | "punct" | "quote" | "str" | "ident" | "num" | "ws" | "comment";

/**
 * How a rendered token relates to the original lyric:
 * - `lyric`    – characters copied from `line.text`
 * - `space`    – an underscore replacing an original inter-word space
 * - `syntax`   – generated punctuation carrying no lyric timing
 * - `comment`  – the `//` prefix or the flat comment body
 */
export type TokenKind = "lyric" | "space" | "syntax" | "comment";

/** Time window inherited from the originating lyric word (or line). */
export interface TokenTiming {
  startMs: number;
  endMs: number;
}

export interface CodeToken {
  tok: Tok;
  text: string;
  /** Highlight state for lyric tokens; formatting tokens are "struct". */
  state: WordState | "struct";
  /** True when this token is lyric text (not formatting). */
  lyric: boolean;
  /** Index of the source lyric word for lyric tokens. */
  word?: number;
  kind: TokenKind;
  /** Character range copied from `line.text` (end exclusive). Lyric tokens only. */
  sourceStart?: number;
  sourceEnd?: number;
  /**
   * Timing of the originating lyric word / line. `null` for generated
   * punctuation, which must never receive a fabricated lyric timestamp.
   */
  timing?: TokenTiming | null;
}

export interface CodeLine {
  /**
   * Rendered row number, 0-based. The gutter prints `index + 1`. Advances once
   * per logical code row, so delimiter rows (`{`, `}`, `[`, `]`) get their own
   * number instead of sharing one with a nested statement.
   */
  index: number;
  /** Source lyric line this row came from (stable across flattening). */
  lyricIndex: number;
  tokens: CodeToken[];
  /** Fraction of lyric characters revealed, 0..1. */
  reveal: number;
  /** Number of rendered lyric characters revealed at this position. */
  revealedChars: number;
  /**
   * Reveal budget for the non-typewriter mode: whole words up to and including
   * the word currently being sung. Equals `revealedChars` for completed lines.
   */
  wholeWordChars: number;
  /** Total rendered lyric characters in the expression. */
  totalChars: number;
  /**
   * True once every lyric character is typed. Trailing generated punctuation
   * (closing quote / paren / semicolon) is rendered only when this is true.
   */
  complete: boolean;
  /** Indentation level chosen by the composition engine (0 = flush left). */
  depth: number;
  /** True when this line is rendered as a `//` comment. */
  comment: boolean;
  /**
   * What this logical line represents. Delimiter rows are pure structure and
   * carry no lyric characters; `statement` rows carry the lyric.
   *
   * A block is flattened into three kinds of logical line so that the opening
   * brace, every nested statement and the closing brace each get their own
   * gutter number:
   *
   *   open  → `{`
   *   statement → `  the_superficial.love;`
   *   close → `}`
   */
  kind: "open" | "close" | "statement";
}

/** Per-character highlight state plus the timing of its originating word. */
interface CharInfo {
  state: WordState;
  timing: TokenTiming | null;
}

interface WordSpan {
  start: number;
  end: number;
}

/** Formatting token. Carries no lyric text and no lyric timestamp. */
function fmt(text: string, tok: Tok = "punct"): CodeToken {
  return { tok, text, state: "struct", lyric: false, kind: "syntax", timing: null };
}

/** Words inside a quoted string keep natural spaces (`"you've been"`). */
function quoteSpace(): CodeToken {
  return { tok: "punct", text: " ", state: "struct", lyric: false, kind: "space", timing: null };
}

/**
 * Strips punctuation that cannot appear inside a code identifier, so a lyric
 * word like `worried,` never becomes the malformed `worried,`. The removed
 * characters are formatting, not lyric content: the word's letters, order and
 * timing are untouched.
 */
function identifierText(raw: string): string {
  return raw.replace(/[^\p{L}\p{N}'’_-]/gu, "");
}

/**
 * Words that produce at least one visible identifier character.
 *
 * A lyric line can contain "words" that are pure punctuation — `-`, `—`, `...`,
 * or a parenthetical aside written as `(oh)`. `identifierText` strips those to
 * nothing, so emitting them would leave a lyric token with no visible text while
 * the writer's punctuation (`.`, `(`, `"`, `;`) was still laid out around it.
 * The result was detached syntax such as `oh_baby.-;` or `one_two.three("...");`.
 *
 * Both the statement layout *and* the emitted tokens are derived from this list,
 * so the shape of the expression always matches the words actually rendered.
 * The span index is kept so timings and `sourceStart`/`sourceEnd` still refer to
 * the original lyric text.
 */
function renderableSpans(text: string, spans: WordSpan[]): WordSpan[] {
  // A word must carry at least one letter or digit to be lyric content. A bare
  // `-`, `_`, `...` or `—` is punctuation that `identifierText` would keep (or
  // strip) in a way that leaves the surrounding syntax unbalanced, so it is
  // excluded here rather than at the token level.
  const isLyricWord = (s: WordSpan) => /[\p{L}\p{N}]/u.test(text.slice(s.start, s.end));
  // When nothing is renderable the line has no lyric content at all (a bar of
  // `- - -`, a row of dots). Returning the original spans here used to fabricate
  // separators and a statement tail around nothing, which is what produced
  // `-_-.-;` and `_.("");`. An empty list lets the caller emit a single blank
  // row instead, so the gutter keeps its number without inventing syntax.
  return spans.filter(isLyricWord);
}

/** Underscore standing in for an original inter-word space. */
function space(): CodeToken {
  return { tok: "punct", text: "_", state: "struct", lyric: false, kind: "space", timing: null };
}

/** Whitespace-separated word spans of `text`, in order. */
function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Highlight state for every character of `line.text`, derived from the word
 * timings. Lines without word timings stay "upcoming".
 */
function charStates(line: LyricLine, position: number): CharInfo[] {
  const text = line.text ?? "";
  const infos: CharInfo[] = Array.from({ length: text.length }, () => ({
    state: "upcoming" as WordState,
    timing: null,
  }));
  const words = line.words ?? [];
  if (words.length === 0) return infos;

  // One shared timing object per word so characters of the same word match.
  const frag: { ch: string; st: WordState; timing: TokenTiming }[] = [];
  for (const w of words) {
    const st = wordState(w, position);
    const timing: TokenTiming = { startMs: w.startMs, endMs: w.endMs };
    for (const ch of w.text) frag.push({ ch, st, timing });
  }
  let fi = 0;
  let prev: WordState = "upcoming";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    while (fi < frag.length && /\s/.test(frag[fi].ch)) fi++;
    if (/\s/.test(ch)) {
      infos[i] = { state: prev === "active" ? "upcoming" : prev, timing: null };
      continue;
    }
    if (fi < frag.length) {
      prev = frag[fi].st;
      infos[i] = { state: frag[fi].st, timing: frag[fi].timing };
      fi++;
    }
  }
  return infos;
}

/** Lyric tokens for one word, split into runs of identical highlight state. */
function wordTokens(
  text: string,
  span: WordSpan,
  chars: CharInfo[],
  word: number,
  fallback: TokenTiming | null,
): CodeToken[] {
  const out: CodeToken[] = [];
  let i = span.start;
  while (i < span.end) {
    const { state: st, timing } = chars[i];
    let j = i + 1;
    while (j < span.end && chars[j].state === st && chars[j].timing === timing) j++;
    out.push({
      tok: "str",
      text: text.slice(i, j).toLowerCase(),
      state: st,
      lyric: true,
      word,
      kind: "lyric",
      sourceStart: i,
      sourceEnd: j,
      timing: timing ?? fallback,
    });
    i = j;
  }
  return out;
}

/**
 * Like `wordTokens`, but drops characters that cannot appear in an identifier
 * (commas, quotes, stray symbols). Timing and the source range are still taken
 * from the original word, so nothing about synchronization changes.
 */
function cleanWordTokens(
  text: string,
  span: WordSpan,
  chars: CharInfo[],
  word: number,
  fallback: TokenTiming | null,
): CodeToken[] {
  const out: CodeToken[] = [];
  let i = span.start;
  while (i < span.end) {
    const { state: st, timing } = chars[i];
    let j = i + 1;
    while (j < span.end && chars[j].state === st && chars[j].timing === timing) j++;
    const cleaned = identifierText(text.slice(i, j)).toLowerCase();
    if (cleaned) {
      out.push({
        tok: "str",
        text: cleaned,
        state: st,
        lyric: true,
        word,
        kind: "lyric",
        sourceStart: i,
        sourceEnd: j,
        timing: timing ?? fallback,
      });
    }
    i = j;
  }
  return out;
}

/**
 * Builds one code-formatted line for `line`. The statement layout depends on
 * word count:
 *   1 word    word;
 *   2 words   word_word;
 *   3 words   word_word.word;
 *   4+ words  word_word.word("word_word_...");
 *
 * `layout` comes from the composition engine and only controls wrapping:
 * indentation depth, whether the line is a `//` comment, and opening/closing
 * brackets. Decoration tokens are never lyric tokens, so they cannot consume
 * reveal budget or alter lyric timing.
 */
export function buildCodeLine(
  line: LyricLine,
  index: number,
  position: number,
  variant: "active" | "prev" | "next",
  layout?: LineLayout,
  kind: "open" | "close" | "statement" = "statement",
  lyricIndex: number = index,
): CodeLine {
  const depth = layout?.depth ?? 0;
  const isComment = layout?.comment ?? false;
  const text = line.text ?? "";
  const spans = renderableSpans(text, wordSpans(text));
  const chars = charStates(line, position);
  // Line-level sync (no word timings) gives lyric tokens the line's own window.
  const fallback: TokenTiming | null =
    line.words && line.words.length > 0
      ? null
      : line.startMs >= 0
        ? {
            startMs: line.startMs,
            endMs: line.endMs > line.startMs ? line.endMs : line.startMs + 4000,
          }
        : null;
  const tokens: CodeToken[] = [];

  // Decoration is always emitted, never counted as lyric, so the reveal budget
  // and every lyric timestamp stay exactly as before. Brackets occupy their own
  // visual line (`{` / `}` alone) so they can never form `{//` or `{word`.
  // Indentation uses non-breaking spaces so it survives layout without
  // affecting wrapping.
  const indentText = (d: number) => "\u00a0\u00a0".repeat(d);

  // A delimiter-only logical line (`{`, `}`, `[`, `]`). Emitted as its own row
  // so it receives its own gutter number, flush left like a code block.
  if (kind === "open" || kind === "close") {
    tokens.push(fmt(kind === "open" ? (layout?.open ?? "{") : (layout?.close ?? "}")));
    return {
      index,
      lyricIndex,
      tokens,
      reveal: 1,
      revealedChars: 0,
      wholeWordChars: 0,
      totalChars: 0,
      complete: true,
      depth: 0,
      comment: false,
      kind,
    };
  }

  // Lyric content indent: members of a block sit one level in.
  const lyricIndent = depth;
  if (lyricIndent > 0) {
    tokens.push({ ...fmt(indentText(lyricIndent)), tok: "ws" });
  }

  // Appends words [from, to) joined by `sep`.
  //
  // The separator is emitted lazily — only once a word actually produced tokens —
  // so a word whose identifier text is empty (already excluded by
  // `renderableSpans`, but defensively handled here too) cannot leave an orphaned
  // `_` or `.` behind, which is what produced `wait_-` and `oh_baby.-;`.
  const joinWords = (from: number, to: number, sep: () => CodeToken = space, clean = false) => {
    let emitted = false;
    for (let k = from; k < to; k++) {
      const wordTokensFor = clean
        ? cleanWordTokens(text, spans[k], chars, k, fallback)
        : wordTokens(text, spans[k], chars, k, fallback);
      if (wordTokensFor.length === 0) continue;
      if (emitted) tokens.push(sep());
      tokens.push(...wordTokensFor);
      emitted = true;
    }
  };

  const n = spans.length;
  // Whether any lyric character was actually emitted. Trailing statement
  // punctuation is only written when the expression it closes has content, so a
  // line whose words all reduced to nothing cannot render a bare `;` or `.-;`.
  const hasLyric = () => tokens.some((t) => t.lyric);
  if (n === 0) {
    // Blank lyric line (a separator in the original lyrics).
    //
    // Without this branch the line emitted *no tokens at all*, so its rendered
    // row had an empty text area and no lyric content — the gutter still
    // printed a number, but the row's body was blank, which is what made the
    // sequence look like it skipped numbers. Emit a single non-lyric blank so
    // the row keeps its height and the numbering reads continuously.
    tokens.push({ ...fmt(" "), tok: "ws" });
  } else if (n === 1) {
    joinWords(0, 1, space, true);
    if (hasLyric()) tokens.push(fmt(";"));
  } else if (n === 2) {
    joinWords(0, 2, space, true);
    if (hasLyric()) tokens.push(fmt(";"));
  } else if (n === 3) {
    joinWords(0, 2, space, true);
    if (hasLyric()) tokens.push(fmt("."));
    joinWords(2, 3, space, true);
    if (hasLyric()) tokens.push(fmt(";"));
  } else if (n >= 4) {
    // Head identifier and property stay underscore-joined; the quoted argument
    // keeps real spaces so the lyric reads naturally: `worried.but("you're dripping")`.
    joinWords(0, 2, space, true);
    if (hasLyric()) tokens.push(fmt("."));
    joinWords(2, 3, space, true);
    // The call wrapper is only written once a real argument exists, so an
    // unrenderable tail word can never produce an empty `("");`.
    if (hasLyric()) {
      tokens.push(fmt("("), fmt('"', "quote"));
      joinWords(3, n, quoteSpace, false);
      tokens.push(fmt('"', "quote"), fmt(");"));
    }
  }

  if (layout?.close) {
    // The closing delimiter is its own logical line (see `kind === "close"`),
    // so nothing is glued onto the end of this statement.
  }

  // A commented line keeps its words but is presented as `// word_word ...`.
  // The statement punctuation is dropped and every token is marked as comment
  // content, so the whole line renders in one neutral comment colour. Timing,
  // `sourceStart`/`sourceEnd` and the reveal budget are preserved because the
  // lyric tokens themselves are kept — only `tok`/`kind` change.
  if (isComment) {
    const kept: CodeToken[] = [];
    if (depth > 0) {
      kept.push({ ...fmt(indentText(depth)), tok: "ws" });
    }
    // A `//` comment never carries a brace on the same line.
    kept.push({
      tok: "comment",
      text: "// ",
      state: "struct",
      lyric: false,
      kind: "comment",
      timing: null,
    });
    let lastWord: number | undefined;
    let gap = false; // a word boundary is pending a single prose space
    for (const t of tokens) {
      if (t.tok === "ws" && t.kind === "syntax") {
        kept.push(t);
        continue;
      }
      if (t.lyric) {
        // Comments read as prose: exactly one space between words, never between
        // the character/syllable fragments of a single word. This is essential
        // for Character/Syllable sync, where one word is many `t.word`-equal
        // fragments (`l`, `o`, `n`, `g`) and must not become `l o n g`.
        if (gap && lastWord !== undefined && t.word !== lastWord) {
          kept.push({ ...quoteSpace(), tok: "comment" });
        }
        kept.push({ ...t, tok: "comment", kind: "comment" });
        lastWord = t.word;
        gap = true;
        continue;
      }
      if (t.kind === "space") {
        // An underscore / quoted-space token marks a genuine word boundary.
        gap = true;
        continue;
      }
      // Statement punctuation (`.` `(` `"` `;`) is dropped, but still marks a
      // word boundary so the next word joins with a single space.
      gap = true;
    }
    if (layout?.close) kept.push(fmt(layout.close));
    tokens.length = 0;
    tokens.push(...kept);
  }

  // Reveal from lyric character progress (timestamps only).
  const lyricChars = tokens.filter((t) => t.lyric);
  const total = lyricChars.reduce((sum, t) => sum + t.text.length, 0);

  // Characters fully typed: words whose timing has already ended.
  const sungCount = lyricChars
    .filter((t) => t.state === "sung")
    .reduce((sum, t) => sum + t.text.length, 0);

  // The in-progress word is revealed letter by letter between its own
  // startMs/endMs. This is playback-position interpolation inside the word —
  // a visual approximation, NOT native character-level timing.
  let activeCount = 0;
  for (const t of lyricChars) {
    if (t.state !== "active" || !t.timing) continue;
    const span = t.timing.endMs - t.timing.startMs;
    const frac = span > 0 ? (position - t.timing.startMs) / span : 1;
    const clamped = Math.min(1, Math.max(0, frac));
    activeCount += Math.floor(clamped * t.text.length);
  }

  let reveal = total > 0 ? (sungCount + activeCount) / total : 0;

  if (variant !== "active") {
    reveal = 1; // completed expressions are shown whole (CSS dims them)
  } else if (!line.words || line.words.length === 0) {
    // Line-level sync: reveal across the line's own timestamp window.
    const start = line.startMs;
    if (start < 0) {
      reveal = 1;
    } else {
      const end = line.endMs > start ? line.endMs : start + 4000;
      reveal = Math.min(1, Math.max(0, (position - start) / Math.max(1, end - start)));
    }
  }

  // Characters the typewriter should show. Word/syllable/character sync counts
  // finished words plus partial progress inside the active word; line-level sync
  // scales the fraction across the whole expression.
  const hasWords = !!line.words && line.words.length > 0;
  const wordRevealed =
    variant !== "active" || total === 0
      ? total
      : hasWords
        ? sungCount + activeCount
        : Math.floor(reveal * total);

  // True once every lyric character is typed: the trailing generated
  // punctuation (closing quote, paren, semicolon) is then part of the output.
  const complete = wordRevealed >= total;

  // Non-typewriter reveal: whole words, counted up to (and including) the word
  // currently being sung. Used when the typewriter setting is off, so a word
  // never appears before its own timestamp but is never spelled out either.
  const activeWordWhole = (() => {
    if (variant !== "active" || total === 0) return total;
    if (!hasWords) return wordRevealed;
    // Sung characters plus the remaining characters of the in-progress word.
    let extra = 0;
    for (const t of lyricChars) {
      if (t.state === "active") extra += t.text.length;
    }
    return Math.min(total, sungCount + extra);
  })();

  return {
    index,
    lyricIndex,
    tokens,
    reveal: total > 0 ? wordRevealed / total : 1,
    revealedChars: wordRevealed,
    wholeWordChars: activeWordWhole,
    totalChars: total,
    complete,
    depth,
    comment: isComment,
    kind,
  };
}

/** Lyric tokens carry their position so syntax colour can be semantic. */
export type LyricRole = "member" | "argument" | "head";

/**
 * A syntax colour "palette family": which hues this song uses for the head
 * identifier, the member after the dot, and the quoted argument. Selection is
 * deterministic from the track seed, so a song keeps one coherent scheme for
 * its whole duration.
 */
export interface SyntaxTheme {
  /** Key used for `data-syntax` on the overlay root, picked up by CSS. */
  id: string;
  label: string;
}

/**
 * Palette families, each mapping the three lyric roles to a distinct, coherent
 * triad drawn from popular VS Code themes. The CSS holds the actual colours;
 * this list only names the schemes so they can be chosen deterministically.
 */
export const SYNTAX_THEMES: SyntaxTheme[] = [
  { id: "darkplus", label: "Dark+" }, // light blue / yellow / orange
  { id: "onedark", label: "One Dark" }, // cyan / lavender / mint
  { id: "dracula", label: "Dracula" }, // cyan / pink / soft green
  { id: "github", label: "GitHub Dark" }, // teal / lavender / coral
  { id: "monokai", label: "Monokai" }, // mint / yellow / magenta
  { id: "nightowl", label: "Night Owl" }, // lavender / teal / coral
];

/** Picks a syntax theme deterministically from the track seed. */
export function pickSyntaxTheme(seed: number): SyntaxTheme {
  const i = Math.abs(Math.trunc(seed)) % SYNTAX_THEMES.length;
  return SYNTAX_THEMES[i];
}

/** Semantic role of a lyric token, derived from its position in the expression. */
export function lyricRole(tok: CodeToken): LyricRole | null {
  if (!tok.lyric || tok.word === undefined) return null;
  // Word 0 is the primary identifier (`pastikan_cerita`).
  if (tok.word === 0) return "head";
  // Word 1 is the property after the dot (`tentang`).
  if (tok.word === 1) return "member";
  // Everything after the opening quote is a string argument.
  return "argument";
}

/**
 * Flattens the lyric composition into the exact ordered list of logical code
 * lines that the overlay renders.
 *
 * This is the single source of truth shared by the code renderer and the gutter:
 * both iterate the returned array, so a number can never exist without a row or
 * a row without a number.
 *
 * A block that opens or closes on a lyric line contributes *separate* rows:
 *
 *   open      `{`
 *   statement `  the_superficial.love;`   (with depth 1, so it is indented)
 *   close     `}`
 *
 * Previously the delimiter was glued into the statement with an embedded
 * newline, so one logical line painted on two physical rows but owned a single
 * number — nested children appeared unnumbered.
 *
 * Only completed expressions (up to `before`) plus the active one are returned;
 * upcoming expressions are never built, so their content cannot reach the DOM.
 */
/**
 * Number of rendered rows contributed by the lyrics before row `upTo`.
 *
 * A lyric contributes one `statement` row, plus one extra row for each
 * delimiter the composer placed on it. This mirrors `flattenLine` exactly, so
 * seeding a windowed composition with this count keeps the gutter numbering
 * continuous with the rows that scrolled out of view.
 */
export function absoluteRowCount(layout: LineLayout[] | undefined, upTo: number): number {
  const end = Math.max(0, Math.min(upTo, layout ? layout.length : upTo));
  let rows = 0;
  if (layout) {
    for (let i = 0; i < end; i++) {
      rows += 1 + (layout[i]?.open ? 1 : 0) + (layout[i]?.close ? 1 : 0);
    }
    return rows;
  }
  // No layout: every lyric is a single statement row.
  return end;
}

export function codeComposition(
  lines: LyricLine[],
  activeIndex: number,
  position: number,
  before = 3,
  layout?: LineLayout[],
): CodeLine[] {
  if (activeIndex < 0) return [];
  const start = Math.max(0, activeIndex - Math.max(0, before));
  const out: CodeLine[] = [];

  // `number` is the rendered line number (0-based; the gutter prints +1) and
  // advances once per logical row, independent of the lyric index, so opening
  // and closing delimiters receive their own numbers.
  //
  // It is seeded from the *absolute* row count of everything before the window,
  // so the gutter continues the file's numbering instead of restarting at 1 on
  // every render. Without this a nested block would print 1,2,3,4,5 while its
  // first child took the number the opener had a frame earlier.
  let number = absoluteRowCount(layout, start);
  for (let i = start; i <= activeIndex; i++) {
    const variant = i === activeIndex ? "active" : "prev";
    for (const row of flattenLine(lines[i], number, position, variant, layout?.[i], i)) {
      number++;
      out.push(row);
    }
  }
  return out;
}

/**
 * The ordered rows of a single lyric line, in display order.
 *
 * Indentation rules (matching the original visual design):
 *  - an `open` row's statement sits **inside** the block → depth + 1
 *  - a `close` row's statement is the **last member** of the block → depth + 1
 *  - a plain statement keeps the composer's depth
 *
 * Shared with `codeComposition` and the tests so the flattening order and the
 * numbering can be asserted directly.
 */
export function flattenLine(
  line: LyricLine,
  number: number,
  position: number,
  variant: "active" | "prev" | "next",
  lay?: LineLayout,
  lyricIndex: number = number,
): CodeLine[] {
  const rows: CodeLine[] = [];
  let n = number;
  const inBlock = !!(lay?.open || lay?.close);
  // Display order: `{` then its first member, or the last member then `}`.
  if (lay?.open)
    rows.push(buildCodeLine(line, n++, position, variant, lay, "open", lyricIndex));
  const stmtLayout: LineLayout | undefined = lay
    ? { ...lay, depth: inBlock ? lay.depth + 1 : lay.depth }
    : undefined;
  rows.push(
    buildCodeLine(line, n++, position, variant, stmtLayout, "statement", lyricIndex),
  );
  if (lay?.close)
    rows.push(buildCodeLine(line, n++, position, variant, lay, "close", lyricIndex));
  return rows;
}

/**
 * Full rendered text of a code line, formatting included. */
export function codeLineText(line: CodeLine): string {
  return line.tokens.map((t) => t.text).join("");
}

/**
 * Characters of the expression that are actually visible.
 *
 * Only the first `revealedChars` lyric characters are emitted; any punctuation
 * that follows the frontier is dropped so no future lyric content leaks into
 * the DOM. Generated syntax that sits *before* the next unrevealed lyric
 * character is emitted (e.g. the `_` after a finished word), which is what makes
 * the expression grow like real typing.
 */
export function codeLineRevealedText(line: CodeLine): string {
  const tokens = line.tokens;
  let budget = line.revealedChars;
  let out = "";
  // Tracks lyric text completion across the state-run tokens that make up a
  // single word, so punctuation only follows a fully typed word.
  let wordDone = true;
  let lastWord: number | undefined;
  let typedInWord = 0;
  let wordLen = 0;
  let lastRunEnd = 0;
  // True until the first lyric or separator token: indentation and opening
  // brackets come first and are editor chrome.
  let leading = true;
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.lyric) {
      leading = false;
      // Unrevealed lyric content stops the prefix: nothing future may leak.
      if (budget <= 0) break;
      const take = Math.min(tok.text.length, budget);
      out += tok.text.slice(0, take);
      budget -= take;
      // A word is only "done" once its whole source span is typed. A word is
      // split into several tokens (state runs), so the span length must be the
      // total across all runs of that word, and consumption accumulates.
      if (tok.word !== lastWord) {
        typedInWord = take;
        wordLen = (tok.sourceEnd ?? 0) - (tok.sourceStart ?? 0);
        lastWord = tok.word;
        lastRunEnd = tok.sourceEnd ?? 0;
      } else {
        typedInWord += take;
        // Extend the word span to cover subsequent runs of the same word.
        wordLen += (tok.sourceEnd ?? 0) - Math.max(tok.sourceStart ?? 0, lastRunEnd);
        lastRunEnd = tok.sourceEnd ?? 0;
      }
      wordDone = wordLen > 0 && typedInWord >= wordLen;
      continue;
    }
    // Leading decoration (indent, block brackets) and the `//` comment marker
    // are editor chrome and always render. Statement separators (`.`, `(`,
    // quotes, `;`) do not.
    if (tok.kind === "comment" || (tok.kind === "syntax" && leading)) {
      out += tok.text;
      continue;
    }
    // A separator belongs to the prefix exactly when everything before it has
    // been typed. That is what makes `i_keep.` appear before `dreaming` starts,
    // while a half-typed word never trails punctuation (`dream("`).
    //
    // The exception is a separator that introduces unrevealed lyric text: it
    // waits until that lyric has started, otherwise the wrapper renders with an
    // empty argument (`space(");`, `("");`) — the detached fragment seen live.
    //
    // The look-ahead must skip *runs* of syntax tokens, not just one: a call
    // wrapper is `(`, `"` and then the argument.
    let nextLyric = -1;
    for (let j = idx + 1; j < tokens.length; j++) {
      if (tokens[j].lyric) {
        nextLyric = j;
        break;
      }
    }
    const introducesLyric = nextLyric !== -1;
    if (introducesLyric) {
      // Opening syntax grows with the text it introduces.
      if (line.complete || (wordDone && budget > 0)) {
        out += tok.text;
        continue;
      }
      break;
    }
    // Closing syntax has no lyric after it: it may only appear once the whole
    // expression is revealed. Emitting it earlier produced a stray `");` while
    // the opener was still withheld.
    if (line.complete) {
      out += tok.text;
      continue;
    }
    break;
  }
  return out;
}

/**
 * The lyric words carried by a code line, in order, separated by single
 * spaces. Used by tests to prove lyric content is preserved.
 */
export function codeLineLyricText(line: CodeLine): string {
  let out = "";
  let last = -1;
  for (const t of line.tokens) {
    if (!t.lyric || t.word === undefined) continue;
    if (t.word !== last) {
      if (last >= 0) out += " ";
      last = t.word;
    }
    out += t.text;
  }
  return out;
}