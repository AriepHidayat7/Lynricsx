import { useState } from "react";
import { Note, OptionCards, Row, Segmented, Slider, Toggle } from "./controls";
import SettingsNav, { type SettingsCategory } from "./SettingsNav";
import type {
  AppInfo,
  CacheInfo,
  CursorStyle,
  Settings,
  Theme,
} from "../types";
import {
  MAX_HISTORY_LINES,
  MIN_HISTORY_LINES,
  historyLinesOf,
  historyPatch,
} from "../lib/history";
import { PAST_OPTIONS } from "../lib/pastLyrics";

/**
 * Friendly rendering of an application data path.
 *
 * The Tauri bundle identifier (`com.redlyrics.app`) is deliberately preserved for
 * backward compatibility with existing installs, but it is an internal detail:
 * showing it verbatim in the About page leaks the old product name to users.
 * Collapse the `<AppData>/<bundle id>` segment to a stable token while keeping the
 * user-meaningful tail. The untouched absolute path is exposed as a tooltip.
 */
function prettyPath(full: string): string {
  const id = "com.redlyrics.app";
  const i = full.indexOf(id);
  if (i === -1) return full;
  // Decide the root from the segment immediately before the identifier.
  const root = /\\Local\\$/.test(full.slice(0, i)) ? "Local" : "Roaming";
  const tail = full.slice(i + id.length).replace(/^[\\/]+/, "");
  return `${root}${tail ? "\\" + tail : ""}`;
}

/**
 * Appearance presets: the overlay's overall visual identity.
 *
 * `swatch` is a tiny inline sample of the preset's own CSS variables (the exact
 * hex values from `styles/overlay.css`) so the card communicates its colours
 * without rendering a real preview surface. The colours here are chrome only —
 * they never describe the per-track syntax palette.
 */
const THEMES: {
  value: Theme;
  label: string;
  caption: string;
  swatch: string[];
}[] = [
  {
    value: "terminal",
    label: "TERMINAL RED",
    caption: "graphite · red accents",
    swatch: ["#141417", "#1a1a1f", "#ff3b3b", "#7a7681"],
  },
  {
    value: "cyberpunk",
    label: "CYBERPUNK",
    caption: "violet · cyan + magenta",
    swatch: ["#0d0918", "#150f26", "#35e3ff", "#ff2fd0"],
  },
  {
    value: "minimal",
    label: "MINIMAL",
    caption: "charcoal · muted grey",
    swatch: ["#1b1b1c", "#1e1e1f", "#9a9a9e", "#6f6f72"],
  },
];

/** Typewriter caret shapes. All six are implemented in `overlay.css`. */
const CURSOR_OPTIONS: { value: CursorStyle; label: string }[] = [
  { value: "block", label: "BLOCK" },
  { value: "line", label: "LINE" },
  { value: "underline", label: "UNDER" },
  { value: "bar", label: "BAR" },
  { value: "hollow", label: "HOLLOW" },
  { value: "none", label: "OFF" },
];

export interface SettingsPanelProps {
  settings: Settings;
  /** Applies a partial update. */
  patch: (p: Partial<Settings>) => void;
  /**
   * Toggles the native "start with Windows" registration. This goes through the
   * per-user Run registry key, so it cannot be a plain settings patch.
   */
  onStartWithWindows: (enabled: boolean) => void | Promise<void>;
  /** Live lyric engine state, shown as read-only information under Lyrics. */
  lyricsInfo?: React.ReactNode;
  /** Cache statistics for the Advanced footer. */
  cache: CacheInfo | null;
  onClearCache: () => void;
  /** Build/runtime information for the About page. */
  appInfo: AppInfo | null;
}

/** Section heading + one-line description, shared by every category. */
function CategoryHead({ title, desc }: { title: string; desc: string }) {
  return (
    <header className="set-head">
      <h2>{title}</h2>
      <p>{desc}</p>
    </header>
  );
}

