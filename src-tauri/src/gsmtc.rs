//! Windows Global System Media Transport Controls (GSMTC) integration.
//!
//! This module talks directly to `Windows.Media.Control` through WinRT and is
//! always used from a single dedicated MTA worker thread (see
//! [`crate::media_worker`]), because WinRT objects are apartment-bound.

use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use windows::Foundation::{AsyncOperationCompletedHandler, IAsyncOperation, TimeSpan};
use windows::Media::Control::{
    CurrentSessionChangedEventArgs, GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    GlobalSystemMediaTransportControlsSessionTimelineProperties as TimelineProperties,
    PlaybackInfoChangedEventArgs, SessionsChangedEventArgs,
};

use crate::diag;

/// Playback state as exposed to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    #[default]
    Closed,
    Opened,
    Changing,
    Stopped,
    Playing,
    Paused,
}

impl PlaybackState {
    pub fn from_gsmtc(status: PlaybackStatus) -> Self {
        match status {
            PlaybackStatus::Closed => Self::Closed,
            PlaybackStatus::Opened => Self::Opened,
            PlaybackStatus::Changing => Self::Changing,
            PlaybackStatus::Stopped => Self::Stopped,
            PlaybackStatus::Playing => Self::Playing,
            PlaybackStatus::Paused => Self::Paused,
            _ => Self::Closed,
        }
    }

    pub fn is_playing(self) -> bool {
        matches!(self, Self::Playing)
    }
}

/// Everything we know about the currently playing media.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackSnapshot {
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source_app_id: String,
    /// Friendly application name (e.g. "Spotify").
    pub source_app_name: String,
    pub playback_state: PlaybackState,
    /// Playback position in milliseconds.
    pub position_ms: i64,
    /// Track duration in milliseconds (0 when unknown).
    pub duration_ms: i64,
    /// Wall-clock timestamp (unix ms) when `position_ms` was sampled.
    pub sampled_at_ms: i64,
    /// Monotonic counter bumped whenever the worker *actually* observes a seek
    /// (a position jump the elapsed wall clock cannot explain). The overlay uses
    /// it to show a `[SEEK]` message exactly once per real seek.
    pub seek_seq: u64,
    /// Monotonic counter bumped whenever the track identity changes. Lets the
    /// overlay detect real track changes without comparing strings every frame.
    pub track_seq: u64,
}

impl TrackSnapshot {
    pub fn empty() -> Self {
        Self {
            has_session: false,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            source_app_id: String::new(),
            source_app_name: String::new(),
            playback_state: PlaybackState::Closed,
            position_ms: 0,
            duration_ms: 0,
            sampled_at_ms: 0,
            seek_seq: 0,
            track_seq: 0,
        }
    }

    /// A stable identity string used for detecting track changes.
    pub fn track_key(&self) -> String {
        if !self.has_session || (self.title.is_empty() && self.artist.is_empty()) {
            return String::new();
        }
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.title.trim(),
            self.artist.trim(),
            self.album.trim()
        )
    }
}

/// Formats a WinRT error's HRESULT as `0xHHHHHHHH`.
fn hr_hex(e: &windows::core::Error) -> String {
    format!("0x{:08X}", e.code().0 as u32)
}

/// Maps a raw Windows AUMID to a human readable application name.
///
/// Windows returns identifiers such as
/// `SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify`.
pub fn friendly_app_name(aumid: &str) -> String {
    if aumid.is_empty() {
        return "Unknown".into();
    }
    let base = aumid.split('!').next().unwrap_or(aumid);

    // Bare Win32 executables report a plain "App.exe" id (no package family or
    // `!application` suffix). Show the executable stem.
    if base.to_ascii_lowercase().ends_with(".exe") {
        let stem = &base[..base.len() - 4];
        let lower = stem.to_lowercase();
        for (needle, name) in KNOWN_APPS {
            if lower.contains(needle) {
                return (*name).to_string();
            }
        }
        return stem.to_string();
    }

    let vendor = base.split('_').next().unwrap_or(base);
    let last = vendor.rsplit('.').next().unwrap_or(vendor);

    let lower = last.to_lowercase();
    for (needle, name) in KNOWN_APPS {
        if lower.contains(needle) {
            return (*name).to_string();
        }
    }
    if last.is_empty() {
        aumid.to_string()
    } else {
        last.to_string()
    }
}

