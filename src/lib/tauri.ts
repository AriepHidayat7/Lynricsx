
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  AutostartInfo,
  CacheInfo,
  LyricContext,
  LyricsStatusEvent,
  OverlaySettings,
  PositionInput,
  Settings,
  TrackSnapshot,
  TransportResult,
} from "../types";

/**
 * Projects the full `Settings` returned by `get_settings` onto the narrower shape
 * the overlay renders.
 *
 * The backend's `overlay:settings` event already carries exactly these fields, so
 * this exists only so the overlay can bootstrap from the persisted settings
 * without subscribing first. Keep it in step with the payload built in
 * `emit_overlay_settings` (`src-tauri/src/lib.rs`); both lists are 11 fields.
 */
export function overlaySettingsOf(s: Settings): OverlaySettings {
  return {
    fontSize: s.fontSize,
    theme: s.theme,
    typewriter: s.typewriter,
    cursorStyle: s.cursorStyle,
    historyLines: s.historyLines,
    showTrackSource: s.showTrackSource,
    lockPosition: s.lockPosition,
    completedWordColor: s.completedWordColor,
    terminalEffects: s.terminalEffects,
    showTerminalActivity: s.showTerminalActivity,
    easterEggs: s.easterEggs,
  };
}


export const api = {
  getTrack: () => invoke<TrackSnapshot>("get_track"),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings>) =>
    invoke<Settings>("update_settings", { patch }),
  setOverlayVisible: (visible: boolean) =>
    invoke<void>("set_overlay_visible", { visible }),
  /** Moves the native lyrics overlay to logical screen coordinates. */
  setPosition: (x: number, y: number) =>
    invoke<void>("set_position", { x, y }),
  /** Current position of the native lyrics overlay, in logical coordinates. */
  getPosition: () => invoke<PositionInput>("get_position"),
  getCacheInfo: () => invoke<CacheInfo>("get_cache_info"),
  clearCache: () => invoke<CacheInfo>("clear_cache"),
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  getAutostart: () => invoke<AutostartInfo>("get_autostart"),
  setAutostart: (enabled: boolean) =>
    invoke<AutostartInfo>("set_autostart", { enabled }),
  refreshLyrics: () => invoke<void>("refresh_lyrics"),
  /**
   * Drives the active media session via Windows GSMTC.
   *
   * Resolves with the playback state read back *after* the action, so callers
   * reconcile against reality rather than optimistic frontend state.
   */
  mediaTransport: (action: "play" | "pause" | "toggle" | "next" | "previous") =>
    invoke<TransportResult>("media_transport", { action }),
  /**
   * Seeks the active media session to `positionMs`.
   *
   * Used by click-a-lyric and the mini progress bar. The backend clamps the
   * position to the session's own timeline, so an out-of-range target cannot
   * overshoot the track.
   */
  mediaSeek: (positionMs: number) =>
    invoke<TransportResult>("media_seek", { positionMs }),
};

function subscribe<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

export const events = {
  onMediaTrack: (cb: (t: TrackSnapshot) => void) =>
    subscribe<TrackSnapshot>("media:track", cb),
  onLyricsContext: (cb: (c: LyricContext) => void) =>
    subscribe<LyricContext>("lyrics:context", cb),
  onLyricsStatus: (cb: (s: LyricsStatusEvent) => void) =>
    subscribe<LyricsStatusEvent>("lyrics:status", cb),
  onOverlaySettings: (cb: (s: OverlaySettings) => void) =>
    subscribe<OverlaySettings>("overlay:settings", cb),
  /**
   * Fires when the native overlay window moves (drag). No Settings UI control
   * consumes it any more, but the Rust side still emits it, so the subscription
   * remains available for future use.
   */
  onOverlayPosition: (cb: (p: PositionInput) => void) =>
    subscribe<PositionInput>("overlay:position", cb),
};