/** Human-readable byte size; kept local so the panel needs no extra dependency. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}


export default function SettingsPanel({
  settings,
  patch,
  onStartWithWindows,
  lyricsInfo,
  cache,
  onClearCache,
  appInfo,
}: SettingsPanelProps) {
  const [category, setCategory] = useState<SettingsCategory>("general");
  const lines = historyLinesOf(settings);

  return (
    <div className="set-shell">
      <SettingsNav active={category} onSelect={setCategory} />

      <div className="set-content" key={category}>
        {category === "general" && (
          <>
            <CategoryHead
              title="General"
              desc="How the lyrics overlay behaves on your desktop."
            />
            <div className="set-group">
              <Row label="Overlay visibility" hint="show the lyrics overlay">
                <Toggle
                  checked={settings.overlayVisible}
                  onChange={(v) => patch({ overlayVisible: v })}
                />
              </Row>
              <Row label="Always on top" hint="keep it above other windows">
                <Toggle
                  checked={settings.alwaysOnTop}
                  onChange={(v) => patch({ alwaysOnTop: v })}
                />
              </Row>
              <Row label="Lock position" hint="prevent the overlay from being dragged">
                <Toggle
                  checked={settings.lockPosition}
                  onChange={(v) => patch({ lockPosition: v })}
                />
              </Row>
            </div>
          </>
        )}

        {category === "appearance" && (
          <>
            <CategoryHead
              title="Appearance"
              desc="The overlay's visual identity. Per-track syntax colours are chosen automatically and stay independent of these presets."
            />
            <div className="set-group">
              <div className="set-block">
                <div className="set-block-label">Theme preset</div>
                <OptionCards
                  options={THEMES}
                  value={settings.theme}
                  onChange={(v) => patch({ theme: v })}
                />
              </div>
              <Row label="Font size" hint={`${settings.fontSize}px in the overlay`}>
                <Slider
                  min={12}
                  max={34}
                  step={1}
                  value={settings.fontSize}
                  onChange={(v) => patch({ fontSize: v })}
                  format={(v) => `${v}px`}
                />
              </Row>
              <Row
                label="Past lyric fade"
                hint="how already-sung lines recede behind the active one"
              >
                <Segmented
                  options={PAST_OPTIONS}
                  value={settings.completedWordColor}
                  onChange={(v) => patch({ completedWordColor: v })}
                />
              </Row>
            </div>
            <Note>
              Themes restyle the editor chrome only. Each track still picks its own
              syntax palette, so a song can run GitHub Dark under Terminal Red.
            </Note>
          </>
        )}

        {category === "lyrics" && (
          <>
            <CategoryHead
              title="Lyrics"
              desc="How much lyric history is visible and how the typewriter caret is drawn."
            />
            <div className="set-group">
              <Row
                label="Lyric history"
                hint="lines kept visible, active line included"
              >
                <Slider
                  min={MIN_HISTORY_LINES}
                  max={MAX_HISTORY_LINES}
                  step={1}
                  value={lines}
                  onChange={(v) => patch(historyPatch(v))}
                  format={(v) => `${v} ${v === 1 ? "line" : "lines"}`}
                />
              </Row>
              <Row label="Cursor style" hint="shape of the typing caret">
                <Segmented
                  options={CURSOR_OPTIONS}
                  value={settings.cursorStyle}
                  onChange={(v) => patch({ cursorStyle: v })}
                />
              </Row>
            </div>

            {lyricsInfo && (
              <div className="set-group">
                <div className="set-block-label">Synchronization</div>
                {lyricsInfo}
              </div>
            )}
            <Note>
              Character, Word and Syllable sync are chosen automatically from the
              provider's timestamps. Typewriter reveal is always on.
            </Note>
          </>
        )}

        {category === "advanced" && (
          <>
            <CategoryHead
              title="Advanced"
              desc="System integration and terminal presentation."
            />
            <div className="set-group">
              <Row label="Show music player" hint="player name in the overlay header">
                <Toggle
                  checked={settings.showTrackSource}
                  onChange={(v) => patch({ showTrackSource: v })}
                />
              </Row>
              <Row label="Start with Windows" hint="launch at sign-in">
                <Toggle
                  checked={settings.startWithWindows}
                  onChange={(v) => void onStartWithWindows(v)}
                />
              </Row>
              <Row label="Terminal effects" hint="boot sequence and stage messages">
                <Toggle
                  checked={settings.terminalEffects}
                  onChange={(v) => patch({ terminalEffects: v })}
                />
              </Row>
              <Row label="Terminal activity" hint="compact event log in the overlay">
                <Toggle
                  checked={settings.showTerminalActivity}
                  onChange={(v) => patch({ showTerminalActivity: v })}
                />
              </Row>
            </div>

            <div className="set-group">
              <Row label="Lyrics cache" hint="cached provider responses">
                <span className="set-inline">
                  <span className="set-value">
                    {cache ? `${cache.entries} · ${formatBytes(cache.bytes)}` : "…"}
                  </span>
                  <button className="btn" onClick={onClearCache}>
                    CLEAR
                  </button>
                </span>
              </Row>
            </div>
            <Note>
              Clearing the cache only forces fresh provider lookups; your settings
              are untouched.
            </Note>
          </>
        )}


        {category === "about" && (
          <>
            <CategoryHead title="About" desc="Build and runtime information." />
            <div className="set-about">
              <div className="set-logo" aria-hidden="true">
                {"</>"}
              </div>
              <div className="set-about-name">{appInfo?.name ?? "Lynricsx"}</div>
              <div className="set-about-version">
                version {appInfo?.version ?? "—"}
              </div>
            </div>
            <div className="set-group">
              <div className="set-kv">
                <span className="set-k">Runtime</span>
                <span className="set-v">Tauri {appInfo?.tauriVersion ?? "—"}</span>
              </div>
              <div className="set-kv">
                <span className="set-k">Target</span>
                <span className="set-v">{appInfo?.target ?? "—"}</span>
              </div>
              <div className="set-kv">
                <span className="set-k">Lyric provider</span>
                <span className="set-v">{appInfo?.provider ?? "—"}</span>
              </div>
              <div className="set-kv">
                <span className="set-k">Settings</span>
                <span className="set-v path" title={appInfo?.settingsPath ?? undefined}>
                  {appInfo?.settingsPath ? prettyPath(appInfo.settingsPath) : "—"}
                </span>
              </div>
              <div className="set-kv">
                <span className="set-k">Cache</span>
                <span className="set-v path" title={appInfo?.cachePath ?? undefined}>
                  {appInfo?.cachePath ? prettyPath(appInfo.cachePath) : "—"}
                </span>
              </div>
            </div>
            <Note>
              Lyrics from LiriQo and LRCLIB. Playback control through the Windows
              media session — no Spotify account or API key is used.
            </Note>
          </>
        )}
      </div>
    </div>
  );
}
