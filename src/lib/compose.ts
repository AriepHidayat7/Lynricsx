// Composition engine: decides how a lyric line is *wrapped* in code structure.
//
// This module never adds lyric content. It only chooses formatting for a line
// group: indentation, whether the line is shown as a `//` comment, and whether
// it opens / closes a `{}` or `[]` block. The lyric words themselves still come
// from `codeview.ts`, which continues to own tokens, timing and reveal.
//
// Selection is deterministic: every decision is derived from a seed built from
// the track identity, so a song always renders the same way while different
// songs get different structures.

import type { LyricLine } from "../types.ts";

/** The four composition styles. */
export type ComposeStyle = "flat" | "nested" | "comment" | "hybrid";

/** How a single line is rendered. */
export interface LineLayout {
  /** Indentation level; each level is one 4-space editor tab stop. */
  depth: number;
  /** True when the whole line is rendered as a `//` comment. */
  comment: boolean;
  /** Opening bracket placed before the line, e.g. `{` or `[`. */
  open?: "{" | "[";
  /** Closing bracket placed after the line, e.g. `}` or `]`. */
  close?: "}" | "]";
}

/** 32-bit string hash (FNV-1a), stable across runs and platforms. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Seeded PRNG (mulberry32). Deterministic for a given seed, so the same song
 * always produces the same composition — never reshuffled on re-render, pause
 * or refresh.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed for a track. Uses the track identity (title + artist, plus album when
 * available) so the same song always yields the same composition while
 * different songs differ.
 */
export function trackSeed(
  title: string | undefined,
  artist: string | undefined,
  album?: string | undefined,
): number {
  // Normalise each component separately so surrounding whitespace and letter
  // case never change a track's identity.
  const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  const key = [norm(title), norm(artist), norm(album)].join("\u0000");
  return hash32(key);
}

/** Picks one of the four styles from a seeded stream. */
export function pickStyle(rand: () => number): ComposeStyle {
  const styles: ComposeStyle[] = ["flat", "nested", "comment", "hybrid"];
  return styles[Math.floor(rand() * styles.length) % styles.length];
}

/**
 * Builds the layout for every line of a song.
 *
 * Lines are grouped into small sections (2-4 lines) so a single song can mix
 * styles — flat for one group, nested or commented for another — instead of
 * forcing one style across the whole track.
 */
export function composeLayout(
  lines: LyricLine[],
  seed: number,
  style?: ComposeStyle,
): LineLayout[] {
  const rand = mulberry32(seed);
  // The song's dominant style is a bias, not a mandate: groups rotate through
  // the other styles so a single song mixes flat, nested and comment looks.
  const songStyle = style ?? pickStyle(rand);
  const others = (["flat", "nested", "comment", "hybrid"] as ComposeStyle[]).filter(
    (s) => s !== songStyle,
  );
  const out: LineLayout[] = [];
  let i = 0;
  let groupNo = 0;

  while (i < lines.length) {
    // Section length 2-4 lines keeps the rhythm organic.
    const len = Math.min(lines.length - i, 2 + Math.floor(rand() * 3));
    // First group uses the song style; later groups mostly vary. When the style
    // is forced by a caller, every group uses it.
    const groupStyle =
      style ??
      (groupNo === 0 || rand() < 0.3
        ? songStyle
        : others[Math.floor(rand() * others.length) % others.length]);
    groupNo++;

    // Nesting only ever produces *closed* blocks. A block is only worth opening
    // around two or more lyric lines; wrapping a single statement in brackets
    // looks accidental, so shorter groups stay flat.
    const useNest = groupStyle === "nested" || groupStyle === "hybrid";
    let nonBlankCount = 0;
    let firstNonBlankIndex = -1;
    let lastNonBlankIndex = -1;
    for (let k = 0; k < len && i + k < lines.length; k++) {
      if ((lines[i + k].text ?? "").trim()) {
        if (firstNonBlankIndex < 0) firstNonBlankIndex = k;
        lastNonBlankIndex = k;
        nonBlankCount++;
      }
    }
    const canNest = nonBlankCount >= 2;
    const open =
      useNest && canNest && (groupStyle === "nested" ? rand() < 0.9 : rand() < 0.5);
    const bracket: "{" | "[" = rand() < 0.6 ? "{" : "[";
    const closeBracket: "}" | "]" = bracket === "{" ? "}" : "]";

    // Brackets stay attached 1:1 to lyric lines so layout indices keep matching
    // the lyric indices. The opener renders on its own visual line before its
    // lyric; the closer renders on its own line after. This keeps balance easy
    // to reason about and never yields `{//`.
    const firstIdx = open ? firstNonBlankIndex : -1;
    const lastIdx = open ? lastNonBlankIndex : -1;

    for (let k = 0; k < len && i < lines.length; k++, i++) {
      const text = (lines[i].text ?? "").trim();
      // Blank lyric lines are separators, never commented or bracketed.
      if (!text) {
        out.push({ depth: 0, comment: false });
        continue;
      }

      const isBraceLine = open && (k === firstIdx || k === lastIdx);
      // A brace line is structure, never a comment, so `{//` cannot occur.
      const commented =
        !isBraceLine &&
        (groupStyle === "comment"
          ? rand() < 0.85
          : groupStyle === "hybrid"
            ? rand() < 0.5
            : false);

      out.push({
        // Block members sit one level in; the opener/closer brace lines sit
        // flush left so `{` / `}` read as structure, not content.
        depth: open && !isBraceLine ? 1 : 0,
        comment: commented,
        open: open && k === firstIdx ? bracket : undefined,
        close: open && k === lastIdx ? closeBracket : undefined,
      });
    }
  }

  return out;
}
