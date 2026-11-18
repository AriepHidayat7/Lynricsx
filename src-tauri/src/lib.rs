//! Lynricsx: a terminal-inspired, code-styled lyrics overlay for Windows.
//!
//! Architecture
//! ------------
//! * `gsmtc`        — thin wrapper over `Windows.Media.Control` (WinRT).
//! * `media_worker` — an MTA thread that owns the session manager, listens to
//!                    WinRT events and publishes snapshots on a watch channel.
//! * `lyrics`       — provider-agnostic lyrics engine (LRC parser, LRCLIB
//!                    provider and a persistent cache).
//! * `settings`     — persisted user settings and the overlay payload type.
//! * this module    — Tauri commands, window management and the async event
//!                    loops that push state to the two webviews.

mod autostart;
mod diag;
mod gsmtc;
mod lyrics;
mod media_worker;
mod settings;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex as AsyncMutex;

use gsmtc::TrackSnapshot;
use lyrics::cache::LyricsCache;
use lyrics::liriqo::LiriQoProvider;
use lyrics::lrclib::LrclibProvider;
use lyrics::{LyricsProvider, LyricsResult, TrackQuery};
use media_worker::MediaHandle;
use settings::Settings;

const OVERLAY_LABEL: &str = "overlay";
const MAIN_LABEL: &str = "main";

/// The white Lynricsx logo, compiled into the binary.
///
/// Decoded at runtime and pushed to each window with `set_icon`, so the taskbar
/// and Alt-Tab get a real large icon. Without this the window exposes no
/// `WM_GETICON` image and Windows falls back to the .exe resource — a path that
/// also picks up Explorer's icon cache, which is why a stale red logo could
/// linger on the taskbar long after the executable itself was updated.
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

/// Hides a window from the taskbar at the Win32 level.
///
/// Tauri's `skip_taskbar` is not sufficient on Windows: the window keeps
/// `WS_EX_APPWINDOW`, so the shell can still create a taskbar button for it and
/// render a fallback icon (which is how a stale/incorrect logo appeared on the
/// taskbar). Clearing APPWINDOW and setting TOOLWINDOW removes it from the
/// taskbar and Alt-Tab entirely.
#[cfg(target_os = "windows")]
fn make_tool_window(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    let hwnd = match window.hwnd() {
        Ok(h) => HWND(h.0),
        Err(e) => {
            log::warn!("no hwnd for taskbar fix: {e}");
            return;
        }
    };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new = (ex & !(WS_EX_APPWINDOW.0 as isize)) | (WS_EX_TOOLWINDOW.0 as isize);
        if new != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        }
    }
}

/// Applies [`APP_ICON_PNG`] to a window.
///
/// Tauri's `set_icon` only populates the *small* (ICON_SMALL) slot. The Windows
/// taskbar and Alt-Tab ask for `ICON_BIG` via `WM_GETICON`; when that is empty
/// they fall back to the .exe resource or to Explorer's icon cache, which is how
/// a stale red logo survived the executable being updated. So the big icons are
/// pushed through Win32 as well.
///
/// Best-effort: a failure here only affects the title-bar/taskbar image, never
/// the overlay itself, so it is logged rather than propagated.
fn apply_window_icon(window: &tauri::WebviewWindow) {
    match tauri::image::Image::from_bytes(APP_ICON_PNG) {
        Ok(icon) => {
            if let Err(e) = window.set_icon(icon) {
                log::warn!("failed to set window icon: {e}");
            }
        }
        Err(e) => log::warn!("failed to decode embedded app icon: {e}"),
    }
    #[cfg(target_os = "windows")]
    set_win32_big_icon(window);
}

/// Loads the embedded PNG as an `HICON` and installs it as ICON_BIG *and* the
/// window-class icon, so the taskbar has an authoritative image to draw.
#[cfg(target_os = "windows")]
fn set_win32_big_icon(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, GetSystemMetrics, SendMessageW, SetClassLongPtrW, GCLP_HICON,
        ICON_BIG, ICON_SMALL2, LR_DEFAULTCOLOR, SM_CXICON, SM_CYICON, WM_SETICON,
    };

    // CreateIconFromResourceEx accepts a PNG blob directly, so the original
    // file bytes are used as-is (no lossy re-encoding).
    let png = APP_ICON_PNG;

    let hwnd = match window.hwnd() {
        Ok(h) => HWND(h.0),
        Err(e) => {
            log::warn!("no hwnd for icon update: {e}");
            return;
        }
    };

    unsafe {
        let cx = GetSystemMetrics(SM_CXICON);
        let cy = GetSystemMetrics(SM_CYICON);
        // 0x00000001 == LR_DEFAULTCOLOR; 0x00000000 == explicit format from the
        // resource header. CreateIconFromResourceEx decodes PNG payloads when
        // `fIcon` is true, which is exactly what the bundled icon is.
        let hicon = match CreateIconFromResourceEx(png, true, 0x0003_0000, cx as i32, cy as i32, LR_DEFAULTCOLOR) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("CreateIconFromResourceEx failed: {e}");
                return;
            }
        };
        if hicon.is_invalid() {
            log::warn!("CreateIconFromResourceEx returned an invalid handle");
            return;
        }
        SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_BIG as usize), LPARAM(hicon.0 as isize));
        SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_SMALL2 as usize), LPARAM(hicon.0 as isize));
        SetClassLongPtrW(hwnd, GCLP_HICON, hicon.0 as isize);
    }
}

