// Responsive sizing for the overlay's terminal log.
//
// Kept free of React so it can be unit tested directly: the component only
// supplies measurements. The terminal must never overflow its container, so it
// derives how many log rows actually fit and shows the newest ones.

/**
 * Below this height the terminal shows status only. It is roughly the space the
 * fixed chrome needs (file row + status line + padding + gaps) plus one log row.
 */
export const COMPACT_BELOW_PX = 84;
/** Below this, the terminal cannot show anything legibly and yields entirely. */
export const HIDE_BELOW_PX = 26;
/** Vertical gap between log rows, matching the stylesheet. */
export const ROW_GAP_PX = 1;
/** Hard ceiling on rendered rows, regardless of available height. */
export const MAX_VISIBLE_LINES = 12;

/** How the terminal should present itself at a given height. */
export type TerminalMode = "log" | "status" | "hidden";

/** The presentation mode for a measured container height. */
export function terminalMode(height: number): TerminalMode {
  if (!Number.isFinite(height) || height < HIDE_BELOW_PX) return "hidden";
  if (height < COMPACT_BELOW_PX) return "status";
  return "log";
}

/** The measurements the component feeds in, all in px. */
export interface RowMetrics {
  /** Height of one rendered log row; 0 when none has rendered yet. */
  rowHeight: number;
  /** Height left for rows after the fixed chrome has been subtracted. */
  available: number;
}

/**
 * How many log lines fit in `height` px.
 *
 * Returns 0 when there is no usable room, which the component renders as the
 * compact single-line status instead of a clipped log.
 *
 * NOTE: the caller passes the *available* height, i.e. the container minus the
 * chrome that must stay visible (file row, prompt row, gaps and padding). That
 * keeps this function free of layout constants that could drift from the CSS.
 */
export function linesThatFit(available: number, m: Pick<RowMetrics, "rowHeight">): number {
  if (!Number.isFinite(available) || available <= 0) return 0;
  const rowH = m.rowHeight > 0 ? m.rowHeight : 16;
  const n = Math.floor(available / (rowH + ROW_GAP_PX));
  if (n <= 0) return 0;
  return Math.min(n, MAX_VISIBLE_LINES);
}

/** The newest `fit` lines, which is what the terminal actually renders. */
export function visibleTail<T>(lines: T[], fit: number): T[] {
  if (fit <= 0) return [];
  return lines.slice(-fit);
}
