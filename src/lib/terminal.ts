// Terminal presentation state machine.
//
// This is a *presentation* layer only. It derives what the terminal shows from
// real application events (track snapshots, lyrics status events). It never
// drives playback, lyric fetching, or synchronization, and it never fakes an
// operation that did not happen.
//
// Everything here is pure so the whole experience can be unit tested without a
// window.

import type { LyricsStatusEvent, TrackSnapshot } from "../types";

/** Terminal message severity, mapped to a colour by the view. */
export type Tone = "init" | "info" | "process" | "success" | "warning" | "error";

/** A short tag rendered before a message, e.g. `[FETCH]`. */
export type Tag =
  | "INIT"
  | "INFO"
  | "SEARCH"
  | "QUERY"
  | "FETCH"
  | "CACHE"
  | "PROCESS"
  | "SUCCESS"
  | "READY"
  | "WARN"
  | "ERROR"
  | "EXEC"
  | "PAUSE"
  | "SEEK"
  | "LOAD"
  | "STOP"
  | "DEBUG"
  | "COMMENT";

export interface TerminalLine {
  /** Monotonic id so React keys are stable. */
  id: number;
  tag: Tag;
  tone: Tone;
  text: string;
  /** Wall-clock time of the event, epoch ms. */
  at: number;
}

/** Coarse phase of the live-code experience. */
export type Phase =
  | "booting"
  | "idle"
  | "detecting"
  | "searching"
  | "fetching"
  | "processing"
  | "ready"
  | "playing"
  | "paused"
  | "disconnected"
  | "error";

export const TONE_BY_TAG: Record<Tag, Tone> = {
  INIT: "init",
  INFO: "info",
  SEARCH: "process",
  QUERY: "process",
  FETCH: "process",
  CACHE: "process",
  PROCESS: "process",
  SUCCESS: "success",
  READY: "success",
  WARN: "warning",
  ERROR: "error",
  EXEC: "success",
  PAUSE: "warning",
  SEEK: "info",
  LOAD: "info",
  STOP: "warning",
  DEBUG: "info",
  COMMENT: "info",
};

/** Maximum lines retained; older entries are dropped (bounded memory). */
export const MAX_LOG_LINES = 9;

/**
 * A virtual terminal session, one per track.
 *
 * Purely presentational: it tracks which track the log currently describes and
 * how many sessions have been opened, so the view can show a session banner and
 * close/archive the previous one on a track change. It never influences
 * playback, lyric fetching or synchronization.
 */
export interface TerminalSession {
  /** Sequential session number, starting at 1. */
  id: number;
  /** Track key this session belongs to (empty before any track). */
  trackKey: string;
  /** `Artist — Title` for the banner. */
  label: string;
  /** Archived sessions (most recent last), bounded. */
  archived: number;
}

export interface TerminalState {
  phase: Phase;
  /** Recent messages, newest last. Bounded by `MAX_LOG_LINES`. */
  log: TerminalLine[];
  /** Incremented for every line added, used to generate ids. */
  seq: number;
  /** True once the boot sequence has finished. */
  booted: boolean;
  /** Track key the current lyric state belongs to. */
  trackKey: string;
  /** Track key the most recent lyrics-status event belonged to ("" = none yet). */
  statusKey: string;
  /** Last observed seek counter, to detect a real seek exactly once. */
  seekSeq: number;
  /** Last observed playback position, used to infer seek direction. */
  lastPositionMs: number;
  /** Last observed track counter. */
  trackSeq: number;
  /** Last observed playback state, to detect real play/pause transitions. */
  lastPlayback: TrackSnapshot["playbackState"];
  /** Virtual session for the current track, if one is open. */
  session: TerminalSession | null;
}

export function initialTerminalState(): TerminalState {
  return {
    phase: "booting",
    log: [],
    seq: 0,
    booted: false,
    trackKey: "",
    statusKey: "",
    seekSeq: 0,
    lastPositionMs: 0,
    trackSeq: 0,
    lastPlayback: "closed",
    session: null,
  };
}

/**
 * Appends a line.
 *
 * Deduplication only suppresses *immediately repeated* identical messages
 * within a short window. Polling re-delivers the same snapshot many times per
 * second, so identical text must not stack up; but a genuinely new event that
 * happens to share wording (e.g. a second seek) must still be recorded.
 */
export function pushLine(
  state: TerminalState,
  tag: Tag,
  text: string,
  at: number = Date.now(),
): TerminalState {
  const last = state.log[state.log.length - 1];
  if (last && last.tag === tag && last.text === text && at - last.at < DEDUP_WINDOW_MS) {
    return state;
  }

  const line: TerminalLine = { id: state.seq, tag, tone: TONE_BY_TAG[tag], text, at };
  const log = [...state.log, line].slice(-MAX_LOG_LINES);
  return { ...state, log, seq: state.seq + 1 };
}