/// Delay before a lyrics lookup, so rapid track switching does not spam the API.
const LOOKUP_DEBOUNCE: Duration = Duration::from_millis(400);
/// Minimum gap between two network lookups (client-side rate limiting).
const MIN_LOOKUP_INTERVAL: Duration = Duration::from_millis(1200);
/// Gap between the overlay and the screen edge when a corner anchor is used.
/// Logical pixels; scaled by the target monitor's DPI factor.
const CORNER_MARGIN_LOGICAL: f64 = 24.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsStatusEvent {
    pub state: String,
    pub message: String,
    pub synced: bool,
    pub word_synced: bool,
    pub granularity: String,
    pub instrumental: bool,
    pub source: String,
    pub line_count: usize,
    /// Track the status refers to, so the UI can drop stale events.
    pub track_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub entries: usize,
    pub bytes: u64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartInfo {
    pub enabled: bool,
    pub method: String,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub target: String,
    pub provider: String,
    pub cache_path: String,
    pub settings_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInput {
    pub x: i32,
    pub y: i32,
}

/// Shared application state.
struct AppState {
    media: MediaHandle,
    settings: Mutex<Settings>,
    config_dir: PathBuf,
    cache: Arc<LyricsCache>,
    liriqo: LiriQoProvider,
    lrclib: LrclibProvider,
    /// Serializes network lookups so debounced requests cannot pile up.
    lookup_lock: AsyncMutex<()>,
    /// Last time a network lookup ran, for client-side throttling.
    last_lookup: Mutex<Option<std::time::Instant>>,
    /// Tracks are only looked up once per session unless the cache is cleared.
    attempted: Mutex<std::collections::HashSet<String>>,
    autostart_method: String,
}

impl AppState {
    fn snapshot_settings(&self) -> Settings {
        self.settings
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    fn update_settings<F: FnOnce(&mut Settings)>(&self, f: F) {
        if let Ok(mut guard) = self.settings.lock() {
            f(&mut guard);
            let sanitized = guard.clone().sanitize();
            *guard = sanitized.clone();
            if let Err(e) = settings::save_settings(&self.config_dir, &sanitized) {
                log::warn!("failed to persist settings: {e}");
            }
        }
    }
}

/// Creates frameless, always-on-top, opaque-black lyrics overlay window.
///
/// `overlay_x` / `overlay_y` are logical (DPI-independent) coordinates. They are
/// converted to physical pixels here so the window lands on the right spot on
/// scaled displays.
fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let s = state.snapshot_settings();

    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Lynricsx Overlay")
        .inner_size(s.overlay_width as f64, s.overlay_height as f64)
        .decorations(false)
        .transparent(false)
        .resizable(true)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(s.always_on_top)
        .focused(false)
        .visible(false)
        .build()?;

    let _ = overlay.set_always_on_top(s.always_on_top);
    apply_placement(&overlay, &s);
    apply_window_icon(&overlay);
    // The overlay is interactive: playback controls and dragging both need it.
    // Set explicitly rather than relying on the platform default.
    let _ = overlay.set_ignore_cursor_events(false);

    // A corner anchor is re-solved after a resize so the window keeps hugging
    // that corner with its new size. X/Y changes are applied directly by the
    // commands, so `Moved` is deliberately ignored here to avoid feedback loops.
    {
        let win = overlay.clone();
        let app = app.clone();
        let _ = overlay.on_window_event(move |event| {
            if let tauri::WindowEvent::Resized(_) = event {
                let state = app.state::<AppState>();
                let current = state.snapshot_settings();
                if current.anchor != settings::Anchor::Custom {
                    apply_placement(&win, &current);
                }
            }
        });
    }

    if s.overlay_visible {
        let _ = overlay.show();
    }
    // `skip_taskbar(true)` alone is not reliable on Windows: showing the window
    // re-applies WS_EX_APPWINDOW, so the shell can create a taskbar button for
    // the overlay and draw a fallback icon for it. That must be undone *after*
    // the window is shown, otherwise `show()` puts the style straight back.
    #[cfg(target_os = "windows")]
    make_tool_window(&overlay);
    Ok(())
}

/// Moves the overlay to the coordinates described by `s`.
///
/// * `anchor == custom` — `overlay_x` / `overlay_y` are used verbatim.
/// * a corner anchor    — the position is solved against the overlay's current
///   monitor work area, so moving the window to another monitor and picking a
///   corner places it on *that* monitor.
///
/// Stored coordinates are logical; Win32 wants physical pixels, so they are
/// scaled by the target monitor's DPI factor.
fn apply_placement(overlay: &tauri::WebviewWindow, s: &Settings) {
    let size = overlay
        .inner_size()
        .map(|p| tauri::PhysicalSize::new(p.width, p.height))
        .unwrap_or_else(|_| {
            let scale = overlay.scale_factor().unwrap_or(1.0);
            tauri::PhysicalSize::new(
                (s.overlay_width as f64 * scale).round() as u32,
                (s.overlay_height as f64 * scale).round() as u32,
            )
        });

    let scale = overlay.scale_factor().unwrap_or(1.0);

    if s.anchor == settings::Anchor::Custom {
        let pos = tauri::PhysicalPosition::new(
            (s.overlay_x as f64 * scale).round() as i32,
            (s.overlay_y as f64 * scale).round() as i32,
        );
        let _ = overlay.set_position(pos);
        return;
    }

    let Some(monitor) = overlay
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| overlay.primary_monitor().ok().flatten())
    else {
        return;
    };

    let area = monitor.work_area();
    let target = corner_position(&s.anchor, area.position, area.size, size, monitor.scale_factor());
    let _ = overlay.set_position(target);
}

/// Top-left corner of a window of `size` placed in one corner of `origin`/`area`.
///
/// Works in physical pixels and clamps the result so the overlay always stays
/// fully inside the work area (taskbar excluded) — important for small
/// monitors, unusual DPI settings and negative-origin (left/top) monitors.
fn corner_position(
    anchor: &settings::Anchor,
    origin: tauri::PhysicalPosition<i32>,
    area: tauri::PhysicalSize<u32>,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
) -> tauri::PhysicalPosition<i32> {
    let margin = (CORNER_MARGIN_LOGICAL * scale).round() as i32;
    let width = size.width as i32;
    let height = size.height as i32;
    let area_w = area.width as i32;
    let area_h = area.height as i32;

    let min_x = origin.x + margin;
    let min_y = origin.y + margin;
    let max_x = origin.x + area_w - width - margin;
    let max_y = origin.y + area_h - height - margin;

    let right = matches!(
        anchor,
        settings::Anchor::TopRight | settings::Anchor::BottomRight
    );
    let bottom = matches!(
        anchor,
        settings::Anchor::BottomLeft | settings::Anchor::BottomRight
    );

    let x = if right { max_x } else { min_x };
    let y = if bottom { max_y } else { min_y };

    tauri::PhysicalPosition::new(x.max(min_x), y.max(min_y))
}

/// Pushes overlay configuration to the overlay webview.
///
/// The appearance preset (`theme`) and the per-track syntax palette (chosen in
/// the overlay from the track seed) are independent: this payload never carries
/// a syntax palette.
///
/// This deliberately does **not** touch native window geometry: appearance
/// changes must never move or resize the overlay. Geometry is applied only by
/// `create_overlay` (startup), `set_position`/`set_anchor`, and the resize hook.
fn emit_overlay_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let s = state.snapshot_settings();
    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    let payload = serde_json::json!({
        "fontSize": s.font_size,
        "theme": s.theme,
        "typewriter": s.typewriter,
        "cursorStyle": s.cursor_style,
        "historyLines": s.history_lines(),
        "showTrackSource": s.show_track_source,
        "lockPosition": s.lock_position,
        "completedWordColor": s.completed_word_color,
        "terminalEffects": s.terminal_effects,
        "showTerminalActivity": s.show_terminal_activity,
        "easterEggs": s.easter_eggs,
    });
    let _ = overlay.emit("overlay:settings", payload);
}

