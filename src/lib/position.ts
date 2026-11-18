// Overlay placement math.
//
// The authoritative anchor math lives in Rust (`src-tauri/src/lib.rs`,
// `corner_position`); this mirror lets the control panel keep its X/Y inputs
// in sync and lets the geometry be unit tested without a window.

import type { Anchor } from "../types";

/** Gap between the overlay and the screen edge, matching the Rust backend. */
export const CORNER_MARGIN = 24;

export interface Bounds {
  /** Work-area origin (may be negative on a left/top monitor). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Top-left corner of the overlay for `anchor` inside `bounds`.
 *
 * The overlay is kept fully on screen: it is clamped to
 * `[origin + margin, origin + extent - size - margin]` and, when the overlay is
 * larger than the area allows, pushed to the origin + margin.
 */
export function cornerPosition(anchor: Anchor, bounds: Bounds, size: Size): { x: number; y: number } {
  const right = anchor === "topRight" || anchor === "bottomRight";
  const bottom = anchor === "bottomLeft" || anchor === "bottomRight";

  const minX = bounds.x + CORNER_MARGIN;
  const minY = bounds.y + CORNER_MARGIN;
  const maxX = bounds.x + bounds.width - size.width - CORNER_MARGIN;
  const maxY = bounds.y + bounds.height - size.height - CORNER_MARGIN;

  const x = right ? maxX : minX;
  const y = bottom ? maxY : minY;

  return {
    x: Math.max(minX, x),
    y: Math.max(minY, y),
  };
}