const KNOWN_APPS: &[(&str, &str)] = &[
    ("spotifymusic", "Spotify"),
    ("spotify", "Spotify"),
    ("applemusicwin", "Apple Music"),
    ("applemusic", "Apple Music"),
    ("itunes", "Apple Music"),
    ("msedge", "Microsoft Edge"),
    ("microsoftedge", "Microsoft Edge"),
    ("chrome", "Google Chrome"),
    ("firefox", "Firefox"),
    ("brave", "Brave"),
    ("opera", "Opera"),
    ("vivaldi", "Vivaldi"),
    ("zunemusic", "Media Player"),
    ("mediaplayer", "Media Player"),
    ("wmplayer", "Windows Media Player"),
    ("tidal", "TIDAL"),
    ("deezer", "Deezer"),
    ("amazonmusic", "Amazon Music"),
    ("soundcloud", "SoundCloud"),
    ("foobar2000", "foobar2000"),
    ("aimp", "AIMP"),
    ("musicbee", "MusicBee"),
    ("vlc", "VLC"),
    ("mpv", "mpv"),
];

// ---------------------------------------------------------------------------
// Session enumeration and the "current or best" selection logic.
// ---------------------------------------------------------------------------

/// A session plus the cheap, synchronously-readable fields we use to choose
/// which session to describe. Media properties are read later, only for the
/// chosen session, because `TryGetMediaPropertiesAsync` is an async WinRT call.
#[derive(Clone)]
struct Candidate {
    session: GlobalSystemMediaTransportControlsSession,
    source_app_id: String,
    playback: PlaybackState,
}

pub fn session_id(session: &GlobalSystemMediaTransportControlsSession) -> String {
    session
        .SourceAppUserModelId()
        .map(|h| h.to_string())
        .unwrap_or_default()
}

fn playback_of(session: &GlobalSystemMediaTransportControlsSession) -> PlaybackState {
    session
        .GetPlaybackInfo()
        .and_then(|p| p.PlaybackStatus())
        .map(PlaybackState::from_gsmtc)
        .unwrap_or(PlaybackState::Closed)
}

fn collect_candidates(manager: &SessionManager) -> Vec<Candidate> {
    let mut out = Vec::new();
    match manager.GetSessions() {
        Ok(sessions) => {
            let count = sessions.Size().unwrap_or(0);
            out.reserve(count as usize);
            for i in 0..count {
                match sessions.GetAt(i) {
                    Ok(session) => {
                        let id = session_id(&session);
                        let playback = playback_of(&session);
                        out.push(Candidate {
                            session,
                            source_app_id: id,
                            playback,
                        });
                    }
                    Err(e) => {
                        diag::gsmtc(&format!(
                            "GetSessions().GetAt({i}) failed: {} hr={}",
                            e.message(),
                            hr_hex(&e)
                        ));
                    }
                }
            }
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "GetSessions failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
        }
    }
    out
}

/// A stable summary of the whole session collection. Logged whenever it changes
/// so we can see every session Windows exposes without flooding the log.
fn candidates_summary(candidates: &[Candidate]) -> String {
    if candidates.is_empty() {
        return "sessions: (none)".to_string();
    }
    let mut s = format!("sessions({}):", candidates.len());
    for (i, c) in candidates.iter().enumerate() {
        s.push_str(&format!(
            " [{i}] id=\"{}\" {}",
            c.source_app_id,
            playback_label(c.playback)
        ));
    }
    s
}

fn playback_label(p: PlaybackState) -> &'static str {
    match p {
        PlaybackState::Closed => "closed",
        PlaybackState::Opened => "opened",
        PlaybackState::Changing => "changing",
        PlaybackState::Stopped => "stopped",
        PlaybackState::Playing => "playing",
        PlaybackState::Paused => "paused",
    }
}

/// A transport action requested from the overlay's playback controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
}

/// Resolves the session `transport`/`seek` must act on.
///
/// Uses exactly the same `pick_best` ranking as `snapshot`, so a command can
/// never target a different session than the one the overlay is showing.
fn target_session(manager: &SessionManager) -> Option<GlobalSystemMediaTransportControlsSession> {
    let current = manager.GetCurrentSession().ok();
    let current_id = current
        .as_ref()
        .map(session_id)
        .filter(|id| !id.is_empty());
    let mut candidates = collect_candidates(manager);
    if let Some(session) = current.as_ref() {
        let id = session_id(session);
        if !id.is_empty() && !candidates.iter().any(|c| c.source_app_id == id) {
            let playback = playback_of(session);
            candidates.push(Candidate {
                session: session.clone(),
                source_app_id: id,
                playback,
            });
        }
    }
    pick_best(current_id.as_deref(), &candidates).map(|c| c.session.clone())
}

