//! User settings, persisted as JSON in the app config directory.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::lyrics::lrc::LyricLine;
use crate::lyrics::LyricsResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreset {
    Terminal,
    Cyberpunk,
    Minimal,
}

impl Default for ThemePreset {
    fn default() -> Self {
        Self::Terminal
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Custom,
}

impl Default for Anchor {
    fn default() -> Self {
        Self::BottomLeft
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub overlay_visible: bool,
    pub overlay_x: i32,
    pub overlay_y: i32,
    pub overlay_width: u32,
    pub overlay_height: u32,
    pub anchor: Anchor,
    pub font_size: u32,
    pub theme: ThemePreset,
    pub typewriter: bool,
    /// Number of lyric lines kept visible in the overlay, active line included.
    /// 1..=20. This is the single source of truth for the history window.
    pub history_lines: u32,
    /// Typewriter cursor style: "block" | "line" | "underline" | "bar" |
    /// "hollow" | "none".
    pub cursor_style: String,
    /// Retired: the overlay always accepts mouse input now. Kept only so an
    /// older settings file containing `clickThrough` still deserializes; the
    /// value is ignored and forced to `false` by `sanitize`.
    #[serde(default)]
    pub click_through: bool,
    pub always_on_top: bool,
    /// Legacy context-line counts, retained so old settings files still load.
    /// Superseded by `history_lines`; kept in sync for backwards compatibility.
    pub lines_before: u32,
    pub lines_after: u32,
    pub start_with_windows: bool,
    pub show_track_source: bool,
    pub lock_position: bool,
    /// Live-code terminal experience: boot sequence and stage messages.
    pub terminal_effects: bool,
    /// Show the compact terminal activity log in the overlay.
    pub show_terminal_activity: bool,
    /// Occasional cosmetic aside messages.
    pub easter_eggs: bool,
    /// How already-sung ("past") lyrics are rendered: "muted" (palette
    /// colours dimmed), "dim" (palette colours, more muted) or "accent" (palette
    /// colours lifted). Only opacity/brightness change — the per-track syntax
    /// palette always keeps ownership of the hue.
    pub completed_word_color: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            overlay_visible: true,
            overlay_x: 80,
            overlay_y: 420,
            overlay_width: 760,
            overlay_height: 440,
            anchor: Anchor::BottomLeft,
            font_size: 22,
            theme: ThemePreset::Terminal,
            typewriter: true,
            history_lines: Self::DEFAULT_HISTORY_LINES,
            cursor_style: "block".into(),
            click_through: false,
            always_on_top: true,
            lines_before: 1,
            lines_after: 2,
            start_with_windows: false,
            show_track_source: true,
            lock_position: false,
            terminal_effects: true,
            show_terminal_activity: true,
            easter_eggs: true,
            completed_word_color: "muted".into(),
        }
    }
}

impl Settings {
    /// The default overlay height, sized from the layout: header 21px + song
    /// block 16px + editor padding 17px + footer 13px = 67px of chrome, plus ten
    /// 35px line rows (~352px) for the ten-line lyric history and the active
    /// expression.
    pub const DEFAULT_OVERLAY_HEIGHT: u32 = 440;

    /// Default number of visible lyric lines.
    pub const DEFAULT_HISTORY_LINES: u32 = 10;
    /// Inclusive bounds for the lyric-history slider.
    pub const MIN_HISTORY_LINES: u32 = 1;
    pub const MAX_HISTORY_LINES: u32 = 20;

    /// Visible lyric lines, clamped to the supported range.
    pub fn history_lines(&self) -> u32 {
        self.history_lines
            .clamp(Self::MIN_HISTORY_LINES, Self::MAX_HISTORY_LINES)
    }

