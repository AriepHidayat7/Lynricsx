// Past-lyric appearance options.
//
// The stored values are unchanged ("muted" / "dim" / "accent") because they
// select the `.overlay.completed-<value>` class that owns the visual intensity
// in `overlay.css`. Only the human-facing labels changed:
//
//   muted  -> SUBTLE    (lightest fade, palette hues dimmed)
//   dim    -> BALANCED  (deepest fade, quietest)
//   accent -> STRONG    (past lines stay near the active line's brightness)
//
// Keeping the mapping in one place — and away from React — is what lets the
// pairing be unit tested, so the intensity order cannot silently flip.

import type { CompletedWordColor } from "../types";

export interface PastOption {
  value: CompletedWordColor;
  label: string;
}

/** Ordered lightest-to-strongest, matching the segmented control's rules. */
export const PAST_OPTIONS: PastOption[] = [
  { value: "muted", label: "SUBTLE" },
  { value: "dim", label: "BALANCED" },
  { value: "accent", label: "STRONG" },
];

/**
 * Past-line opacity per value, mirroring `--past-opacity` in `overlay.css`.
 *
 * Duplicated deliberately: the tests assert the on-screen order (SUBTLE fades
 * less than BALANCED, STRONG is brightest) so a CSS edit that reverses the
 * mapping is caught.
 */
export const PAST_OPACITY: Record<CompletedWordColor, number> = {
  muted: 0.62,
  dim: 0.35,
  accent: 1,
};
