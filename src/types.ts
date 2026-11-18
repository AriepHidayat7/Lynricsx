// Shared frontend types. These mirror the Rust structs serialized with
// `#[serde(rename_all = "camelCase")]`.

export type PlaybackState =
  | "closed"
  | "opened"
  | "changing"
  | "stopped"
  | "playing"
  | "paused";

/** Result of a playback control action (see `media_transport`). */
export interface TransportResult {
  ok: boolean;
  /** Playback state read back from the session after the action. */
  state: PlaybackState;
  error: string | null;
}

export type Theme = "terminal" | "cyberpunk" | "minimal";
export type Anchor = "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "custom";

export interface TrackSnapshot {
  hasSession: boolean;
  title: string;
  artist: string;
  album: string;
  sourceAppId: string;
  sourceAppName: string;
  playbackState: PlaybackState;
  positionMs: number;
  durationMs: number;
  sampledAtMs: number;
  /** Bumped by the backend on each observed seek (0 when unavailable). */
  seekSeq?: number;
  /** Bumped by the backend on each observed track change. */
  trackSeq?: number;
}

export interface TimedWord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LyricLine {
  startMs: number;
  endMs: number;
  text: string;
  words?: TimedWord[];
}

export interface LyricContext {
  lines: LyricLine[];
  synced: boolean;
  wordSynced: boolean;
  wordGranularity: string;
  instrumental: boolean;
  source: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
}

export interface LyricsStatusEvent {
  state: string;
  message: string;
  synced: boolean;
  wordSynced: boolean;
  granularity: string;
  instrumental: boolean;
  source: string;
  lineCount: number;
  trackKey: string;
}

export interface Settings {
  overlayVisible: boolean;
  overlayX: number;
  overlayY: number;
  overlayWidth: number;
  overlayHeight: number;
  anchor: Anchor;
  fontSize: number;
  theme: Theme;
  typewriter: boolean;
  alwaysOnTop: boolean;
  linesBefore: number;
  linesAfter: number;
  startWithWindows: boolean;
  showTrackSource: boolean;
  lockPosition: boolean;
  /** Visible lyric lines in the overlay, active line included. 1..=20. */
  historyLines: number;
  cursorStyle: CursorStyle;
  completedWordColor: CompletedWordColor;
  /** Live-code terminal experience (boot sequence, stage messages). */
  terminalEffects: boolean;
  /** Show the compact terminal activity log in the overlay. */
  showTerminalActivity: boolean;
  /** Occasional cosmetic aside messages. */
  easterEggs: boolean;
}

/**
 * Typewriter caret. "none" hides the caret but keeps the typewriter reveal
 * running; it never disables progressive reveal.
 */
export type CursorStyle =
  | "block"
  | "line"
  | "underline"
  | "bar"
  | "hollow"
  | "none";

/**
 * How lyrics that have already been sung are rendered.
 *
 * Only opacity/brightness change - the per-track syntax palette always keeps
 * ownership of the hue, so this can never override unrelated syntax tokens.
 */
export type CompletedWordColor = "muted" | "dim" | "accent";

export interface OverlaySettings {
  fontSize: number;
  theme: Theme;
  typewriter: boolean;
  cursorStyle: CursorStyle;
  /** Visible lyric lines, active line included. */
  historyLines: number;
  showTrackSource: boolean;
  lockPosition: boolean;
  completedWordColor: CompletedWordColor;
  terminalEffects: boolean;
  showTerminalActivity: boolean;
  easterEggs: boolean;
}

export interface CacheInfo {
  entries: number;
  bytes: number;
  path: string;
}

export interface AutostartInfo {
  enabled: boolean;
  method: string;
  supported: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  target: string;
  provider: string;
  cachePath: string;
  settingsPath: string;
}

export interface PositionInput {
  x: number;
  y: number;
}

export const EMPTY_TRACK: TrackSnapshot = {
  hasSession: false,
  title: "",
  artist: "",
  album: "",
  sourceAppId: "",
  sourceAppName: "",
  playbackState: "closed",
  positionMs: 0,
  durationMs: 0,
  sampledAtMs: 0,
};

export const EMPTY_CONTEXT: LyricContext = {
  lines: [],
  synced: false,
  wordSynced: false,
  wordGranularity: "",
  instrumental: false,
  source: "",
  title: "",
  artist: "",
  album: "",
  durationMs: 0,
};
