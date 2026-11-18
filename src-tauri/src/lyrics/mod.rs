//! Lyrics providers. LRCLIB is the bundled provider; the trait keeps the door
//! open for additional backends (Genius, Musixmatch, local `.lrc` files, ...).

pub mod cache;
pub mod liriqo;
pub mod lrc;
pub mod lrclib;
pub mod selection;

use serde::Serialize;

pub use lrc::LyricLine;

/// Result of a lyrics lookup.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    pub lines: Vec<LyricLine>,
    /// True when `lines` carry usable line timestamps.
    pub synced: bool,
    /// True when `lines` carry native word/syllable timing.
    pub word_synced: bool,
    /// Native granularity where available: "word", "syllable", "phrase", or "".
    pub word_granularity: String,
    pub instrumental: bool,
    /// Provider that produced the result (e.g. "liriqo", "lrclib").
    pub source: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
}

impl LyricsResult {
    /// A "no lyrics found" result for the given track.
    pub fn not_found(title: &str, artist: &str, album: &str) -> Self {
        Self {
            title: title.to_string(),
            artist: artist.to_string(),
            album: album.to_string(),
            ..Self::default()
        }
    }
}

/// A track to look lyrics up for.
#[derive(Debug, Clone, Default)]
pub struct TrackQuery {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_s: Option<i64>,
}

impl TrackQuery {
    /// Cache key. Duration is intentionally excluded so that slightly differing
    /// durations reported by different players do not fragment the cache.
    pub fn cache_key(&self) -> String {
        crate::lyrics::cache::normalize_key(&self.title, &self.artist)
    }
}

/// Provider-agnostic error type that surfaces friendly messages to the UI.
#[derive(Debug)]
pub enum LyricsError {
    Network(String),
    RateLimited,
    Provider(String),
}

impl std::fmt::Display for LyricsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(msg) => write!(f, "network error: {msg}"),
            Self::RateLimited => write!(f, "rate limited by provider, try again shortly"),
            Self::Provider(msg) => write!(f, "provider error: {msg}"),
        }
    }
}

impl std::error::Error for LyricsError {}

#[allow(async_fn_in_trait)]
pub trait LyricsProvider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn lookup(&self, query: &TrackQuery) -> Result<Option<LyricsResult>, LyricsError>;
}
