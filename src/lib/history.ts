// Lyric-history window.
//
// The old implementation exposed MIN/MED/MAX presets that wrote `linesBefore` /
// `linesAfter`, but the overlay ignored them entirely: it hard-coded
// `HISTORY_LINES = 10`. That is why changing the setting did nothing.
//
// The overlay now drives its history window from a single value —
// `historyLines`, the number of visible lines *including* the active one —
// which the Settings slider edits directly (1..=20).

import type { Settings } from "../types";

export const MIN_HISTORY_LINES = 1;
export const MAX_HISTORY_LINES = 20;
export const DEFAULT_HISTORY_LINES = 10;

/** Clamps any candidate to the supported range and to integers. */
export function clampHistoryLines(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_LINES;
  return Math.min(MAX_HISTORY_LINES, Math.max(MIN_HISTORY_LINES, Math.round(n)));
}

/**
 * Resolves the history window for a settings object.
 *
 * Falls back to the legacy `linesBefore` + `linesAfter` pair when a settings
 * file predates `historyLines`, so existing users keep a sensible value.
 */
export function historyLinesOf(s: {
  historyLines?: number;
  linesBefore?: number;
  linesAfter?: number;
}): number {
  if (typeof s.historyLines === "number") return clampHistoryLines(s.historyLines);
  const legacy = (s.linesBefore ?? 0) + (s.linesAfter ?? 0);
  return clampHistoryLines(legacy > 0 ? legacy : DEFAULT_HISTORY_LINES);
}

/**
 * How many *completed* lines are shown above the active one.
 *
 * `codeComposition(lines, activeIndex, position, before, layout)` keeps
 * `before` completed expressions plus the active one, so the visible total is
 * `before + 1`.
 */
export function completedLinesFor(historyLines: number): number {
  return Math.max(0, clampHistoryLines(historyLines) - 1);
}

/** Patch that writes a new history size, keeping the legacy fields in sync. */
export function historyPatch(historyLines: number): Partial<Settings> {
  const n = clampHistoryLines(historyLines);
  return {
    historyLines: n,
    linesBefore: Math.max(0, n - 1),
    linesAfter: 0,
  };
}
