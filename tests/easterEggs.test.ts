import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EGG_MIN_GAP_MS,
  EGGS_BY_TRIGGER,
  EASTER_EGGS,
  initialEggState,
  observeEgg,
} from "../src/lib/easterEggs.ts";

test("the curated collection is non-empty and every message is short", () => {
  assert.ok(EASTER_EGGS.length >= 8);
  for (const e of EASTER_EGGS) {
    assert.ok(e.text.length > 0 && e.text.length <= 48, `too long: ${e.text}`);
    assert.ok(e.tag.length > 0);
  }
});

// Builds a real event for `observeEgg`. Each simulated moment is a distinct
// track key unless one is passed, so identity changes drive the triggers.
const ev = (over: Record<string, unknown> = {}) => ({
  trackKey: "track\u0000artist",
  title: "Track",
  artist: "Artist",
  playbackState: "playing",
  positionMs: 0,
  durationMs: 200_000,
  seekSeq: 0,
  now: 10_000,
  ...over,
});

test("every trigger pool is non-empty and every message is short", () => {
  for (const [trigger, pool] of Object.entries(EGGS_BY_TRIGGER)) {
    assert.ok(pool.length > 0, `${trigger} has no eggs`);
    for (const e of pool) {
      assert.ok(e.tag.length > 0, `${trigger}: missing tag`);
      assert.ok(
        e.text.length > 0 && e.text.length <= 48,
        `${trigger}: too long: ${e.text}`,
      );
    }
  }
});

test("a lone track change does not surface an egg (they stay rare)", () => {
  // The first event opens the first track; the second is the first transition.
  const first = observeEgg(initialEggState(), ev({ now: 10_000 }));
  assert.ok(first.egg, "first-track is allowed to greet the user");

  // A transition right after an egg is suppressed by the cross-trigger gap.
  const second = observeEgg(first.state, ev({ trackKey: "b\u0000b", now: 10_500 }));
  assert.equal(second.egg, null, "must not cluster after the first egg");
});

test("disabled-style rarity: eggs never cluster within the gap", () => {
  let state = initialEggState();
  let at = 10_000;
  // Walk 40 distinct tracks one second apart: at most one egg per gap.
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const r = observeEgg(state, ev({ trackKey: `t${i}\u0000a`, now: at }));
    state = r.state;
    if (r.egg) times.push(at);
    at += 1_000;
  }
  for (let i = 1; i < times.length; i++) {
    assert.ok(
      times[i] - times[i - 1] >= EGG_MIN_GAP_MS,
      `eggs clustered: ${times[i - 1]} -> ${times[i]}`,
    );
  }
  assert.ok(times.length < 40, "must not show on every track");
});

test("selection is deterministic for the same event sequence", () => {
  const run = () => {
    let s = initialEggState();
    const out: string[] = [];
    for (let i = 0; i < 16; i++) {
      const r = observeEgg(s, ev({ trackKey: `k${i}\u0000a`, now: 10_000 + i * 60_000 }));
      s = r.state;
      if (r.egg) out.push(r.egg.text);
    }
    return out;
  };
  assert.deepEqual(run(), run());
});

test("the same message is never shown twice in a row", () => {
  let state = initialEggState();
  let prev = "";
  let emitted = 0;
  for (let i = 0; i < 80; i++) {
    const r = observeEgg(
      state,
      ev({ trackKey: `k${i}\u0000a`, now: 10_000 + i * (EGG_MIN_GAP_MS + 1) }),
    );
    state = r.state;
    if (r.egg) {
      assert.notEqual(r.egg.text, prev, "repeated message");
      prev = r.egg.text;
      emitted++;
    }
  }
  assert.ok(emitted > 1, "expected several eggs over 80 spaced events");
});
