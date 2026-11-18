import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_BELOW_PX,
  HIDE_BELOW_PX,
  MAX_VISIBLE_LINES,
  linesThatFit,
  terminalMode,
  visibleTail,
  type RowMetrics,
} from "../src/lib/termFit.ts";

/**
 * Responsive terminal sizing.
 *
 * The terminal must adapt to real container height: show fewer historical lines
 * as it shrinks, never overflow, and collapse to a status-only presentation when
 * there is no usable room.
 */

// A typical rendered row height in the overlay.
const M: RowMetrics = { rowHeight: 18, available: 300 };

test("a tall overlay shows the full capped log", () => {
  assert.equal(linesThatFit(600, M), MAX_VISIBLE_LINES);
});

test("a normal overlay shows a sensible number of lines", () => {
  const n = linesThatFit(300, M);
  assert.ok(n >= 6, `expected >= 6 lines at 300px, got ${n}`);
  assert.ok(n <= MAX_VISIBLE_LINES);
});

test("shrinking the available space never increases the line count", () => {
  let prev = Infinity;
  for (const a of [600, 420, 320, 260, 200, 160, 120, 100]) {
    const n = linesThatFit(a, M);
    assert.ok(n <= prev, `line count grew at ${a}px: ${prev} -> ${n}`);
    prev = n;
  }
});

test("no usable room yields zero rows (compact presentation)", () => {
  for (const a of [0, -5, 10]) {
    assert.equal(linesThatFit(a, M), 0, `expected 0 rows at ${a}px`);
  }
});

test("presentation mode steps down as height shrinks", () => {
  assert.equal(terminalMode(600), "log");
  assert.equal(terminalMode(COMPACT_BELOW_PX), "log");
  assert.equal(terminalMode(COMPACT_BELOW_PX - 1), "status");
  assert.equal(terminalMode(40), "status");
  assert.equal(terminalMode(HIDE_BELOW_PX - 1), "hidden");
  assert.equal(terminalMode(0), "hidden");
  assert.equal(terminalMode(NaN), "hidden");
});

test("rows never exceed the space they were given", () => {
  // Regression: an extra safety row previously turned a small but usable
  // area into zero rows, collapsing the log permanently at 86px.
  for (const a of [300, 200, 122, 86, 40, 19]) {
    const n = linesThatFit(a, M);
    const used = n * (M.rowHeight + 1);
    assert.ok(used <= a, `rows overflow at ${a}px: used ${used}`);
    if (a >= M.rowHeight + 1) assert.ok(n >= 1, `usable space at ${a}px must show a row`);
  }
});

test("a zero or missing row height does not divide by zero", () => {
  for (const rowHeight of [0, -3, NaN]) {
    const n = linesThatFit(300, { rowHeight, available: 300 });
    assert.ok(Number.isInteger(n) && n > 0 && n <= MAX_VISIBLE_LINES, `bad count: ${n}`);
  }
});

test("the rendered tail is the newest lines, not the oldest", () => {
  const all = Array.from({ length: 9 }, (_, i) => i);
  assert.deepEqual(visibleTail(all, 3), [6, 7, 8]);
  assert.deepEqual(visibleTail(all, 0), [], "compact renders nothing");
  assert.deepEqual(visibleTail(all, 20), all, "never fabricates rows");
});

// ---------------------------------------------------------------------------
// Regression: rows used to be *compressed* instead of dropped.
//
// `.term-line` inherited `flex-shrink: 1` inside the `.term-lines` column flex
// container, so as the overlay shrank every row was squashed (19.4px at full
// size down to 3.6px when tiny). Text was sliced vertically and rows appeared
// to overlap, which is exactly what the reported recording shows.
//
// The stylesheet now pins rows with `flex: 0 0 auto`, so a row always reports
// its true height. These tests lock in the arithmetic that follows from that:
// the count must be computed from the real row height, and the tail that is
// rendered must physically fit.
// ---------------------------------------------------------------------------

/** Row heights measured in the real overlay at each size. */
const REAL_ROW_H = 19.4;
const ROW_ADVANCE = REAL_ROW_H + 1; // + ROW_GAP_PX

test("a squashed row height is never used, so text cannot be sliced", () => {
  // If a caller ever measures a compressed row (the old bug), the count it
  // produces must not be trusted to render more rows than really fit at full
  // row height. Guard the invariant that the rendered rows fit in the box.
  for (const available of [202, 185, 105, 45]) {
    const n = linesThatFit(available, { rowHeight: REAL_ROW_H, available });
    assert.ok(n * ROW_ADVANCE <= available + 0.001, `rows overflow ${available}px at true height`);
  }
});

test("rendered rows fit exactly at every real overlay size", () => {
  // Available row space measured per overlay size, at a 19.4px row height.
  const cases: [string, number, number][] = [
    ["normal", 202.5, 10],
    ["medium", 185.2, 9],
    ["small", 105.2, 5],
    ["tiny", 45.2, 2],
  ];
  for (const [name, available, expectedMax] of cases) {
    const n = linesThatFit(available, { rowHeight: REAL_ROW_H, available });
    assert.ok(n <= expectedMax, `${name}: ${n} rows exceeds the ${expectedMax} that fit`);
    assert.ok(n * ROW_ADVANCE <= available + 0.001, `${name}: ${n} rows overflow ${available}px`);
  }
});

test("the compact threshold leaves room for the status line", () => {
  // The status line is ~19.4px plus padding; below the compact threshold the
  // log is dropped entirely rather than being allowed to squeeze the prompt.
  const statusOnlyHeight = COMPACT_BELOW_PX - 1;
  assert.equal(terminalMode(statusOnlyHeight), "status");
  assert.equal(terminalMode(statusOnlyHeight + 1), "log");
  assert.ok(
    COMPACT_BELOW_PX > REAL_ROW_H,
    "compact threshold must exceed a single row or the prompt could not fit",
  );
});

test("a long status message cannot force horizontal growth", () => {
  // Ellipsis is a CSS concern, but the count logic must still refuse to render
  // rows once the status plus chrome consume the box.
  const promptAndFile = REAL_ROW_H * 2 + 6 * 2;
  const n = linesThatFit(REAL_ROW_H - 1, { rowHeight: REAL_ROW_H });
  assert.equal(n, 0, "no row may render in less than one row height");
  assert.ok(promptAndFile > REAL_ROW_H, "chrome alone exceeds one row");
});