/// Applies the *non-geometric* overlay settings to the live window and webview.
///
/// Never calls `set_size`, `set_position` or `apply_placement`. Doing so on every
/// settings update was the cause of the overlay jumping/resizing whenever an
/// unrelated option (history, typewriter, cursor, font size, theme…) changed.
fn apply_overlay_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let s = state.snapshot_settings();
    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    let _ = overlay.set_always_on_top(s.always_on_top);

    if s.overlay_visible {
        let _ = overlay.show();
    } else {
        let _ = overlay.hide();
    }

    emit_overlay_settings(app);
}

fn broadcast_track(app: &AppHandle, snapshot: &TrackSnapshot) {
    let _ = app.emit("media:track", snapshot);
}

fn emit_status(app: &AppHandle, status: LyricsStatusEvent) {
    let _ = app.emit("lyrics:status", status);
}

fn broadcast_lyrics(app: &AppHandle, ctx: &settings::LyricContext) {
    let _ = app.emit("lyrics:context", ctx);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_track(state: tauri::State<'_, AppState>) -> TrackSnapshot {
    state.media.current()
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.snapshot_settings()
}

#[tauri::command]
fn update_settings(app: AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let current = state.snapshot_settings();
    let mut value = serde_json::to_value(&current).map_err(|e| e.to_string())?;
    if let (serde_json::Value::Object(base), serde_json::Value::Object(patch)) =
        (&mut value, &patch)
    {
        for (k, v) in patch {
            // Unknown keys (including settings removed in newer builds) are
            // dropped instead of being written into the settings file.
            if base.contains_key(k) {
                base.insert(k.clone(), v.clone());
            }
        }
    }
    let merged = serde_json::from_value::<Settings>(value)
        .map_err(|e| e.to_string())?
        .sanitize();

    // Geometry is intentionally NOT re-applied here. Only an explicit change to
    // the stored X/Y or size may move or resize the native overlay; every other
    // setting (theme, font, history, typewriter, cursor…) must leave the window
    // exactly where the user put it.
    let geometry_changed = merged.overlay_x != current.overlay_x
        || merged.overlay_y != current.overlay_y
        || merged.overlay_width != current.overlay_width
        || merged.overlay_height != current.overlay_height;

    state.update_settings(|s| *s = merged.clone());
    apply_overlay_settings(&app);

    if geometry_changed {
        if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
            // Re-apply the *merged* geometry explicitly (a size change also needs
            // the position re-applied for corner anchors to stay correct).
            let _ = overlay.set_size(tauri::LogicalSize::new(
                merged.overlay_width as f64,
                merged.overlay_height as f64,
            ));
            apply_placement(&overlay, &merged);
        }
    }

    Ok(state.snapshot_settings())
}

#[tauri::command]
fn set_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.update_settings(|s| s.overlay_visible = visible);
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        if visible {
            overlay.show().map_err(|e| e.to_string())?;
        } else {
            overlay.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Moves the native lyrics overlay to an explicit position.
///
/// `x` / `y` are logical screen coordinates (the same space the settings pane
/// displays). They are converted to physical pixels with the overlay's DPI
/// factor and written straight to the overlay window — the settings window is
/// never moved.
#[tauri::command]
fn set_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let state = app.state::<AppState>();
    let overlay = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window missing".to_string())?;
    let scale = overlay.scale_factor().unwrap_or(1.0);
    let physical = tauri::PhysicalPosition::new(
        (x as f64 * scale).round() as i32,
        (y as f64 * scale).round() as i32,
    );
    overlay.set_position(physical).map_err(|e| e.to_string())?;
    state.update_settings(|s| {
        s.overlay_x = x;
        s.overlay_y = y;
        s.anchor = settings::Anchor::Custom;
    });
    Ok(())
}