    /// Clamps every numeric field into a sane range. Used after loading from
    /// disk and after applying partial updates from the UI.
    ///
    /// IMPORTANT: this never rewrites `overlay_width` / `overlay_height` /
    /// `overlay_x` / `overlay_y` beyond a sanity clamp. An earlier build migrated
    /// "legacy" heights to a new default on every save, which silently moved and
    /// resized the overlay whenever any setting was changed.
    pub fn sanitize(mut self) -> Self {
        self.overlay_width = self.overlay_width.clamp(280, 2400);
        self.overlay_height = self.overlay_height.clamp(140, 1200);
        self.overlay_x = self.overlay_x.clamp(-32_000, 32_000);
        self.overlay_y = self.overlay_y.clamp(-32_000, 32_000);
        self.font_size = self.font_size.clamp(12, 64);
        self.history_lines = self
            .history_lines
            .clamp(Self::MIN_HISTORY_LINES, Self::MAX_HISTORY_LINES);
        if !matches!(
            self.cursor_style.as_str(),
            "block" | "line" | "underline" | "bar" | "hollow" | "none"
        ) {
            self.cursor_style = "block".into();
        }
        self.lines_before = self.lines_before.min(19);
        self.lines_after = self.lines_after.min(19);
        if !matches!(
            self.completed_word_color.as_str(),
            "muted" | "dim" | "accent"
        ) {
            self.completed_word_color = "muted".into();
        }
        // Typewriter reveal and the terminal easter eggs are core parts of the
        // experience, not user options. Their settings no longer appear in the
        // UI, so force them on: a `false` written by an older build (or a hand
        // edited file) must never silently switch the feature off.
        self.typewriter = true;
        self.easter_eggs = true;
        // Click-through is retired. Force it off so an old `true` can never
        // make the overlay ignore the mouse again.
        self.click_through = false;
        self
    }
}

