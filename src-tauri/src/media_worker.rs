//! Owns the GSMTC session manager on a dedicated MTA thread.
//!
//! Windows WinRT objects are apartment-bound, so all GSMTC calls and event
//! callbacks stay on one thread. Events are pushed into a `watch` channel that
//! the Tauri layer consumes to emit to the webviews.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    PlaybackInfoChangedEventArgs,
};

use crate::diag;
use crate::gsmtc::{self, TrackSnapshot};

/// How often the GSMTC session is sampled.
const POLL: Duration = Duration::from_millis(250);
/// How often a snapshot is *published* when nothing but time advances.
const TICK: Duration = Duration::from_millis(250);
/// Maximum wall-clock gap (ms) that a seek prediction may account for.
///
/// The worker samples every 250 ms, but Spotify only publishes
/// `TimelineProperties` in coarse steps of roughly 4.5 s. The prediction must
/// therefore be allowed to cover at least one full coarse step, otherwise every
/// normal update looks like a forward jump. The cap exists only to stop a long
/// stall (e.g. the machine was suspended) from making a huge jump look like
/// playback.
const MAX_PREDICT_MS: i64 = 8_000;
/// Guard band added to every prediction to absorb sampling jitter.
const SEEK_PREDICT_SLACK_MS: i64 = 1_500;

/// Decides whether a position change is a seek rather than normal playback.
///
/// `expected` is where playback *should* be now, derived from the previous
/// reported position plus the wall-clock time that actually elapsed (capped so
/// coarse player updates cannot masquerade as playback). A backward move is
/// always a seek; a forward jump is a seek only if it overshoots that
/// prediction by more than the slack.
///
/// This is a free function so the exact decision can be unit tested without a
/// GSMTC session.
pub fn is_seek(prev_pos_ms: i64, new_pos_ms: i64, elapsed_ms: i64) -> bool {
    let delta = new_pos_ms - prev_pos_ms;
    if delta < 0 {
        // Playback never rewinds on its own.
        return true;
    }
    let predict = elapsed_ms.clamp(0, MAX_PREDICT_MS);
    delta > predict + SEEK_PREDICT_SLACK_MS
}

/// Shared, cloneable state that the Tauri layer polls for details.
#[derive(Clone)]
pub struct MediaHandle {
    pub tx: tokio::sync::watch::Sender<TrackSnapshot>,
    pub rx: tokio::sync::watch::Receiver<TrackSnapshot>,
    manager: Arc<Mutex<Option<SessionManager>>>,
    // Ticks counter: signals the worker thread to refresh the snapshot.
    // Used only as a safety net; the primary path is WinRT events.
    pub last_event: Arc<AtomicBool>,
    pub started: Arc<AtomicBool>,
}

impl MediaHandle {
    pub fn current(&self) -> TrackSnapshot {
        self.rx.borrow().clone()
    }

    /// Runs a transport action against the manager the worker is monitoring.
    ///
    /// `None` means the worker has not acquired a session manager yet (still
    /// starting up), which the command surfaces as "no active media session".
    pub fn transport(&self, action: gsmtc::Transport) -> Option<Result<gsmtc::PlaybackState, String>> {
        let guard = self.manager.lock().ok()?;
        let manager = guard.as_ref()?;
        Some(gsmtc::transport(manager, action))
    }

    /// Seeks the active session to `position_ms`, using the same manager and
    /// session selection as `transport` and `snapshot`.
    pub fn seek(&self, position_ms: i64) -> Option<Result<gsmtc::PlaybackState, String>> {
        let guard = self.manager.lock().ok()?;
        let manager = guard.as_ref()?;
        Some(gsmtc::seek(manager, position_ms))
    }

    /// Asks the worker to refresh immediately after a transport action, so the
    /// overlay reflects the new state without waiting for the next poll tick.
    pub fn poke(&self) {
        self.last_event.store(true, Ordering::Relaxed);
    }
}


