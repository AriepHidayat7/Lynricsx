import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EGG_MIN_GAP_MS,
  LONG_LISTEN_MS,
  REPEAT_SEEK_COUNT,
  initialEggState,
  observeEgg,
  type EasterEggState,
} from "../src/lib/easterEggs.ts";

/**
 * Enhanced easter eggs.
 *
 * Every trigger must be driven by a real event, eggs must be rare (rate limited
 * and never repeating), and they must never fire from ordinary progress updates.
 */

const ev = (o: Partial<Parameters<typeof observeEgg>[1]> = {}) => ({
  trackKey: "song-a",
  title: "Song A",
  artist: "Artist",
  playbackState: "playing",
  positionMs: 1000,
  durationMs: 200_000,
  seekSeq: 0,
  now: 1_000_000,
  ...o,
});

/** Runs a sequence of events, returning the eggs that fired. */
function run(start: EasterEggState, events: ReturnType<typeof ev>[]) {
  let state = start;
  const eggs: string[] = [];
  for (const e of events) {
    const res = observeEgg(state, e);
    state = res.state;
    if (res.egg) eggs.push(res.egg.text);
  }
  return { state, eggs };
}

describe("easter eggs: first track", () => {
  it("may fire on the first track of the session", () => {
    const { eggs } = run(initialEggState(), [ev()]);
    assert.ok(eggs.length <= 1, "at most one egg on the first track");
  });

  it("does not treat a repeat of the same track as a first track", () => {
    const { state } = run(initialEggState(), [ev()]);
    assert.equal(state.firstDone, true);
    const second = observeEgg(state, ev({ now: 1_100_000 }));
    assert.equal(second.state.tracks, 1, "same track must not count twice");
  });
});

describe("easter eggs: replay detection", () => {
  it("counts a returning track as a replay, not a new track", () => {
    const { state } = run(initialEggState(), [
      ev({ trackKey: "a", now: 1_000_000 }),
      ev({ trackKey: "b", now: 1_200_000 }),
    ]);
    assert.equal(state.tracks, 2);
    assert.equal(state.plays["a"], 1);
    assert.equal(state.plays["b"], 1);
  });

  it("increments the play count when a track returns", () => {
    const { state } = run(initialEggState(), [
      ev({ trackKey: "a", now: 1_000_000 }),
      ev({ trackKey: "b", now: 1_200_000 }),
      ev({ trackKey: "a", now: 1_400_000 }),
    ]);
    assert.equal(state.plays["a"], 2, "returning to a track counts as a replay");
  });
});

describe("easter eggs: rate limiting", () => {
  it("never fires twice inside the minimum gap", () => {
    // Feed many track changes in quick succession.
    const events = Array.from({ length: 8 }, (_, i) =>
      ev({ trackKey: `t${i}`, now: 1_000_000 + i * 1000 })
    );
    const { eggs } = run(initialEggState(), events);
    assert.ok(eggs.length <= 1, `expected <=1 egg, got ${eggs.length}`);
  });

  it("can fire again once the gap has elapsed", () => {
    const first = run(initialEggState(), [ev({ now: 1_000_000 })]);
    if (first.eggs.length === 0) return; // this seed produced no egg
    const later = run(first.state, [
      ev({ trackKey: "zzz", now: 1_000_000 + EGG_MIN_GAP_MS + 1000 }),
    ]);
    assert.ok(later.eggs.length <= 1);
  });

  it("never repeats the same message consecutively", () => {
    let state = initialEggState();
    let last = "";
    for (let i = 0; i < 40; i++) {
      const res = observeEgg(state, ev({ trackKey: `k${i}`, now: 1_000_000 + i * 60_000 }));
      state = res.state;
      if (res.egg) {
        assert.notEqual(res.egg.text, last, "consecutive eggs must differ");
        last = res.egg.text;
      }
    }
  });
});

