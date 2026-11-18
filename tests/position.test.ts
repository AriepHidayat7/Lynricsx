import { test } from "node:test";
import assert from "node:assert/strict";
import { CORNER_MARGIN, cornerPosition } from "../src/lib/position.ts";

// A 1920x1080 primary monitor, no taskbar offset, 760x440 overlay.
const bounds = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 760, height: 440 };

test("corner anchors place the overlay at the matching screen corner", () => {
  const tl = cornerPosition("topLeft", bounds, size);
  assert.deepEqual(tl, { x: CORNER_MARGIN, y: CORNER_MARGIN });

  const tr = cornerPosition("topRight", bounds, size);
  assert.equal(tr.x, 1920 - 760 - CORNER_MARGIN);
  assert.equal(tr.y, CORNER_MARGIN);

  const bl = cornerPosition("bottomLeft", bounds, size);
  assert.equal(bl.x, CORNER_MARGIN);
  assert.equal(bl.y, 1040 - 440 - CORNER_MARGIN);

  const br = cornerPosition("bottomRight", bounds, size);
  assert.equal(br.x, 1920 - 760 - CORNER_MARGIN);
  assert.equal(br.y, 1040 - 440 - CORNER_MARGIN);
});

test("corner anchors respect a monitor whose work area starts at a negative origin", () => {
  // Secondary monitor placed to the left of the primary one.
  const secondary = { x: -1920, y: -200, width: 1920, height: 1040 };
  const tl = cornerPosition("topLeft", secondary, size);
  assert.equal(tl.x, -1920 + CORNER_MARGIN);
  assert.equal(tl.y, -200 + CORNER_MARGIN);

  const br = cornerPosition("bottomRight", secondary, size);
  assert.equal(br.x, -760 - CORNER_MARGIN);
  assert.equal(br.y, -200 + 1040 - 440 - CORNER_MARGIN);
});

test("an overlay larger than the work area stays on screen instead of going negative", () => {
  const tiny = { x: 0, y: 0, width: 600, height: 300 };
  for (const anchor of ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const) {
    const pos = cornerPosition(anchor, tiny, size);
    assert.equal(pos.x, CORNER_MARGIN, anchor);
    assert.equal(pos.y, CORNER_MARGIN, anchor);
  }
});

test("a custom anchor is positioned like a top-left anchor (never off screen)", () => {
  assert.deepEqual(cornerPosition("custom", bounds, size), {
    x: CORNER_MARGIN,
    y: CORNER_MARGIN,
  });
});