/// Selects a screen corner for the lyrics overlay.
///
/// The overlay is moved to the matching corner of the monitor it currently sits
/// on (or of the primary monitor at first launch) and the resolved logical
/// coordinates are stored, so X/Y stay in sync with the window.
#[tauri::command]
fn set_anchor(app: AppHandle, anchor: settings::Anchor) -> Result<PositionInput, String> {
    let state = app.state::<AppState>();
    let overlay = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window missing".to_string())?;

    let mut s = state.snapshot_settings();
    s.anchor = anchor;
    apply_placement(&overlay, &s);

    // Read back the real position so the stored coordinates match the window.
    let (x, y) = read_logical_position(&overlay);
    state.update_settings(|st| {
        st.anchor = s.anchor.clone();
        st.overlay_x = x;
        st.overlay_y = y;
    });
    Ok(PositionInput { x, y })
}

/// Reports where the lyrics overlay currently is, in logical coordinates.
///
/// This asks the native window, so it also reflects a position the user reached
/// by dragging rather than by editing the X/Y fields.
#[tauri::command]
fn get_position(app: AppHandle) -> Result<PositionInput, String> {
    let overlay = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window missing".to_string())?;
    let (x, y) = read_logical_position(&overlay);
    Ok(PositionInput { x, y })
}

/// Result of a playback control action.
///
/// `state` is the playback state read back from the session *after* the action,
/// so the frontend reconciles against reality instead of assuming success.
#[derive(serde::Serialize)]
struct TransportResult {
    ok: bool,
    state: gsmtc::PlaybackState,
    error: Option<String>,
}

/// Drives the active media session: `play`, `pause`, `toggle`, `next`, `previous`.
///
/// Uses the same GSMTC session the overlay is displaying (see
/// `gsmtc::transport`, which shares `pick_best` with `snapshot`). No Spotify Web
/// API, no credentials, no synthetic key presses.
#[tauri::command]
async fn media_transport(app: AppHandle, action: String) -> Result<TransportResult, String> {
    let parsed = gsmtc::Transport::parse(&action)
        .ok_or_else(|| format!("unknown transport action \"{action}\""))?;
    let state = app.state::<AppState>();
    let media = state.media.clone();

    // winrt calls block until the player answers; keep them off the async
    // runtime's threads so the overlay UI never stalls behind a slow player.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = media.transport(parsed);
        // Refresh the snapshot right away so the overlay's own state (not just
        // the returned value) reflects what happened.
        media.poke();
        result
    })
    .await
    .map_err(|e| format!("transport task failed: {e}"))?;

    match outcome {
        // The worker has not acquired a session manager yet.
        None => Ok(TransportResult {
            ok: false,
            state: gsmtc::PlaybackState::Closed,
            error: Some("media session is not ready yet".into()),
        }),
        Some(Ok(state)) => Ok(TransportResult {
            ok: true,
            state,
            error: None,
        }),
        Some(Err(e)) => Ok(TransportResult {
            ok: false,
            state: state.media.current().playback_state,
            error: Some(e),
        }),
    }
}

/// Seeks the active media session to `position_ms` (milliseconds).
///
/// Backs click-a-lyric and the mini progress indicator. Uses the same GSMTC
/// session as the overlay (shared `pick_best`), so a seek can never target a
/// different player than the one being displayed. The position is clamped to the
/// session's own timeline, so a stale lyric timestamp cannot overshoot.
#[tauri::command]
async fn media_seek(app: AppHandle, position_ms: i64) -> Result<TransportResult, String> {
    let state = app.state::<AppState>();
    let media = state.media.clone();
    let target = position_ms.max(0);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = media.seek(target);
        // Refresh immediately so the overlay re-anchors without waiting for the
        // next poll; this is what makes click-to-seek feel instant.
        media.poke();
        result
    })
    .await
    .map_err(|e| format!("seek task failed: {e}"))?;

    match outcome {
        None => Ok(TransportResult {
            ok: false,
            state: gsmtc::PlaybackState::Closed,
            error: Some("media session is not ready yet".into()),
        }),
        Some(Ok(state)) => Ok(TransportResult {
            ok: true,
            state,
            error: None,
        }),
        Some(Err(e)) => Ok(TransportResult {
            ok: false,
            state: state.media.current().playback_state,
            error: Some(e),
        }),
    }
}
fn read_logical_position(overlay: &tauri::WebviewWindow) -> (i32, i32) {
    let scale = overlay.scale_factor().unwrap_or(1.0);
    match overlay.outer_position() {
        Ok(pos) => (
            (pos.x as f64 / scale).round() as i32,
            (pos.y as f64 / scale).round() as i32,
        ),
        Err(_) => (0, 0),
    }
}

/// Starts a native Windows caption drag for the overlay window.
///
/// This is called from the overlay webview on `mousedown`. It uses the classic
/// `ReleaseCapture` + `WM_NCLBUTTONDOWN`/`HTCAPTION` Win32 trick, which reliably
/// moves a frameless window without depending on `data-tauri-drag-region` or
/// the webview `startDragging()` path.
#[tauri::command]
fn drag_overlay(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let s = state.snapshot_settings();
    if s.lock_position {
        return Err("position locked".into());
    }

    let overlay = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window missing".to_string())?;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageW, HTCAPTION, WM_NCLBUTTONDOWN,
        };

        // `WebviewWindow::hwnd()` returns the handle from Tauri's own `windows`
        // crate version; take the raw pointer and re-wrap it in ours.
        let raw = overlay.hwnd().map_err(|e| e.to_string())?.0;
        let hwnd = HWND(raw);
        unsafe {
            let _ = ReleaseCapture();
            let _ = SendMessageW(
                hwnd,
                WM_NCLBUTTONDOWN,
                WPARAM(HTCAPTION as usize),
                LPARAM(0),
            );
        }
    }

    Ok(())
}