/// Moves the active session's playback position to `position_ms`.
///
/// Reuses the same session selection as `transport`/`snapshot`, and the same
/// read-back-after-command discipline, so callers reconcile with reality rather
/// than assuming the seek landed.
pub fn seek(manager: &SessionManager, position_ms: i64) -> Result<PlaybackState, String> {
    let target = position_ms.max(0);
    let session =
        target_session(manager).ok_or_else(|| "no active media session".to_string())?;

    // Seekable range comes from the timeline; clamp so a stale lyric timestamp
    // can never push the player past the end of the track.
    let timeline = session.GetTimelineProperties().ok();
    let (min, max) = timeline
        .as_ref()
        .map(|t| {
            (
                t.StartTime().map(|d| d.Duration as i64).unwrap_or(0),
                t.EndTime().map(|d| d.Duration as i64).unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    let clamped = if max > min {
        target.clamp(min, max)
    } else {
        target
    };

    let pos = windows::Foundation::TimeSpan {
        Duration: clamped.saturating_mul(10_000) as i64,
    };

    match session
        .TryChangePlaybackPositionAsync(pos.Duration)
        .and_then(wait_for_async)
    {
        Ok(true) => {
            diag::gsmtc(&format!("seek accepted: pos={clamped}ms"));
        }
        Ok(false) => {
            diag::gsmtc(&format!("seek refused by the session: pos={clamped}ms"));
            return Err("seek was refused by the media session".into());
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "seek failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
            return Err(format!("seek failed: {}", e.message()));
        }
    }

    // Let the player publish the new position before reading state back.
    for _ in 0..8 {
        thread::sleep(Duration::from_millis(30));
        let state = playback_of(&session);
        if state.is_playing() || state == PlaybackState::Paused {
            return Ok(state);
        }
    }
    Ok(playback_of(&session))
}

impl Transport {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "play" => Some(Self::Play),
            "pause" => Some(Self::Pause),
            "toggle" => Some(Self::Toggle),
            "next" => Some(Self::Next),
            "previous" | "prev" => Some(Self::Previous),
            _ => None,
        }
    }
}

/// Performs a transport action on the session the overlay is currently showing.
///
/// Deliberately reuses `pick_best`, the same selector `snapshot` uses, so the
/// buttons always act on the identical session whose lyrics are on screen —
/// never on a second, independently-chosen session.
///
/// Returns the playback state read back *after* the command, so the caller can
/// reconcile the UI with what the system actually did rather than assuming the
/// command succeeded.
pub fn transport(manager: &SessionManager, action: Transport) -> Result<PlaybackState, String> {
    // Resolve the target session exactly as `snapshot` does.
    let session = target_session(manager).ok_or_else(|| "no active media session".to_string())?;
    let session = &session;
    let chosen_playback = playback_of(session);

    // GSMTC only exposes async transport methods; they are awaited on this
    // (blocking) worker-pool thread.
    let outcome = match action {
        Transport::Play => session.TryPlayAsync().and_then(wait_for_async),
        Transport::Pause => session.TryPauseAsync().and_then(wait_for_async),
        Transport::Toggle => if playback_of(session).is_playing() {
            // Decide from live state, not from anything cached in the frontend.
            session.TryPauseAsync().and_then(wait_for_async)
        } else {
            session.TryPlayAsync().and_then(wait_for_async)
        },
        Transport::Next => session.TrySkipNextAsync().and_then(wait_for_async),
        Transport::Previous => session.TrySkipPreviousAsync().and_then(wait_for_async),
    };

    match outcome {
        Ok(true) => {
            diag::gsmtc(&format!("transport {action:?} accepted"));
        }
        Ok(false) => {
            // The app refused the action (e.g. no next track, or a transition
            // in progress). Not fatal: report it so the UI can resync.
            diag::gsmtc(&format!("transport {action:?} refused by the session"));
            return Err(format!("{action:?} was refused by the media session"));
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "transport {action:?} failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
            return Err(format!("{action:?} failed: {}", e.message()));
        }
    }

    // Give the player a moment to publish the new state, then read it back.
    // Without this the very next poll can still return the pre-action status.
    for _ in 0..8 {
        thread::sleep(Duration::from_millis(40));
        let state = playback_of(session);
        if action == Transport::Toggle || state != chosen_playback {
            return Ok(state);
        }
    }
    Ok(playback_of(session))
}

/// Picks the session that should drive the overlay:
/// 1. the first actively *playing* session,
/// 2. otherwise the system "current" session,
/// 3. otherwise the first session that has a non-empty source id.
fn pick_best<'a>(current_id: Option<&str>, candidates: &'a [Candidate]) -> Option<&'a Candidate> {
    if let Some(c) = candidates.iter().find(|c| c.playback.is_playing()) {
        return Some(c);
    }
    if let Some(id) = current_id.filter(|id| !id.is_empty()) {
        if let Some(c) = candidates.iter().find(|c| c.source_app_id == id) {
            return Some(c);
        }
    }
    candidates.iter().find(|c| !c.source_app_id.is_empty())
}