/** Window within which an identical repeated message is suppressed. */
export const DEDUP_WINDOW_MS = 400;

/** Lines for the boot sequence. Short and synchronous: no timers, no delay. */
export const BOOT_LINES: { tag: Tag; text: string }[] = [
  { tag: "INIT", text: "Loading core modules..." },
  { tag: "INIT", text: "Initializing lyric engine..." },
  { tag: "INIT", text: "Connecting to media session..." },
  { tag: "INIT", text: "Loading syntax themes..." },
  { tag: "INIT", text: "Initializing composition engine..." },
  { tag: "SUCCESS", text: "All systems operational." },
];

/** Appends the whole boot sequence in one step. */
export function runBoot(state: TerminalState, at: number = Date.now()): TerminalState {
  let next: TerminalState = { ...state, log: [] };
  for (const l of BOOT_LINES) next = pushLine(next, l.tag, l.text, at);
  next = pushLine(next, "INFO", "Waiting for media session...", at);
  return { ...next, booted: true, phase: "idle" };
}

/** `mm:ss` for terminal messages. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Stable identity for a snapshot, matching the Rust `track_key()`. */
export function trackKeyOf(
  t: Pick<TrackSnapshot, "hasSession" | "title" | "artist" | "album">,
): string {
  if (!t.hasSession || (!t.title && !t.artist)) return "";
  return `${t.title}\u0000${t.artist}\u0000${t.album}`.toLowerCase();
}

function label(provider: string): string {
  if (provider === "liriqo") return "LiriQo";
  if (provider === "lrclib") return "LRCLIB";
  return provider ? provider.toUpperCase() : "provider";
}

