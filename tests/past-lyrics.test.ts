import { test } from "node:test";
import assert from "node:assert/strict";
import { PAST_OPTIONS, PAST_OPACITY } from "../src/lib/pastLyrics.ts";

/**
 * Past-lyric fade options.
 *
 * The labels were renamed (MUTED/DIM/HOT -> SUBTLE/BALANCED/STRONG) while the
 * stored values and their opacity mapping stayed identical. These tests pin the
 * pairing so a future edit cannot silently reverse the intensity order.
 */

test("the control offers exactly three options, lightest first", () => {
  assert.equal(PAST_OPTIONS.length, 3);
  assert.deepEqual(
    PAST_OPTIONS.map((o) => o.label),
    ["SUBTLE", "BALANCED", "STRONG"],
  );
});

test("labels map onto the unchanged stored values", () => {
  assert.deepEqual(
    PAST_OPTIONS.map((o) => o.value),
    ["muted", "dim", "accent"],
  );
});

test("opacity mapping matches the stylesheet, not a reversed copy", () => {
  // Mirrors `--past-opacity` in overlay.css.
  assert.equal(PAST_OPACITY.muted, 0.62);
  assert.equal(PAST_OPACITY.dim, 0.35);
  assert.equal(PAST_OPACITY.accent, 1);
});

test("BALANCED fades hardest, STRONG stays brightest", () => {
  // Guards against reversing the segmented control: "strong" must never end up
  // dimmer than "balanced", and "subtle" must not be the quietest.
  assert.ok(
    PAST_OPACITY.dim < PAST_OPACITY.muted,
    "BALANCED must recede further than SUBTLE",
  );
  assert.ok(
    PAST_OPACITY.muted < PAST_OPACITY.accent,
    "SUBTLE must be dimmer than STRONG",
  );
  assert.equal(PAST_OPACITY.accent, 1, "STRONG keeps past lines at full opacity");
});

test("every option's value has an opacity, so none renders unstyled", () => {
  for (const { value } of PAST_OPTIONS) {
    assert.equal(
      typeof PAST_OPACITY[value],
      "number",
      `no opacity for "${value}"`,
    );
  }
});
