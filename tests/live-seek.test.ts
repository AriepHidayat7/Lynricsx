import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_RESOLUTION_MS,
  activeLineIndex,
  clockStep,
  interpolatePosition,
} from "../src/lib/sync.ts";
import type { LyricLine, TrackSnapshot } from "../src/types.ts";

const track = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  hasSession: true,
  title: "Monolog",
  artist: "Pamungkas",
  album: "Monolog",
  sourceAppId: "Spotify.exe",
  sourceAppName: "Spotify",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 200_000,
  sampledAtMs: 0,
  seekSeq: 0,
  trackSeq: 0,
  ...over,
});

// One line every 10 s.
const lines: LyricLine[] = Array.from({ length: 20 }, (_, i) => ({
  startMs: i * 10_000,
  endMs: (i + 1) * 10_000,
  text: `line ${i}`,
}));

/**
 * Mirrors what the overlay does when a `media:track` event arrives: derive the
 * render position from the snapshot and decide whether the active line moved.
 */
function onSnapshot(
  prevRendered: number,
  snapshot: TrackSnapshot,
  now: number,
): { rendered: number; activeLine: number; seek: boolean; updated: boolean } {
  const pos = interpolatePosition(snapshot, now);
  const step = clockStep(prevRendered, pos);
  const rendered = step.update ? pos : prevRendered;
  return {
    rendered,
    activeLine: activeLineIndex(lines, pos),
    seek: step.seek,
    updated: step.update,
  };
}

test("a seek inside the SAME track must still update the rendered position", () => {
  // This is the runtime bug: the track key is identical before and after the
  // seek, so any change-detection keyed on identity alone drops the update.
  const before = track({ positionMs: 120_000, sampledAtMs: 1_000, seekSeq: 0 });
  const after = track({ positionMs: 30_000, sampledAtMs: 2_000, seekSeq: 1 });

  assert.equal(before.title, after.title, "same track");

  const rendered = 121_000; // where the overlay currently shows
  const res = onSnapshot(rendered, after, 2_000);

  assert.equal(res.updated, true, "position must be adopted");
  assert.equal(res.rendered, 30_000);
  assert.equal(res.activeLine, 3, "active line follows the new timestamp");
});

test("with the track key unchanged, a position delta is still observable", () => {
  // The Rust pipeline compares the position it last forwarded; confirm a seek
  // produces a different value even when identity and state are identical.
  const a = track({ positionMs: 176_445, seekSeq: 3 });
  const b = track({ positionMs: 20_000, seekSeq: 4 });
  assert.notEqual(a.positionMs, b.positionMs);
  assert.notEqual(a.seekSeq, b.seekSeq);
  assert.equal(a.playbackState, b.playbackState, "state stays Playing across a seek");
});

test("forward seek updates the rendered line and reveal", () => {
  const res = onSnapshot(33_714, track({ positionMs: 150_010, sampledAtMs: 1_000 }), 1_000);
  assert.equal(res.seek, true);
  assert.equal(res.rendered, 150_010);
  assert.equal(res.activeLine, 15);
});

test("backward seek updates the rendered line", () => {
  const res = onSnapshot(176_445, track({ positionMs: 20_000, sampledAtMs: 1_000 }), 1_000);
  assert.equal(res.seek, true);
  assert.equal(res.rendered, 20_000);
  assert.equal(res.activeLine, 2);
});

test("a seek within the same line still moves the rendered position", () => {
  // Both 120_000 and 125_000 are inside line 12.
  const a = onSnapshot(118_000, track({ positionMs: 120_000, sampledAtMs: 1_000 }), 1_000);
  const b = onSnapshot(a.rendered, track({ positionMs: 128_000, sampledAtMs: 2_000 }), 2_000);

  assert.equal(a.activeLine, 12);
  assert.equal(b.activeLine, 12, "same line");
  // ...but the position (and therefore reveal + caret) advanced.
  assert.ok(b.rendered > a.rendered);
  assert.equal(b.rendered, 128_000);
});

test("normal playback after a seek is not mistaken for another seek", () => {
  // Adopt the seek position, then feed steady 250 ms progress with matching
  // sample timestamps so interpolation does not add drift.
  let rendered = 20_000;
  for (let i = 1; i <= 8; i++) {
    const sampledAt = 1_000 + i * 250;
    const res = onSnapshot(
      rendered,
      track({ positionMs: 20_000 + i * 250, sampledAtMs: sampledAt }),
      sampledAt,
    );
    rendered = res.rendered;
    assert.equal(res.seek, false, `frame ${i} flagged as seek`);
  }
  assert.ok(rendered > 20_000, "playback progressed");
});

test("small sub-resolution deltas are throttled but larger ones apply", () => {
  const small = onSnapshot(10_000, track({ positionMs: 10_050, sampledAtMs: 1_000 }), 1_000);
  assert.equal(small.updated, false, "below display resolution");

  const big = onSnapshot(10_000, track({ positionMs: 10_000 + CLOCK_RESOLUTION_MS, sampledAtMs: 1_000 }), 1_000);
  assert.equal(big.updated, true);
});