/// Throttled logger keys. Kept in a process-wide cache so we log session list
/// and state changes without spamming the log at the 500ms poll cadence.
#[derive(Default)]
struct DiagState {
    last_current: Option<String>,
    last_summary: Option<String>,
}

fn diag_cache() -> &'static Mutex<DiagState> {
    static CACHE: OnceLock<Mutex<DiagState>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(DiagState::default()))
}

/// Reads full metadata for a specific session. Errors are logged; missing
/// fields simply remain empty so the snapshot is always best-effort.
fn read_session(session: &GlobalSystemMediaTransportControlsSession) -> TrackSnapshot {
    let source_app_id = session_id(session);
    let mut snapshot = TrackSnapshot {
        has_session: true,
        source_app_name: friendly_app_name(&source_app_id),
        source_app_id,
        ..TrackSnapshot::empty()
    };

    match session
        .TryGetMediaPropertiesAsync()
        .and_then(wait_for_async)
    {
        Ok(props) => {
            snapshot.title = props.Title().map(|h| h.to_string()).unwrap_or_default();
            snapshot.artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
            if snapshot.artist.is_empty() {
                snapshot.artist =
                    props.AlbumArtist().map(|h| h.to_string()).unwrap_or_default();
            }
            snapshot.album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "TryGetMediaPropertiesAsync failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
        }
    }

    if let Ok(info) = session.GetPlaybackInfo() {
        if let Ok(status) = info.PlaybackStatus() {
            snapshot.playback_state = PlaybackState::from_gsmtc(status);
        }
    } else {
        diag::gsmtc("GetPlaybackInfo failed");
    }

    if let Ok(timeline) = session.GetTimelineProperties() {
        let (position, duration) = read_timeline(&timeline);
        snapshot.position_ms = position;
        snapshot.duration_ms = duration;
    }

    snapshot.sampled_at_ms = now_unix_ms();
    snapshot
}

/// Reads a snapshot of the active media, preferentially choosing a *playing*
/// session and falling back to `GetCurrentSession()` / the full session list.
pub fn snapshot(manager: &SessionManager) -> TrackSnapshot {
    // Current session (may legitimately be null when nothing is "current").
    let current: Option<(GlobalSystemMediaTransportControlsSession, String)> =
        match manager.GetCurrentSession() {
            Ok(session) => {
                let id = session_id(&session);
                let mut cache = diag_cache().lock().unwrap_or_else(|e| e.into_inner());
                if cache.last_current.as_deref() != Some(id.as_str()) {
                    cache.last_current = Some(id.clone());
                    diag::gsmtc(&format!("GetCurrentSession -> \"{id}\""));
                }
                Some((session, id))
            }
            Err(e) => {
                let mut cache = diag_cache().lock().unwrap_or_else(|e| e.into_inner());
                if cache.last_current.is_some() {
                    cache.last_current = None;
                    diag::gsmtc(&format!(
                        "GetCurrentSession -> none ({} hr={})",
                        e.message(),
                        hr_hex(&e)
                    ));
                }
                None
            }
        };

    let mut candidates = collect_candidates(manager);

    // Make sure the current session is considered even if it did not appear in
    // `GetSessions()` for some reason.
    if let Some((session, id)) = &current {
        if !id.is_empty() && !candidates.iter().any(|c| c.source_app_id == *id) {
            candidates.push(Candidate {
                session: session.clone(),
                source_app_id: id.clone(),
                playback: playback_of(session),
            });
        }
    }

    let summary = candidates_summary(&candidates);
    {
        let mut cache = diag_cache().lock().unwrap_or_else(|e| e.into_inner());
        if cache.last_summary.as_deref() != Some(summary.as_str()) {
            cache.last_summary = Some(summary.clone());
            diag::gsmtc(&summary);
        }
    }

    let current_id = current.as_ref().map(|(_, id)| id.as_str());
    match pick_best(current_id, &candidates) {
        Some(chosen) => read_session(&chosen.session),
        None => {
            diag::gsmtc("no usable media session found");
            TrackSnapshot::empty()
        }
    }
}

