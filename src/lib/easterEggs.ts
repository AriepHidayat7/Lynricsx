// Cosmetic terminal asides.
//
// These are flavour text, NOT diagnostics: they are never presented as real
// debug output and never imply an operation happened. Selection is deterministic
// from a track seed, and a hard cap keeps them from appearing on every track.

import type { Tag } from "./terminal";

export interface EasterEgg {
  tag: Tag;
  text: string;
}

/** Curated collection. All short enough for one terminal line. */
export const EASTER_EGGS: EasterEgg[] = [
  { tag: "COMMENT", text: "another song, another memory." },
  { tag: "COMMENT", text: "this one hits differently." },
  { tag: "COMMENT", text: "and there it is." },
  { tag: "COMMENT", text: "same song, different day." },
  { tag: "DEBUG", text: "Emotional damage detected." },
  { tag: "INFO", text: "Preparing your next track..." },
  { tag: "PROCESS", text: "Loading another memory..." },
  { tag: "SUCCESS", text: "Your soundtrack is ready." },
  { tag: "COMMENT", text: "keep this one." },
  { tag: "COMMENT", text: "volume up. obviously." },
];

/** Triggers that can surface an egg. Each is driven by a real app event. */
export type EggTrigger =
  | "first-track" // the first track after launch
  | "track-change" // an ordinary track transition
  | "replay" // the same track started again
  | "long-listen" // continuous listening milestone
  | "completed" // a track reached its end
  | "repeat-seek"; // several seeks in a short window

export interface EasterEggState {
  /** Number of track changes observed so far. */
  tracks: number;
  /** Seed of the last egg shown, to avoid immediate repeats. */
  lastText: string;
  /** Track keys seen with counts, for replay detection (bounded). */
  plays: Record<string, number>;
  /**
   * Track identity observed on the previous event (`""` before the first one).
   * `observeEgg` runs once per media snapshot (~4/s), so this is what lets it
   * distinguish a genuine track change from ordinary polling of the same track.
   */
  currentKey: string;
  /** Wall-clock time the current continuous listen began, 0 when idle. */
  listenStartedAt: number;
  /** Seek counter observed last, and how many seek bursts already fired. */
  lastSeekSeq: number;
  seeks: number;
  /** True once the first-track egg has had its chance. */
  firstDone: boolean;
  /** Listening milestone (in ms) that triggers a "long listen" egg. */
  listenMilestone: number;
  /** Wall-clock time of the last egg shown, for cross-trigger rate limiting. */
  lastEggAt: number;
}

export function initialEggState(): EasterEggState {
  return {
    tracks: 0,
    lastText: "",
    plays: {},
    currentKey: "",
    listenStartedAt: 0,
    lastSeekSeq: 0,
    seeks: 0,
    firstDone: false,
    listenMilestone: 0,
    lastEggAt: 0,
  };
}

/** Continuous listening before a "long listen" egg may appear (25 minutes). */
export const LONG_LISTEN_MS = 25 * 60 * 1000;

/** Seeks within one track before a "restless" egg may appear. */
export const REPEAT_SEEK_COUNT = 6;

/** Maximum track keys remembered for replay detection. */
const MAX_PLAYS = 40;

/** Deterministic pseudo-random index from an integer seed. */
function indexFrom(seed: number, modulo: number): number {
  // Simple integer mixing; deterministic across platforms.
  let x = Math.abs(Math.trunc(seed)) || 1;
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return Math.abs(x) % modulo;
}

/** Picks an egg, never repeating the previous message. */
function pickEgg(
  state: EasterEggState,
  seed: number,
  pool: EasterEgg[],
): EasterEgg | null {
  if (pool.length === 0) return null;
  let idx = indexFrom(seed, pool.length);
  let guard = 0;
  while (pool[idx].text === state.lastText && guard < pool.length) {
    idx = (idx + 1) % pool.length;
    guard++;
  }
  return pool[idx];
}

/** Trigger-specific pools, so a message fits the moment that produced it. */
export const EGGS_BY_TRIGGER: Record<EggTrigger, EasterEgg[]> = {
  "first-track": [
    { tag: "COMMENT", text: "first one of the session. good choice." },
    { tag: "SUCCESS", text: "Session started. Let's listen." },
    { tag: "COMMENT", text: "and so it begins." },
  ],
  "track-change": EASTER_EGGS,
  replay: [
    { tag: "COMMENT", text: "You came back to this song again." },
    { tag: "COMMENT", text: "Some lines never get old." },
    { tag: "DEBUG", text: "Repeat detected. Emotional damage confirmed." },
    { tag: "COMMENT", text: "same song, different day." },
  ],
  "long-listen": [
    { tag: "INFO", text: "You've been here a while. Still going." },
    { tag: "COMMENT", text: "time is a construct. play the next one." },
    { tag: "SUCCESS", text: "Marathon session in progress." },
  ],
  completed: [
    { tag: "SUCCESS", text: "Track complete. Nicely done." },
    { tag: "COMMENT", text: "another one down." },
  ],
  "repeat-seek": [
    { tag: "COMMENT", text: "That line really got you, huh." },
    { tag: "DEBUG", text: "Seeking behaviour detected. Relatable." },
    { tag: "COMMENT", text: "you really like this part." },
  ],
};

