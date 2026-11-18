import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HISTORY_LINES,
  MAX_HISTORY_LINES,
  MIN_HISTORY_LINES,
  clampHistoryLines,
  completedLinesFor,
  historyLinesOf,
  historyPatch,
} from "../src/lib/history.ts";

test("history slider range is 1..20 inclusive", () => {
  assert.equal(MIN_HISTORY_LINES, 1);
  assert.equal(MAX_HISTORY_LINES, 20);
  assert.equal(DEFAULT_HISTORY_LINES, 10);
});

test("every integer in the slider range round-trips", () => {
  for (let n = 1; n <= 20; n++) {
    assert.equal(clampHistoryLines(n), n);
    assert.equal(historyLinesOf({ historyLines: n }), n);
    const patch = historyPatch(n);
    assert.equal(patch.historyLines, n);
  }
});

test("out-of-range and fractional values are clamped to integers", () => {
  assert.equal(clampHistoryLines(0), 1);
  assert.equal(clampHistoryLines(-5), 1);
  assert.equal(clampHistoryLines(999), 20);
  assert.equal(clampHistoryLines(7.6), 8);
  assert.equal(clampHistoryLines(Number.NaN), 10);
  assert.equal(clampHistoryLines(Number.POSITIVE_INFINITY), 10);
});

test("completed lines = history minus the active line", () => {
  // codeComposition keeps `before` completed lines + the active one, so the
  // visible total is before + 1.
  assert.equal(completedLinesFor(1), 0);
  assert.equal(completedLinesFor(3), 2);
  assert.equal(completedLinesFor(6), 5);
  assert.equal(completedLinesFor(10), 9);
  assert.equal(completedLinesFor(20), 19);
  assert.equal(completedLinesFor(0), 0);
});

test("legacy linesBefore/linesAfter still resolve when historyLines is absent", () => {
  assert.equal(historyLinesOf({ linesBefore: 1, linesAfter: 2 }), 3);
  assert.equal(historyLinesOf({ linesBefore: 2, linesAfter: 4 }), 6);
  assert.equal(historyLinesOf({ linesBefore: 0, linesAfter: 0 }), 10);
  assert.equal(historyLinesOf({ historyLines: 4, linesBefore: 1, linesAfter: 2 }), 4);
});

test("historyPatch keeps the legacy fields consistent and never touches geometry", () => {
  const p = historyPatch(10);
  assert.equal(p.historyLines, 10);
  assert.equal(p.linesBefore, 9);
  assert.equal(p.linesAfter, 0);
  assert.equal("overlayX" in p, false);
  assert.equal("overlayY" in p, false);
  assert.equal("overlayWidth" in p, false);
  assert.equal("overlayHeight" in p, false);
});