/// Current wall-clock time in unix milliseconds.
pub fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Position and duration in milliseconds, clamped into the seekable window.
fn read_timeline(timeline: &TimelineProperties) -> (i64, i64) {
    let ms = |t: windows::core::Result<TimeSpan>| t.map(|t| t.Duration).unwrap_or(0) / 10_000;
    let start = ms(timeline.StartTime());
    let end = ms(timeline.EndTime());
    let max_seek = ms(timeline.MaxSeekTime());
    let position = ms(timeline.Position());

    let mut duration = end - start;
    if duration <= 0 {
        duration = max_seek;
    }
    let mut relative = (position - start).max(0);
    if duration > 0 && relative > duration {
        relative = duration;
    }
    (relative, duration.max(0))
}

/// Initializes the Windows Runtime as a multithreaded apartment for the
/// *calling* thread.
///
/// The `Windows.Media.Control` factory itself activates fine from MTA; the real
/// requirement is using a proper async wait (see [`wait_for_async`]) instead of
/// the raw, non-blocking `IAsyncOperation::GetResults`.
///
/// Deliberately not wrapped in a `OnceLock`: this is per-thread state and must
/// actually run on the dedicated worker thread.
pub fn init_mta() -> windows::core::Result<()> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    let result: windows::core::Result<()> = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    match result {
        Ok(()) => {
            diag::gsmtc("RoInitialize(RO_INIT_MULTITHREADED) OK");
            Ok(())
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "RoInitialize failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
            if e.code() == RPC_E_CHANGED_MODE {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// Blocks for a WinRT async operation to complete, then returns its result.
///
/// The raw ABI `IAsyncOperation::GetResults` is *not* a blocking wait: it must
/// only be called once the operation is complete and otherwise fails with
/// `E_ILLEGAL_METHOD_CALL`. This helper subscribes to `Completed`, waits for
/// that signal on a channel (the completion handler runs on the WinRT thread
/// pool), then calls `GetResults`.
pub(crate) fn wait_for_async<T>(op: IAsyncOperation<T>) -> windows::core::Result<T>
where
    T: windows::core::RuntimeType + 'static,
{
    let (tx, rx) = mpsc::channel::<()>();
    let handler = AsyncOperationCompletedHandler::<T>::new(move |_op, _status| {
        let _ = tx.send(());
        Ok(())
    });

    match op.SetCompleted(&handler) {
        Ok(()) => {
            // Completion is signaled from a background apartment thread.
            let _ = rx.recv_timeout(Duration::from_secs(15));
        }
        Err(_) => {
            // The operation had already completed before we subscribed; the
            // subsequent `GetResults` will work immediately.
        }
    }

    op.GetResults()
}

// ---------------------------------------------------------------------------
// Event subscriptions
//
// The returned `TypedEventHandler` MUST be kept alive by the caller for as long
// as the subscription should last. Dropping it releases the COM delegate, which
// invalidates the subscription (WinRT does not take an owning reference).
// ---------------------------------------------------------------------------

pub fn subscribe_sessions_changed<F>(
    manager: &SessionManager,
    handler: F,
) -> Option<windows::Foundation::TypedEventHandler<SessionManager, SessionsChangedEventArgs>>
where
    F: FnMut(
            &Option<SessionManager>,
            &Option<SessionsChangedEventArgs>,
        ) -> windows::core::Result<()>
        + Send
        + 'static,
{
    let typed = windows::Foundation::TypedEventHandler::<
        SessionManager,
        SessionsChangedEventArgs,
    >::new(handler);
    match manager.SessionsChanged(&typed) {
        Ok(_) => {
            diag::gsmtc("subscribed SessionsChanged");
            Some(typed)
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "SessionsChanged subscribe failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
            None
        }
    }
}

/// Subscribes to `PlaybackInfoChanged` on a single session.
///
/// This fires on play/pause **and on seek**, and is the fastest signal that the
/// playback position moved. It is re-subscribed whenever the dominant session
/// changes (see `media_worker`). The returned handler must be kept alive.
pub fn subscribe_playback_info_changed<F>(
    session: &GlobalSystemMediaTransportControlsSession,
    handler: F,
) -> Option<
    windows::Foundation::TypedEventHandler<
        GlobalSystemMediaTransportControlsSession,
        PlaybackInfoChangedEventArgs,
    >,
>
where
    F: FnMut(
            &Option<GlobalSystemMediaTransportControlsSession>,
            &Option<PlaybackInfoChangedEventArgs>,
        ) -> windows::core::Result<()>
        + Send
        + 'static,
{
    let typed = windows::Foundation::TypedEventHandler::<
        GlobalSystemMediaTransportControlsSession,
        PlaybackInfoChangedEventArgs,
    >::new(handler);
    match session.PlaybackInfoChanged(&typed) {
        Ok(_) => {
            diag::gsmtc("subscribed PlaybackInfoChanged");
            Some(typed)
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "PlaybackInfoChanged subscribe failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
            None
        }
    }
}

pub fn subscribe_current_session_changed<F>(
    manager: &SessionManager,
    handler: F,
) -> Option<windows::Foundation::TypedEventHandler<SessionManager, CurrentSessionChangedEventArgs>>
where
    F: FnMut(
            &Option<SessionManager>,
            &Option<CurrentSessionChangedEventArgs>,
        ) -> windows::core::Result<()>
        + Send
        + 'static,
{
    let typed = windows::Foundation::TypedEventHandler::<
        SessionManager,
        CurrentSessionChangedEventArgs,
    >::new(handler);
    match manager.CurrentSessionChanged(&typed) {
        Ok(_) => {
            diag::gsmtc("subscribed CurrentSessionChanged");
            Some(typed)
        }
        Err(e) => {
            diag::gsmtc(&format!(
                "CurrentSessionChanged subscribe failed: {} hr={}",
                e.message(),
                hr_hex(&e)
            ));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artist: &str, album: &str) -> TrackSnapshot {
        TrackSnapshot {
            has_session: true,
            title: title.into(),
            artist: artist.into(),
            album: album.into(),
            ..TrackSnapshot::empty()
        }
    }

    #[test]
    fn friendly_names_are_mapped() {
        assert_eq!(
            friendly_app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
            "Spotify"
        );
        assert_eq!(
            friendly_app_name("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"),
            "Apple Music"
        );
        assert_eq!(friendly_app_name("MSEdge"), "Microsoft Edge");
        assert_eq!(friendly_app_name(""), "Unknown");
        assert_eq!(friendly_app_name("SomeVendor.SomeApp!Run"), "SomeApp");
    }

    #[test]
    fn empty_snapshot_has_no_key() {
        assert_eq!(TrackSnapshot::empty().track_key(), "");
    }

    #[test]
    fn track_key_changes_with_title() {
        assert_ne!(
            track("Midnight", "Artist", "Album").track_key(),
            track("Other", "Artist", "Album").track_key()
        );
    }

    #[test]
    fn playback_state_mapping() {
        assert_eq!(
            PlaybackState::from_gsmtc(PlaybackStatus::Playing),
            PlaybackState::Playing
        );
        assert_eq!(
            PlaybackState::from_gsmtc(PlaybackStatus::Paused),
            PlaybackState::Paused
        );
    }

    /// Every action the frontend may send must parse; `toggle` is the one the
    /// play/pause button uses, since the button reflects live state rather than
    /// deciding direction itself.
    #[test]
    fn transport_actions_parse() {
        assert_eq!(Transport::parse("toggle"), Some(Transport::Toggle));
        assert_eq!(Transport::parse("play"), Some(Transport::Play));
        assert_eq!(Transport::parse("pause"), Some(Transport::Pause));
        assert_eq!(Transport::parse("next"), Some(Transport::Next));
        assert_eq!(Transport::parse("previous"), Some(Transport::Previous));
        assert_eq!(Transport::parse("prev"), Some(Transport::Previous));
    }

    /// Unknown actions are rejected before touching any media session.
    #[test]
    fn unknown_transport_actions_are_rejected() {
        for bad in ["", "Toggle", "PLAY", "skip", "mute", "next "] {
            assert_eq!(Transport::parse(bad), None, "\"{bad}\" should not parse");
        }
    }

    /// The play/pause button's icon and its `aria-pressed` state both follow
    /// this predicate, so a non-playing state must never read as "playing".
    #[test]
    fn only_playing_reads_as_playing() {
        assert!(PlaybackState::Playing.is_playing());
        for s in [
            PlaybackState::Paused,
            PlaybackState::Stopped,
            PlaybackState::Changing,
            PlaybackState::Opened,
            PlaybackState::Closed,
        ] {
            assert!(!s.is_playing(), "{s:?} must not read as playing");
        }
    }
}