#[tauri::command]
fn get_cache_info(state: tauri::State<'_, AppState>) -> CacheInfo {
    let (entries, bytes) = state.cache.stats();
    CacheInfo {
        entries,
        bytes,
        path: state.cache.dir().display().to_string(),
    }
}

#[tauri::command]
fn clear_cache(state: tauri::State<'_, AppState>) -> CacheInfo {
    let removed = state.cache.clear();
    log::info!("cleared {removed} cached lyric files");
    if let Ok(mut attempted) = state.attempted.lock() {
        attempted.clear();
    }
    get_cache_info(state)
}

#[tauri::command]
fn get_app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: "Lynricsx".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        tauri_version: tauri::VERSION.into(),
        target: format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        provider: "LiriQo + LRCLIB".into(),
        cache_path: state.cache.dir().display().to_string(),
        settings_path: settings::settings_path(&state.config_dir)
            .display()
            .to_string(),
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> AutostartInfo {
    let state = app.state::<AppState>();
    AutostartInfo {
        enabled: autostart::is_enabled(),
        method: state.autostart_method.clone(),
        supported: true,
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<AutostartInfo, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    autostart::set_enabled(&exe, enabled)?;
    let state = app.state::<AppState>();
    state.update_settings(|s| s.start_with_windows = enabled);
    Ok(AutostartInfo {
        enabled: autostart::is_enabled(),
        method: state.autostart_method.clone(),
        supported: true,
    })
}

/// Re-runs a lyrics lookup for the current track (cache is still consulted).
#[tauri::command]
async fn refresh_lyrics(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = state.media.current();
    let key = snapshot.track_key();
    if key.is_empty() {
        return Err("No media detected".into());
    }
    if let Ok(mut attempted) = state.attempted.lock() {
        attempted.remove(&key);
    }
    let query = TrackQuery {
        title: snapshot.title.clone(),
        artist: snapshot.artist.clone(),
        album: snapshot.album.clone(),
        duration_s: (snapshot.duration_ms > 0).then(|| snapshot.duration_ms / 1000),
    };
    if let Some(result) = resolve_lyrics(&app, &state, query, &key).await {
        broadcast_lyrics(&app, &settings::LyricContext::from_result(&result));
        let status = LyricsStatusEvent {
            state: "ready".into(),
            message: "Lyrics ready".into(),
            synced: result.synced,
            word_synced: result.word_synced,
            granularity: result.word_granularity.clone(),
            instrumental: result.instrumental,
            source: result.source.clone(),
            line_count: result.lines.len(),
            track_key: key,
        };
        emit_status(&app, status);
    }
    Ok(())
}

/// Looks lyrics up for `query`, honouring cache, de-duplication and rate
/// limiting. Returns `None` only when superseded or hit by an unrecoverable
/// error (which is reported to the UI via `lyrics:status`).
async fn resolve_lyrics(
    app: &AppHandle,
    state: &AppState,
    query: TrackQuery,
    track_key: &str,
) -> Option<LyricsResult> {
    // 1. Cache hit. Report it honestly so the overlay can show
    //    "[CACHE] Restoring cached lyrics..." instead of a network fetch.
    if let Some(cached) = state.cache.get(&query) {
        emit_status(app, LyricsStatusEvent {
            state: "cache_hit".into(),
            message: "Restoring cached lyrics".into(),
            synced: cached.synced,
            word_synced: cached.word_synced,
            granularity: cached.word_granularity.clone(),
            instrumental: cached.instrumental,
            source: cached.source.clone(),
            line_count: cached.lines.len(),
            track_key: track_key.to_string(),
        });
        return Some(cached);
    }

    // 2. De-duplication: only look a track up once per session.
    {
        let mut attempted = state.attempted.lock().ok()?;
        if attempted.contains(track_key) {
            return None;
        }
        attempted.insert(track_key.to_string());
    }

    let _guard = state.lookup_lock.lock().await;

    // 3. Drop if the track changed while we waited for the lock.
    if state.media.current().track_key().to_lowercase() != track_key.to_lowercase() {
        return None;
    }

    // 4. Client-side throttling.
    let delay = {
        let mut last = state.last_lookup.lock().ok()?;
        let previous = *last;
        *last = Some(std::time::Instant::now());
        match previous {
            Some(prev) if prev.elapsed() < MIN_LOOKUP_INTERVAL => {
                Some(MIN_LOOKUP_INTERVAL - prev.elapsed())
            }
            _ => None,
        }
    };
    if let Some(delay) = delay {
        tokio::time::sleep(delay).await;
    }

    let mut status = LyricsStatusEvent {
        state: "loading".into(),
        message: "Searching lyric providers".into(),
        synced: false,
        word_synced: false,
        granularity: String::new(),
        instrumental: false,
        source: "liriqo".into(),
        line_count: 0,
        track_key: track_key.to_string(),
    };
    emit_status(app, status.clone());

    // Provider priority:
    //   1. LiriQo native word/syllable sync
    //   2. LRCLIB line-synced
    //   3. LiriQo line-synced
    //   4. LRCLIB plain
    //   5. LiriQo plain
    let mut liriqo_result: Option<LyricsResult> = None;
    let mut liriqo_error = false;
    let mut lrclib_result: Option<LyricsResult> = None;
    let mut lrclib_error = false;

    // Each provider status below is emitted immediately before the *actual*
    // request, so the overlay never claims to be querying a provider it is not.
    status.state = "provider_query".into();
    status.source = "liriqo".into();
    status.message = "Querying LiriQo".into();
    emit_status(app, status.clone());

    match state.liriqo.lookup(&query).await {
        Ok(Some(result)) => liriqo_result = Some(result),
        Ok(None) => {}
        Err(e) => {
            liriqo_error = true;
            log::warn!("liriqo lookup failed: {e}");
            status.state = "provider_error".into();
            status.source = "liriqo".into();
            status.message = "LiriQo request failed".into();
            emit_status(app, status.clone());
        }
    }

    status.state = "provider_query".into();
    status.source = "lrclib".into();
    status.message = "Querying LRCLIB".into();
    emit_status(app, status.clone());

    match state.lrclib.lookup(&query).await {
        Ok(Some(result)) => lrclib_result = Some(result),
        Ok(None) => {}
        Err(e) => {
            lrclib_error = true;
            log::warn!("lrclib lookup failed: {e}");
            status.state = "provider_error".into();
            status.source = "lrclib".into();
            status.message = "LRCLIB request failed".into();
            emit_status(app, status.clone());
        }
    }

    let chosen = lyrics::selection::select_result(liriqo_result.as_ref(), lrclib_result.as_ref());

    if let Some(result) = chosen {
        state.cache.put(&query, &result, false).await;
        return Some(result);
    }

    // Nothing usable. Distinguish "provider error" from "genuinely no lyrics".
    if liriqo_error && lrclib_error {
        if let Ok(mut attempted) = state.attempted.lock() {
            attempted.remove(track_key);
        }
        status.state = "error".into();
        status.message = "Offline - cannot reach any lyrics service".into();
        emit_status(app, status);
        return None;
    }

    let empty = LyricsResult::not_found(&query.title, &query.artist, &query.album);
    state.cache.put(&query, &empty, true).await;
    status.state = "not_found".into();
    status.message = "No lyrics found for this track".into();
    emit_status(app, status);
    Some(empty)
}

/// Watches the media snapshot and drives the lyrics engine.
async fn media_pipeline(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut rx = state.media.rx.clone();
    let mut last_key = String::new();
    let mut last_state: Option<gsmtc::PlaybackState> = None;
    /// Last position already forwarded to the webview.
    let mut last_position_ms: i64 = -1;
    let mut last_seek_seq = u64::MAX;
    let mut last_track_seq = u64::MAX;

    loop {
        let snapshot = rx.borrow().clone();

        // Publish when anything the UI needs has changed:
        //  * track identity (new song)
        //  * playback state (play/pause/stop)
        //  * the worker's track/seek counters
        //  * the reported position (so live seeking reaches the overlay)
        //
        // Previously only track identity and playback state were compared, so a
        // seek — which changes neither — was never forwarded to the webview. The
        // worker detected it, bumped `seek_seq`, and the event was dropped right
        // here, which is why lyrics only re-synced after a restart.
        let position_changed = snapshot.position_ms != last_position_ms;
        if snapshot.track_key() != last_key
            || last_state != Some(snapshot.playback_state)
            || (last_key.is_empty() && snapshot.has_session)
            || snapshot.seek_seq != last_seek_seq
            || snapshot.track_seq != last_track_seq
            || position_changed
        {
            last_state = Some(snapshot.playback_state);
            last_seek_seq = snapshot.seek_seq;
            last_track_seq = snapshot.track_seq;
            last_position_ms = snapshot.position_ms;
            broadcast_track(&app, &snapshot);
        }

        if snapshot.track_key() != last_key {
            last_key = snapshot.track_key();
            if last_key.is_empty() {
                broadcast_lyrics(&app, &settings::LyricContext::empty());
                emit_status(&app, LyricsStatusEvent {
                    state: "no_media".into(),
                    message: "No media detected".into(),
                    synced: false,
                    word_synced: false,
                    granularity: String::new(),
                    instrumental: false,
                    source: String::new(),
                    line_count: 0,
                    track_key: String::new(),
                });
            } else if snapshot.title.trim().is_empty() && snapshot.artist.trim().is_empty() {
                broadcast_lyrics(&app, &settings::LyricContext::empty());
            } else {
                let query = TrackQuery {
                    title: snapshot.title.clone(),
                    artist: snapshot.artist.clone(),
                    album: snapshot.album.clone(),
                    duration_s: (snapshot.duration_ms > 0).then(|| snapshot.duration_ms / 1000),
                };
                let key = snapshot.track_key();
                let app2 = app.clone();

                tauri::async_runtime::spawn(async move {
                    let handle_key = key.clone();
                    tokio::time::sleep(LOOKUP_DEBOUNCE).await;
                    let state = app2.state::<AppState>();
                    if state.media.current().track_key().to_lowercase()
                        != handle_key.to_lowercase()
                    {
                        return;
                    }
                    let Some(result) = resolve_lyrics(&app2, &state, query, &handle_key).await
                    else {
                        return;
                    };
                    if state.media.current().track_key().to_lowercase()
                        != handle_key.to_lowercase()
                    {
                        return;
                    }
                    broadcast_lyrics(&app2, &settings::LyricContext::from_result(&result));

                    let mut status = LyricsStatusEvent {
                        state: "ready".into(),
                        message: "Lyrics ready".into(),
                        synced: result.synced,
                        word_synced: result.word_synced,
                        granularity: result.word_granularity.clone(),
                        instrumental: result.instrumental,
                        source: result.source.clone(),
                        line_count: result.lines.len(),
                        track_key: handle_key,
                    };
                    if result.instrumental {
                        status.state = "instrumental".into();
                        status.message = "Instrumental track - no lyrics".into();
                    } else if result.lines.is_empty() {
                        status.state = "not_found".into();
                        status.message = "No lyrics found for this track".into();
                    } else if result.word_synced {
                        status.state = "ready".into();
                        status.message = format!(
                            "{} word timing",
                            if result.word_granularity.is_empty() {
                                "Native"
                            } else {
                                &result.word_granularity
                            }
                        );
                    } else if !result.synced {
                        status.state = "unsynced".into();
                        status.message = "Plain lyrics only - not synchronized".into();
                    }
                    emit_status(&app2, status);
                });
            }
        }

        if rx.changed().await.is_err() {
            break;
        }
    }
}

/// Persists overlay position while the user drags it and keeps the settings
/// window in sync. Fires once a second; a single Win32 position query per
/// second is negligible.
async fn position_tracker(app: AppHandle) {
    let mut last: Option<(i32, i32)> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
            continue;
        };
        if !overlay.is_visible().unwrap_or(false) {
            continue;
        }
        let Ok(pos) = overlay.outer_position() else {
            continue;
        };
        let current = (pos.x, pos.y);
        if last == Some(current) {
            continue;
        }
        last = Some(current);

        let scale = overlay.scale_factor().unwrap_or(1.0);
        let logical = (
            (current.0 as f64 / scale).round() as i32,
            (current.1 as f64 / scale).round() as i32,
        );

        let state = app.state::<AppState>();
        let stored = state.snapshot_settings();
        if stored.overlay_x == logical.0 && stored.overlay_y == logical.1 {
            continue;
        }
        state.update_settings(|s| {
            s.overlay_x = logical.0;
            s.overlay_y = logical.1;
            s.anchor = settings::Anchor::Custom;
        });
        let _ = app.emit(
            "overlay:position",
            PositionInput {
                x: logical.0,
                y: logical.1,
            },
        );
    }
}