pub fn settings_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load_settings(config_dir: &PathBuf) -> Settings {
    let path = settings_path(config_dir);
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(settings) => settings.sanitize(),
            Err(e) => {
                log::warn!("invalid settings file, using defaults: {e}");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

pub fn save_settings(config_dir: &PathBuf, settings: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let path = settings_path(config_dir);
    let text = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".into());
    // Write-then-rename keeps the previous settings file intact on failure.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &path)
}

/// Returns the payload sent to the overlay whenever the active lyric changes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricContext {
    pub lines: Vec<LyricLine>,
    pub synced: bool,
    pub word_synced: bool,
    pub word_granularity: String,
    pub instrumental: bool,
    pub source: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
}

impl LyricContext {
    pub fn from_result(result: &LyricsResult) -> Self {
        Self {
            lines: result.lines.clone(),
            synced: result.synced,
            word_synced: result.word_synced,
            word_granularity: result.word_granularity.clone(),
            instrumental: result.instrumental,
            source: result.source.clone(),
            title: result.title.clone(),
            artist: result.artist.clone(),
            album: result.album.clone(),
            duration_ms: result.duration_ms,
        }
    }

    pub fn empty() -> Self {
        Self {
            lines: Vec::new(),
            synced: false,
            word_synced: false,
            word_granularity: String::new(),
            instrumental: false,
            source: String::new(),
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            duration_ms: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Typewriter and easter eggs are permanent features, not toggles. A
    /// persisted `false` (older build, hand-edited file) must be forced back on
    /// so the feature can never be silently disabled.
    #[test]
    fn typewriter_and_easter_eggs_are_always_enabled() {
        let legacy = Settings {
            typewriter: false,
            easter_eggs: false,
            ..Settings::default()
        }
        .sanitize();
        assert!(legacy.typewriter, "typewriter must be forced on");
        assert!(legacy.easter_eggs, "easter eggs must be forced on");

        // And they survive a round trip through the on-disk representation.
        let json = serde_json::to_string(&legacy).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        let back = back.sanitize();
        assert!(back.typewriter);
        assert!(back.easter_eggs);
    }

    #[test]
    fn default_height_fits_ten_lyric_rows() {
        // 67px of chrome plus ten 35px rows must fit, with modest headroom.
        let s = Settings::default();
        assert!(s.overlay_height >= 67 + 10 * 35);
        // It must not reserve a large dead area beyond a small wrap buffer.
        assert!(s.overlay_height <= 67 + 13 * 35);
    }

    #[test]
    fn geometry_is_never_rewritten_by_sanitize() {
        // Regression: a previous build migrated "legacy" heights to a new
        // default on every save, which moved/resized the overlay whenever an
        // unrelated setting changed. Every in-range geometry value must survive.
        for (w, h) in [(760u32, 220u32), (760, 260), (760, 340), (910, 300), (1200, 900)] {
            let s = Settings {
                overlay_width: w,
                overlay_height: h,
                overlay_x: 1066,
                overlay_y: 168,
                ..Settings::default()
            }
            .sanitize();
            assert_eq!(s.overlay_width, w, "width {w} was rewritten");
            assert_eq!(s.overlay_height, h, "height {h} was rewritten");
            assert_eq!(s.overlay_x, 1066, "x was rewritten");
            assert_eq!(s.overlay_y, 168, "y was rewritten");
        }
    }

    #[test]
    fn customised_heights_are_preserved() {
        // Any height the user actually chose must survive untouched.
        for custom in [140u32, 300, 480, 900] {
            let s = Settings {
                overlay_height: custom,
                ..Settings::default()
            }
            .sanitize();
            assert_eq!(s.overlay_height, custom, "custom height {custom} was overridden");
        }
    }

    #[test]
    fn history_lines_are_clamped_to_the_slider_range() {
        let low = Settings {
            history_lines: 0,
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(low.history_lines, Settings::MIN_HISTORY_LINES);
        assert_eq!(low.history_lines, 1);

        let high = Settings {
            history_lines: 999,
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(high.history_lines, Settings::MAX_HISTORY_LINES);
        assert_eq!(high.history_lines, 20);

        for n in 1..=20u32 {
            let s = Settings {
                history_lines: n,
                ..Settings::default()
            }
            .sanitize();
            assert_eq!(s.history_lines, n);
            assert_eq!(s.history_lines(), n);
        }
    }

    #[test]
    fn cursor_style_falls_back_when_unknown() {
        let s = Settings {
            cursor_style: "sparkle".into(),
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(s.cursor_style, "block");
        for style in ["block", "line", "underline", "bar", "hollow", "none"] {
            let s = Settings {
                cursor_style: style.into(),
                ..Settings::default()
            }
            .sanitize();
            assert_eq!(s.cursor_style, style);
        }
    }

    #[test]
    fn out_of_range_heights_are_clamped() {
        let low = Settings {
            overlay_height: 10,
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(low.overlay_height, 140);

        let high = Settings {
            overlay_height: 99_999,
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(high.overlay_height, 1200);
    }

    #[test]
    fn invalid_past_lyric_modes_fall_back_to_muted() {
        let s = Settings {
            completed_word_color: "neon-purple".into(),
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(s.completed_word_color, "muted");
    }

    /// Legacy settings files may still carry keys that no longer exist
    /// (`opacity`, `scanlines`, `scanlineIntensity`, `wordIntensity`,
    /// `cursorStyle`). They must be ignored, never fatal.
    #[test]
    fn legacy_and_unknown_keys_do_not_break_loading() {
        let json = r#"{
            "overlayVisible": true,
            "overlayX": 120,
            "overlayY": 260,
            "overlayWidth": 640,
            "overlayHeight": 420,
            "anchor": "topRight",
            "fontSize": 26,
            "theme": "cyberpunk",
            "typewriter": false,
            "clickThrough": true,
            "alwaysOnTop": false,
            "linesBefore": 2,
            "linesAfter": 1,
            "startWithWindows": false,
            "showTrackSource": false,
            "lockPosition": true,
            "completedWordColor": "accent",
            "opacity": 0.85,
            "scanlines": true,
            "scanlineIntensity": 0.4,
            "wordIntensity": 0.3,
            "cursorStyle": "underline",
            "someFutureSetting": 42
        }"#;
        let parsed: Settings = serde_json::from_str(json).expect("legacy file must load");
        assert_eq!(parsed.overlay_x, 120);
        assert_eq!(parsed.overlay_y, 260);
        assert_eq!(parsed.theme, ThemePreset::Cyberpunk);
        assert_eq!(parsed.anchor, Anchor::TopRight);
        assert_eq!(parsed.completed_word_color, "accent");
        assert!(parsed.lock_position);
        // Legacy `clickThrough` keys (and any other retired option) must load
        // without error and be neutralised, so a retired feature can never
        // reactivate from an old settings file. `sanitize` forces it off.
        assert!(
            !parsed.sanitize().click_through,
            "click-through must stay off after sanitize"
        );
    }

    #[test]
    fn a_settings_file_with_every_key_missing_uses_defaults() {
        let parsed: Settings = serde_json::from_str("{}").expect("empty object must load");
        assert_eq!(parsed.overlay_width, Settings::default().overlay_width);
        assert_eq!(parsed.theme, ThemePreset::Terminal);
    }

    #[test]
    fn removed_settings_are_no_longer_serialized() {
        let text = serde_json::to_string(&Settings::default()).unwrap();
        // Only keys that were fully retired. `cursorStyle` is deliberately NOT
        // in this list: the six caret styles are still a live, user-facing
        // setting, so it must keep being serialized.
        for legacy in ["opacity", "scanlines", "scanlineIntensity", "wordIntensity"] {
            assert!(!text.contains(legacy), "{legacy} is still serialized");
        }
        assert!(
            text.contains("cursorStyle"),
            "cursorStyle is still a supported setting and must be persisted"
        );
    }
}