/** Minimum gap between eggs of any trigger, so they never cluster. */
export const EGG_MIN_GAP_MS = 45_000;

/**
 * Observes a real app event and decides whether to surface an egg.
 *
 * Every trigger is derived from a genuine event:
 *  - `track` identity change (first track, replay, ordinary change),
 *  - the worker's seek counter advancing,
 *  - playback reaching the end of the track,
 *  - continuous listening time while playing.
 *
 * Returns the next state and an optional egg. Eggs never fire more than once
 * per `EGG_MIN_GAP_MS`, and never twice in a row with the same text.
 */
export function observeEgg(
  state: EasterEggState,
  ev: {
    trackKey: string;
    title: string;
    artist: string;
    playbackState: string;
    positionMs: number;
    durationMs: number;
    seekSeq: number;
    now: number;
  },
): { egg: EasterEgg | null; state: EasterEggState } {
  let next = state;
  let trigger: EggTrigger | null = null;
  const seedBase =
    ev.title.length * 31 + ev.artist.length * 17 + ev.trackKey.length;

  // --- Track identity -----------------------------------------------------
  // `observeEgg` is called for EVERY media snapshot (~4 per second), so the
  // trigger must only fire when the identity actually changes. Counting plays
  // per snapshot would mark a single uninterrupted track as "replayed" within
  // half a second, which also reset the seek counter on every poll and made the
  // repeat-seek trigger unreachable.
  if (ev.trackKey && ev.trackKey !== next.currentKey) {
    const plays = { ...next.plays };
    const isNew = !(ev.trackKey in plays);

    if (isNew) {
      // Bound memory: drop the oldest key once the map is full.
      const keys = Object.keys(plays);
      if (keys.length >= MAX_PLAYS) delete plays[keys[0]];
      plays[ev.trackKey] = 1;
      trigger = !next.firstDone ? "first-track" : "track-change";
    } else {
      plays[ev.trackKey] += 1;
      // A replay only counts from the second play onwards.
      trigger = "replay";
    }
    // A new identity starts a fresh seek run; keep counting within a track.
    next = { ...next, currentKey: ev.trackKey, firstDone: true, seeks: 0, plays };
    next = { ...next, tracks: next.tracks + (isNew ? 1 : 0) };
  }

  // --- Completion ---------------------------------------------------------
  const dur = ev.durationMs;
  if (
    !trigger &&
    dur > 0 &&
    ev.positionMs >= dur - 1500 &&
    ev.playbackState === "playing"
  ) {
    trigger = "completed";
  }

  // --- Repeated seeking ---------------------------------------------------
  if (ev.seekSeq !== next.lastSeekSeq) {
    const seeks = next.seeks + 1;
    next = { ...next, lastSeekSeq: ev.seekSeq, seeks };
    if (!trigger && seeks >= REPEAT_SEEK_COUNT) {
      trigger = "repeat-seek";
      next = { ...next, seeks: 0 };
    }
  }

  // --- Continuous listening ----------------------------------------------
  if (ev.playbackState === "playing") {
    if (!next.listenStartedAt) {
      next = { ...next, listenStartedAt: ev.now, listenMilestone: LONG_LISTEN_MS };
    } else if (
      !trigger &&
      ev.now - next.listenStartedAt >= next.listenMilestone
    ) {
      trigger = "long-listen";
      next = { ...next, listenMilestone: next.listenMilestone + LONG_LISTEN_MS };
    }
  } else if (next.listenStartedAt) {
    // Pausing resets continuous-listening credit.
    next = { ...next, listenStartedAt: 0, listenMilestone: LONG_LISTEN_MS };
  }

  if (!trigger) return { egg: null, state: next };

  // Rate limit across all triggers.
  if (next.lastEggAt && ev.now - next.lastEggAt < EGG_MIN_GAP_MS) {
    return { egg: null, state: next };
  }

  const egg = pickEgg(next, seedBase + next.tracks + ev.seekSeq, EGGS_BY_TRIGGER[trigger]);
  if (!egg) return { egg: null, state: next };
  return { egg, state: { ...next, lastText: egg.text, lastEggAt: ev.now } };
}