function statusPhase(s: LyricsStatusEvent): Phase {
  switch (s.state) {
    case "loading":
    case "provider_query":
      return "searching";
    case "cache_hit":
      return "fetching";
    case "media_ready":
      return "processing";
    case "processing":
      return "processing";
    case "ready":
      return "ready";
    case "provider_error":
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/**
 * Maps one real lyrics-status event to log lines.
 *
 * Every branch corresponds to an event the Rust backend actually emitted for a
 * real operation, so nothing here claims work that did not happen.
 */
export function applyLyricsStatus(
  state: TerminalState,
  s: LyricsStatusEvent,
  at: number = Date.now(),
): TerminalState {
  // Ignore statuses for a track we have already moved away from.
  if (s.trackKey && state.trackKey && s.trackKey !== state.trackKey) return state;

  let next: TerminalState = state;
  const provider = (s.source || "").toLowerCase();

  switch (s.state) {
    case "provider_query":
      next = pushLine(next, "QUERY", `Querying ${label(provider)}...`, at);
      break;
    case "cache_hit":
      next = pushLine(next, "CACHE", "Restoring cached lyrics...", at);
      break;
    case "media_ready":
      // The backend resolved a real media session; parsing starts after this.
      next = pushLine(next, "FETCH", "Retrieving synchronized lyrics...", at);
      next = pushLine(next, "PROCESS", "Parsing lyric timestamps...", at);
      break;
    case "provider_error":
      next = pushLine(next, "WARN", `${label(provider)} request failed.`, at);
      break;
    case "loading":
      next = pushLine(next, "SEARCH", "Searching lyric providers...", at);
      break;
    case "ready":
      if (s.lineCount > 0) {
        next = pushLine(next, "FETCH", "Retrieving synchronized lyrics...", at);
        next = pushLine(next, "PROCESS", "Parsing lyric timestamps...", at);
      }
      next = pushLine(next, "SUCCESS", "Lyrics loaded.", at);
      next = pushLine(next, "READY", "Synchronization active.", at);
      break;
    case "not_found":
      next = pushLine(next, "WARN", "Lyrics not found.", at);
      break;
    case "unsynced":
      next = pushLine(next, "WARN", "Plain lyrics only.", at);
      break;
    case "instrumental":
      next = pushLine(next, "INFO", "Instrumental track.", at);
      break;
    case "error":
      next = pushLine(next, "ERROR", "No lyrics available.", at);
      break;
    case "no_media":
      // Handled by the track pipeline (disconnected phase), not here.
      return state;
    default:
      return state;
  }

  return {
    ...next,
    phase: statusPhase(s),
    // Remember which track this status belongs to, so a slow load for an old
    // track can never pin a newer track's phase.
    statusKey: s.trackKey || next.trackKey,
  };
}

/**
 * Maps a real track snapshot to terminal events.
 *
 * Only *identity* changes and playback-state transitions produce messages, so
 * periodic position updates cannot spam the log.
 */
export function applyTrack(
  state: TerminalState,
  track: TrackSnapshot,
  fileName: string,
  at: number = Date.now(),
): TerminalState {
  let next = state;
  const key = trackKeyOf(track);

  if (!track.hasSession) {
    if (state.phase === "disconnected") return state;
    next = pushLine(next, "WARN", "Media session disconnected.", at);
    return { ...next, phase: "disconnected", trackKey: "", lastPlayback: track.playbackState };
  }

  // Real track change: a different identity than the one we are showing.
  if (key && key !== state.trackKey) {
    if (state.trackKey) {
      // Close the previous virtual session before opening the next one.
      next = pushLine(next, "INFO", "Closing current session...", at);
      next = pushLine(next, "INFO", "Releasing previous track context...", at);
    }
    const sessionLabel = [track.artist, track.title].filter(Boolean).join(" — ");
    next = pushLine(next, "INIT", "Initializing music session...", at);
    next = pushLine(next, "INFO", "Media session detected.", at);
    next = pushLine(next, "INFO", "Loading track metadata...", at);
    if (track.artist) next = pushLine(next, "INFO", `Artist: ${track.artist}`, at);
    if (track.title) next = pushLine(next, "INFO", `Track: ${track.title}`, at);
    next = pushLine(next, "INFO", `Reading metadata: ${fileName}`, at);
    next = {
      ...next,
      phase: "detecting",
      trackKey: key,
      seekSeq: track.seekSeq ?? state.seekSeq,
      trackSeq: track.trackSeq ?? state.trackSeq,
      lastPlayback: track.playbackState,
      // Seed the position from this snapshot: the next seek then reports a real
      // before/after pair instead of measuring from a stale or zero position.
      lastPositionMs: track.positionMs,
      session: {
        id: (state.session?.id ?? 0) + 1,
        trackKey: key,
        label: sessionLabel,
        archived: (state.session?.archived ?? 0) + (state.session ? 1 : 0),
      },
    };
    // A track can arrive already paused; report that state once so the user is
    // not left without feedback. Later transitions go through the normal path.
    if (track.playbackState === "paused") {
      next = pushLine(next, "PAUSE", "Execution suspended.", at);
    }
    return next;
  }

  // A seek the worker actually observed (its counter advanced). Direction and
  // both timestamps come from real snapshots, so the message is truthful.
  const seekSeq = track.seekSeq ?? 0;
  if (seekSeq !== state.seekSeq) {
    const backwards = track.positionMs < state.lastPositionMs;
    next = pushLine(
      next,
      "SEEK",
      `Position changed: ${formatMs(state.lastPositionMs)} → ${formatMs(track.positionMs)}`,
      at,
    );
    next = pushLine(next, "INFO", "Recalculating lyric position...", at);
    next = pushLine(
      next,
      "SEEK",
      backwards ? "Restoring previous position..." : "Jumping to timestamp...",
      at,
    );
    next = { ...next, seekSeq, lastPositionMs: track.positionMs };
  } else if (state.lastPositionMs !== track.positionMs) {
    next = { ...next, lastPositionMs: track.positionMs };
  }

  // Real playback-state transitions only.
  if (track.playbackState !== state.lastPlayback) {
    switch (track.playbackState) {
      case "playing":
        // "Resuming" only when we were paused; a fresh start is "Playback started".
        next = pushLine(
          next,
          "EXEC",
          state.lastPlayback === "paused" ? "Resuming session..." : "Playback started.",
          at,
        );
        break;
      case "paused":
        next = pushLine(next, "PAUSE", "Execution suspended.", at);
        break;
      case "stopped":
      case "closed":
        next = pushLine(next, "STOP", "Playback terminated.", at);
        break;
      default:
        break;
    }
    next = { ...next, lastPlayback: track.playbackState };
  }

  // Phase follows playback, but never overrides an in-flight lyric load for the
  // SAME track. A load still in flight for the previous track must not freeze a
  // brand-new track in "processing" forever: this snapshot wins, and the new
  // track's own status events take over from here.
  const statusForThisTrack = next.statusKey !== "" && next.statusKey === next.trackKey;
  const loading =
    statusForThisTrack &&
    (next.phase === "searching" || next.phase === "fetching" || next.phase === "processing");
  if (!loading) {
    if (track.playbackState === "playing") {
      next = { ...next, phase: "playing" };
    } else if (track.playbackState === "paused") {
      next = { ...next, phase: next.phase === "playing" ? "paused" : next.phase };
    }
  }

  return next;
}