/// Starts the media worker thread. Safe to call once.
pub fn start() -> MediaHandle {
    let (tx, rx) = tokio::sync::watch::channel(TrackSnapshot::empty());
    let handle = MediaHandle {
        tx,
        rx,
        manager: Arc::new(Mutex::new(None)),
        last_event: Arc::new(AtomicBool::new(false)),
        started: Arc::new(AtomicBool::new(false)),
    };

    let worker_handle = handle.clone();
    let spawned = thread::Builder::new()
        .name("gsmtc-worker".into())
        .spawn(move || worker_loop(worker_handle));

    if let Err(e) = spawned {
        log::error!("failed to spawn media worker thread: {e}");
    }
    handle
}

/// Blocks the calling (worker) thread until the process exits.
fn worker_loop(handle: MediaHandle) {
    diag::media("worker thread started");

    if let Err(e) = gsmtc::init_mta() {
        diag::media(&format!("WinRT initialization FAILED: {e}"));
        log::error!("WinRT initialization failed: {e}");
        return;
    }

    // Retry until the manager is available: RequestAsync can fail while the
    // Windows shell is still starting up.
    let manager = loop {
        let operation = match SessionManager::RequestAsync() {
            Ok(op) => op,
            Err(e) => {
                diag::gsmtc(&format!(
                    "RequestAsync failed: {} (code=0x{:08X}), retrying in 2s",
                    e.message(),
                    e.code().0 as u32
                ));
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        diag::gsmtc("RequestAsync returned IAsyncOperation; awaiting completion…");
        match gsmtc::wait_for_async(operation) {
            Ok(m) => {
                diag::gsmtc("RequestAsync completed — session manager acquired");
                break m;
            }
            Err(e) => {
                diag::gsmtc(&format!(
                    "RequestAsync completion failed: {} (code=0x{:08X}), retrying in 2s",
                    e.message(),
                    e.code().0 as u32
                ));
                thread::sleep(Duration::from_secs(2));
            }
        }
    };

    if let Ok(mut guard) = handle.manager.lock() {
        *guard = Some(manager.clone());
    }
    handle.started.store(true, Ordering::Relaxed);
    diag::media("session manager ready; registering events");

    // Startup discovery: publish whatever is *already* playing right now,
    // before any event subscription exists.
    //
    // Previously the first snapshot was only produced by the polling loop, and
    // the loop's `last`/`last_pos_ms` bookkeeping made the very first sample
    // indistinguishable from "nothing changed" for downstream logic. Worse, if
    // Spotify was already playing when Lynricsx launched, the app could sit on
    // an empty snapshot until the user paused/played. Publishing here makes an
    // already-active session visible immediately, and guarantees the lyric
    // pipeline has a real track to work with on the first poll.
    {
        let initial = gsmtc::snapshot(&manager);
        let mut published = initial.clone();
        published.sampled_at_ms = gsmtc::now_unix_ms();
        if published.has_session {
            diag::gsmtc(&format!(
                "INITIAL session detected: title=\"{}\" artist=\"{}\" status={:?} pos={}ms",
                published.title, published.artist, published.playback_state, published.position_ms
            ));
        } else {
            diag::gsmtc("INITIAL session: none yet (waiting for media)");
        }
        let _ = handle.tx.send_replace(published);
    }

    // React to sessions appearing/disappearing and to the dominant session
    // changing (e.g. switching from a paused Spotify to a playing browser).
    // Keep the handlers alive for the lifetime of the worker thread.
    let sessions_flag = handle.last_event.clone();
    let _keep_sessions = gsmtc::subscribe_sessions_changed(&manager, move |_, _| {
        diag::gsmtc("SessionsChanged event received");
        sessions_flag.store(true, Ordering::Relaxed);
        Ok(())
    });

    let current_flag = handle.last_event.clone();
    let _keep_current = gsmtc::subscribe_current_session_changed(&manager, move |_, _| {
        diag::gsmtc("CurrentSessionChanged event received");
        current_flag.store(true, Ordering::Relaxed);
        Ok(())
    });

    // `PlaybackInfoChanged` covers play/pause/seek on a *session*. It has to be
    // (re)registered on the dominant session and re-armed when that session
    // changes, so the worker keeps exactly one live subscription.
    let mut keep_info: Option<
        windows::Foundation::TypedEventHandler<
            GlobalSystemMediaTransportControlsSession,
            PlaybackInfoChangedEventArgs,
        >,
    > = None;
    let mut info_session_id = String::new();

    let mut last: Option<TrackSnapshot> = None;
    let mut last_position_bucket: i64 = -1;
    // Wall-clock instant of the previous sample, used to predict where the
    // position *should* be. A deviation beyond the seek threshold means the
    // user scrubbed, jumped to a marker, or the player restarted the track.
    let mut last_sample_at = std::time::Instant::now();
    let mut last_pos_ms: i64 = 0;
    // (no longer needed: seek detection works from position + elapsed time)
    let mut seek_seq: u64 = 0;
    let mut track_seq: u64 = 0;
    let mut next_tick = std::time::Instant::now();

    loop {
        let now = std::time::Instant::now();
        if now >= next_tick {
            next_tick = now + TICK;
            // Consume the event flag: an event only forces an immediate sample,
            // it never suppresses the regular tick (otherwise a single missed
            // event would freeze lyric updates).
            handle.last_event.store(false, Ordering::Relaxed);

            // Keep the seek/play-pause subscription pointed at the dominant
            // session. GSMsTC only exposes PlaybackInfoChanged per session.
            if let Ok(current) = manager.GetCurrentSession() {
                let id = gsmtc::session_id(&current);
                if id != info_session_id {
                    info_session_id = id;
                    let flag = handle.last_event.clone();
                    keep_info = gsmtc::subscribe_playback_info_changed(&current, move |_, _| {
                        flag.store(true, Ordering::Relaxed);
                        Ok(())
                    });
                }
            } else if !info_session_id.is_empty() {
                info_session_id.clear();
                keep_info = None;
            }

            let snapshot = gsmtc::snapshot(&manager);
            let bucket = snapshot.position_ms / 1000;
            let playing = snapshot.playback_state.is_playing();
            let elapsed_ms = now.duration_since(last_sample_at).as_millis() as i64;

            // A seek is a position change that playback alone cannot explain.
            // IMPORTANT: evaluate this against `last_pos_ms` (the previously
            // *published* position) BEFORE it is updated in the publish branch.
            let prev_published_pos = last_pos_ms;
            let seeked = last.is_some()
                && snapshot.has_session
                && !snapshot.track_key().is_empty()
                && is_seek(prev_published_pos, snapshot.position_ms, elapsed_ms);

            let track_changed = match &last {
                None => true,
                Some(prev) => {
                    prev.has_session != snapshot.has_session
                        || prev.track_key() != snapshot.track_key()
                        || prev.playback_state != snapshot.playback_state
                        || prev.duration_ms / 1000 != snapshot.duration_ms / 1000
                        || prev.source_app_id != snapshot.source_app_id
                }
            };

            // Bookkeeping NOTE: `last_pos_ms` and `last_sample_at` must describe
            // the *last published* sample, not the last polled one. Updating
            // them on skipped ticks made the next comparison read the same
            // value twice (`delta == 0`), which is why normal playback showed
            // up as a seek. They are therefore updated inside the publish
            // branch below, together with `last`.


            if track_changed || seeked || (playing && bucket != last_position_bucket) {
                if track_changed {
                    if snapshot.has_session {
                        diag::gsmtc(&format!(
                            "TRACK title=\"{}\" artist=\"{}\" album=\"{}\" app=\"{}\" id=\"{}\" status={:?} dur={}ms pos={}ms",
                            snapshot.title,
                            snapshot.artist,
                            snapshot.album,
                            snapshot.source_app_name,
                            snapshot.source_app_id,
                            snapshot.playback_state,
                            snapshot.duration_ms,
                            snapshot.position_ms,
                        ));
                    } else {
                        diag::gsmtc("TRACK none (no media)");
                    }
                } else if seeked {
                    diag::gsmtc(&format!(
                        "SEEK detected: pos={}ms (previous {}ms)",
                        snapshot.position_ms, prev_published_pos
                    ));
                }
                last_position_bucket = bucket;
                if seeked {
                    seek_seq += 1;
                }
                if track_changed {
                    track_seq += 1;
                }
                // Record the published sample: subsequent seek comparisons are
                // made against THIS position and THIS timestamp.
                last_pos_ms = snapshot.position_ms;
                last_sample_at = now;
                let mut published = snapshot.clone();
                published.seek_seq = seek_seq;
                published.track_seq = track_seq;
                // Stamp the sample time at publication. The frontend derives its
                // live position as `positionMs + (now - sampledAtMs)`, so this
                // must be the moment the value was taken — not a stale instant
                // carried from `gsmtc::snapshot()`, otherwise the extrapolation
                // runs ahead of the real position and a backward seek can be
                // silently absorbed as "normal playback".
                published.sampled_at_ms = gsmtc::now_unix_ms();
                last = Some(snapshot);
                let _ = handle.tx.send_replace(published);
            }
        }
        thread::sleep(POLL);
        // Keep the COM delegation alive for as long as it is installed.
        let _ = &keep_info;
    }
}

#[cfg(test)]
mod tests {
    use super::{is_seek, MAX_PREDICT_MS, SEEK_PREDICT_SLACK_MS};

    #[test]
    fn normal_playback_is_not_a_seek() {
        // Real Spotify behaviour observed in the field: the position advances in
        // ~4.5 s steps, published on the same cadence.
        assert!(!is_seek(77_546, 82_060, 4_520));
        assert!(!is_seek(82_060, 86_568, 4_541));
        assert!(!is_seek(86_568, 91_079, 4_535));
        assert!(!is_seek(91_079, 95_586, 4_533));
        // A coarse 5 s step sampled 250 ms apart is still playback.
        assert!(!is_seek(10_000, 15_000, 250));
        // Steady 250 ms progression.
        assert!(!is_seek(10_000, 10_250, 250));
    }

    #[test]
    fn a_backward_jump_is_always_a_seek() {
        assert!(is_seek(120_000, 119_900, 250), "any rewind counts");
        assert!(is_seek(120_000, 15_000, 250), "scrub backwards");
        assert!(is_seek(90_000, 0, 5_000), "restart track");
    }

    #[test]
    fn a_large_forward_scrub_is_a_seek() {
        assert!(is_seek(10_000, 70_000, 250));
        assert!(is_seek(0, 120_000, 1_000));
    }

    #[test]
    fn a_seek_is_detected_even_when_the_elapsed_gap_is_large() {
        // The prediction is capped, so a long stall cannot disguise a jump.
        let over_cap = MAX_PREDICT_MS + SEEK_PREDICT_SLACK_MS + 1;
        assert!(is_seek(0, over_cap, 60_000));
        // ...while a jump merely equal to the cap is still treated as playback.
        assert!(!is_seek(0, MAX_PREDICT_MS, 60_000));
    }

    #[test]
    fn pause_does_not_look_like_a_seek() {
        assert!(!is_seek(95_822, 95_822, 1_000));
        assert!(!is_seek(95_822, 95_900, 1_000), "rounding drift");
    }

    #[test]
    fn a_forward_seek_within_the_slack_is_playback() {
        // Advance consistent with elapsed time plus slack is fine.
        let expected = 250 + SEEK_PREDICT_SLACK_MS;
        assert!(!is_seek(1_000, 1_000 + expected, 250));
        assert!(is_seek(1_000, 1_000 + expected + 1, 250));
    }

    #[test]
    fn a_seek_is_still_caught_despite_coarse_player_updates() {
        // 60 s forward while the previous sample was 4.5 s old is unmistakable.
        assert!(is_seek(10_000, 70_000, 4_500));
        // Large backward jumps remain detected regardless of step size.
        assert!(is_seek(120_000, 3_000, 4_500));
    }
}