pub fn run() {
    let media = media_worker::start();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_track,
            get_settings,
            update_settings,
            set_overlay_visible,
            set_position,
            set_anchor,
            get_position,
            drag_overlay,
            get_cache_info,
            clear_cache,
            get_app_info,
            get_autostart,
            set_autostart,
            refresh_lyrics,
            media_transport,
        media_seek,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            let config_dir = handle
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let cache_dir = handle
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| config_dir.join("cache"));

            let mut loaded = settings::load_settings(&config_dir).sanitize();
            // The registry is the source of truth for autostart state.
            loaded.start_with_windows = autostart::is_enabled();

            let cache = Arc::new(LyricsCache::new(cache_dir.join("lyrics")));
            cache.prune();

            handle.manage(AppState {
                media: media.clone(),
                settings: Mutex::new(loaded),
                config_dir,
                cache,
                liriqo: LiriQoProvider::new(),
                lrclib: LrclibProvider::new(),
                lookup_lock: AsyncMutex::new(()),
                last_lookup: Mutex::new(None),
                attempted: Mutex::new(std::collections::HashSet::new()),
                autostart_method: "registry".into(),
            });

            create_overlay(&handle)?;
            apply_overlay_settings(&handle);

            // The settings window comes from tauri.conf.json, which has no
            // per-window icon, so give it the logo explicitly. This is the
            // window the taskbar shows (the overlay is skip_taskbar).
            if let Some(main) = handle.get_webview_window(MAIN_LABEL) {
                apply_window_icon(&main);
            }

            let pipeline_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                media_pipeline(pipeline_app).await;
            });
            let tracker_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                position_tracker(tracker_app).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == MAIN_LABEL {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::corner_position;
    use crate::settings::{Anchor, Settings};
    use tauri::{PhysicalPosition, PhysicalSize};

    // 1920x1080 monitor, taskbar reserving 40px at the bottom, 100% DPI.
    const ORIGIN: PhysicalPosition<i32> = PhysicalPosition { x: 0, y: 0 };
    const AREA: PhysicalSize<u32> = PhysicalSize {
        width: 1920,
        height: 1040,
    };
    const SIZE: PhysicalSize<u32> = PhysicalSize {
        width: 760,
        height: 440,
    };

    /// Mirrors the decision `update_settings` makes: native geometry is touched
    /// only when the stored X/Y or size actually changed.
    fn geometry_changed(before: &Settings, after: &Settings) -> bool {
        after.overlay_x != before.overlay_x
            || after.overlay_y != before.overlay_y
            || after.overlay_width != before.overlay_width
            || after.overlay_height != before.overlay_height
    }

    /// Applies a patch the same way `update_settings` does (merge + sanitize).
    fn apply(before: &Settings, patch: serde_json::Value) -> Settings {
        let mut value = serde_json::to_value(before).unwrap();
        if let (serde_json::Value::Object(base), serde_json::Value::Object(p)) =
            (&mut value, &patch)
        {
            for (k, v) in p {
                if base.contains_key(k) {
                    base.insert(k.clone(), v.clone());
                }
            }
        }
        serde_json::from_value::<Settings>(value).unwrap().sanitize()
    }

    fn user_settings() -> Settings {
        Settings {
            overlay_x: 1066,
            overlay_y: 168,
            overlay_width: 620,
            overlay_height: 440,
            ..Settings::default()
        }
    }

    #[test]
    fn each_corner_maps_to_the_matching_screen_corner() {
        let margin = 24;

        let tl = corner_position(&Anchor::TopLeft, ORIGIN, AREA, SIZE, 1.0);
        assert_eq!((tl.x, tl.y), (margin, margin));

        let tr = corner_position(&Anchor::TopRight, ORIGIN, AREA, SIZE, 1.0);
        assert_eq!((tr.x, tr.y), (1920 - 760 - margin, margin));

        let bl = corner_position(&Anchor::BottomLeft, ORIGIN, AREA, SIZE, 1.0);
        assert_eq!((bl.x, bl.y), (margin, 1040 - 440 - margin));

        let br = corner_position(&Anchor::BottomRight, ORIGIN, AREA, SIZE, 1.0);
        assert_eq!((br.x, br.y), (1920 - 760 - margin, 1040 - 440 - margin));
    }

    #[test]
    fn dpi_scaling_scales_the_margin_but_keeps_the_corner() {
        // 150% DPI: the work area and window size are already physical pixels.
        let area = PhysicalSize {
            width: 2880,
            height: 1560,
        };
        let size = PhysicalSize {
            width: 1140,
            height: 660,
        };
        let br = corner_position(&Anchor::BottomRight, ORIGIN, area, size, 1.5);
        assert_eq!((br.x, br.y), (2880 - 1140 - 36, 1560 - 660 - 36));
    }

    #[test]
    fn negative_origin_monitors_are_supported() {
        // A monitor to the left of / above the primary one.
        let origin = PhysicalPosition { x: -1920, y: -200 };
        let tl = corner_position(&Anchor::TopLeft, origin, AREA, SIZE, 1.0);
        assert_eq!((tl.x, tl.y), (-1920 + 24, -200 + 24));

        let br = corner_position(&Anchor::BottomRight, origin, AREA, SIZE, 1.0);
        assert_eq!((br.x, br.y), (-760 - 24, -200 + 1040 - 440 - 24));
    }

    #[test]
    fn an_overlay_larger_than_the_work_area_stays_on_screen() {
        let small = PhysicalSize {
            width: 600,
            height: 300,
        };
        for anchor in [Anchor::TopLeft, Anchor::TopRight, Anchor::BottomLeft, Anchor::BottomRight] {
            let pos = corner_position(&anchor, ORIGIN, small, SIZE, 1.0);
            assert_eq!((pos.x, pos.y), (24, 24), "anchor {anchor:?} left the screen");
        }
    }

    // ---------------------------------------------------------------------
    // Regression: unrelated settings updates must never move/resize the
    // overlay. These cover the four cases named in the bug report.
    // ---------------------------------------------------------------------

    #[test]
    fn changing_lyric_history_does_not_change_geometry() {
        let before = user_settings();
        for n in [1u32, 3, 6, 10, 20] {
            let after = apply(&before, serde_json::json!({ "historyLines": n }));
            assert_eq!(after.history_lines, n);
            assert!(
                !geometry_changed(&before, &after),
                "history {n} moved/resized the overlay"
            );
            // Stored geometry is byte-for-byte unchanged.
            assert_eq!(after.overlay_x, before.overlay_x);
            assert_eq!(after.overlay_y, before.overlay_y);
            assert_eq!(after.overlay_width, before.overlay_width);
            assert_eq!(after.overlay_height, before.overlay_height);
        }
    }

    #[test]
    fn changing_typewriter_does_not_change_geometry() {
        let before = user_settings();
        // The typewriter is permanently on (`sanitize` forces it), so a legacy
        // `false` must not disable it — but it must still never move the window.
        let after = apply(&before, serde_json::json!({ "typewriter": false }));
        assert!(after.typewriter, "the typewriter is always on");
        assert!(!geometry_changed(&before, &after));
    }

    #[test]
    fn changing_cursor_style_does_not_change_geometry() {
        let before = user_settings();
        for style in ["block", "line", "underline", "bar", "hollow", "none"] {
            let after = apply(&before, serde_json::json!({ "cursorStyle": style }));
            assert_eq!(after.cursor_style, style);
            assert!(!geometry_changed(&before, &after), "cursor {style} moved the overlay");
        }
    }

    #[test]
    fn changing_theme_does_not_change_geometry() {
        let before = user_settings();
        for theme in ["terminal", "cyberpunk", "minimal"] {
            let after = apply(&before, serde_json::json!({ "theme": theme }));
            assert!(!geometry_changed(&before, &after), "theme {theme} moved the overlay");
        }
    }

    #[test]
    fn changing_font_size_and_past_lyrics_does_not_change_geometry() {
        let before = user_settings();
        let a = apply(&before, serde_json::json!({ "fontSize": 34 }));
        assert!(!geometry_changed(&before, &a));
        let b = apply(&before, serde_json::json!({ "completedWordColor": "accent" }));
        assert!(!geometry_changed(&before, &b));
    }

    #[test]
    fn a_combined_settings_burst_never_moves_the_overlay() {
        let before = user_settings();
        let after = apply(
            &before,
            serde_json::json!({
                "historyLines": 14,
                "typewriter": false,
                "cursorStyle": "hollow",
                "theme": "cyberpunk",
                "fontSize": 18,
                "completedWordColor": "dim",
                "showTrackSource": false,
                "alwaysOnTop": false,
                "lockPosition": true,
            }),
        );
        assert!(!geometry_changed(&before, &after));
        assert_eq!(after.overlay_x, 1066);
        assert_eq!(after.overlay_y, 168);
        assert_eq!(after.overlay_width, 620);
        assert_eq!(after.overlay_height, 440);
    }

    #[test]
    fn an_explicit_position_change_is_still_applied() {
        let before = user_settings();
        let after = apply(&before, serde_json::json!({ "overlayX": 40, "overlayY": 900 }));
        assert!(geometry_changed(&before, &after));
        assert_eq!(after.overlay_x, 40);
        assert_eq!(after.overlay_y, 900);
    }

    #[test]
    fn an_explicit_size_change_is_still_applied() {
        let before = user_settings();
        let after = apply(&before, serde_json::json!({ "overlayWidth": 900 }));
        assert!(geometry_changed(&before, &after));
        assert_eq!(after.overlay_width, 900);
        // Changing size alone must not move the window.
        assert_eq!(after.overlay_x, before.overlay_x);
        assert_eq!(after.overlay_y, before.overlay_y);
    }
}