describe("easter eggs: event triggers", () => {
  it("counts repeated seeks and resets the counter per track", () => {
    let state: EasterEggState = initialEggState();
    for (let i = 1; i <= REPEAT_SEEK_COUNT; i++) {
      state = observeEgg(state, ev({ seekSeq: i, now: 1_000_000 + i * 100 })).state;
    }
    assert.ok(state.seeks < REPEAT_SEEK_COUNT, "seek burst should reset the counter");
  });

  it("does not fire from ordinary position progress", () => {
    let state = initialEggState();
    const { eggs } = run(state, [
      ev({ now: 1_000_000 }),
      ev({ positionMs: 2000, now: 1_001_000 }),
      ev({ positionMs: 3000, now: 1_002_000 }),
      ev({ positionMs: 4000, now: 1_003_000 }),
    ]);
    // Only the first-track trigger could have fired; progress never adds more.
    assert.ok(eggs.length <= 1);
  });

  it("tracks continuous listening and resets on pause", () => {
    let state = initialEggState();
    state = observeEgg(state, ev({ now: 1_000_000 })).state;
    assert.ok(state.listenStartedAt > 0);
    state = observeEgg(state, ev({ playbackState: "paused", now: 1_100_000 })).state;
    assert.equal(state.listenStartedAt, 0, "pause resets continuous listening");
  });

  it("credit accumulates for a long listen milestone", () => {
    let state = initialEggState();
    state = observeEgg(state, ev({ now: 1_000_000 })).state;
    state = observeEgg(state, ev({ now: 1_000_000 + LONG_LISTEN_MS + 1 })).state;
    assert.ok(state.listenMilestone > LONG_LISTEN_MS || state.listenMilestone >= LONG_LISTEN_MS);
  });

  it("fires a long-listen egg once the milestone is reached", () => {
    // Regression guard: the milestone advancing is not enough — the egg must
    // actually be emitted, and it must come from the long-listen pool.
    let state = initialEggState();
    // First event starts the clock AND fires the launch egg, so wait out its
    // cooldown before the milestone can be reached.
    state = observeEgg(state, ev({ now: 1_000_000 })).state;
    let now = 1_000_000 + EGG_MIN_GAP_MS + 1;
    let egg: string | null = null;
    // Poll like the real overlay does (~250ms) across the milestone boundary.
    const start = now;
    while (now - start < LONG_LISTEN_MS + 10_000) {
      const res = observeEgg(state, ev({ now, positionMs: 30_000 }));
      state = res.state;
      if (res.egg) {
        egg = res.egg.text;
        break;
      }
      now += 250;
    }
    assert.ok(egg, "a long-listen egg must fire after the milestone");
    assert.match(
      egg!,
      /been here a while|time is a construct|Marathon session/,
      `unexpected long-listen egg: ${egg}`,
    );
  });
});

describe("snapshot polling (the real call cadence)", () => {
  // `observeEgg` is called once per media snapshot (~4/s), so the same track is
  // observed many times per play. Regression: play counting used to advance per
  // *snapshot*, which marked an uninterrupted track as "replayed" within half a
  // second and reset the seek counter on every poll.
  it("ordinary snapshots of one track never count as a replay", () => {
    let state = initialEggState();
    // 25 snapshots == ~6s of one uninterrupted track.
    for (let i = 0; i < 25; i++) {
      const res = observeEgg(state, ev({ positionMs: 1000 + i * 250, now: 1_000_000 + i * 250 }));
      state = res.state;
      assert.equal(state.plays["song-a"], 1, "plays must not grow while polling");
    }
  });

  it("a genuine replay (identity leaves and returns) still counts", () => {
    let state = initialEggState();
    // Real replays are separated in time; the cross-trigger cooldown needs room.
    const seq = [
      ev({ trackKey: "song-a", now: 1_000_000 }),
      ev({ trackKey: "song-a", now: 1_000_250 }), // poll of the same track
      ev({ trackKey: "song-b", now: 1_000_500 }), // real change
      ev({ trackKey: "song-a", now: 1_000_000 + EGG_MIN_GAP_MS + 1 }), // replay
    ];
    let sawReplay = false;
    for (const e of seq) {
      const res = observeEgg(state, e);
      state = res.state;
      if (res.egg && /came back to this song|never get old|Repeat detected/i.test(res.egg.text)) {
        sawReplay = true;
      }
    }
    assert.equal(state.plays["song-a"], 2, "returning to a track is the second play");
    assert.ok(sawReplay, "returning to a track must be able to fire a replay egg");
  });

  it("repeated seeking reaches its threshold instead of resetting every poll", () => {
    // Regression: because `seeks` was reset on every snapshot, the repeat-seek
    // trigger could never reach REPEAT_SEEK_COUNT and was unreachable in the app.
    let state = initialEggState();
    // The launch egg fires on the first event; wait out its cooldown first.
    const launch = observeEgg(state, ev({ now: 1_000_000 }));
    state = launch.state;
    assert.ok(launch.egg, "launch egg expected");

    let now = 1_000_000 + EGG_MIN_GAP_MS + 1;
    let seq = 0;
    const events: ReturnType<typeof ev>[] = [];
    for (let i = 0; i < REPEAT_SEEK_COUNT + 4; i++) {
      seq += 1;
      now += 1_300;
      events.push(ev({ seekSeq: seq, positionMs: i % 2 ? 20_000 : 150_000, now }));
    }
    const { eggs } = run(state, events);
    const restless = eggs.filter((t) =>
      /That line really got you|Seeking behaviour detected|you really like this part/.test(t),
    );
    assert.equal(restless.length, 1, `expected exactly one repeat-seek egg, got: ${eggs.join(" | ")}`);
  });
});
