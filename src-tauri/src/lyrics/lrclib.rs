//! LRCLIB provider (<https://lrclib.net>).
//!
//! Lookup strategy:
//! 1. `GET /api/get` with the exact track signature (fast, exact match).
//! 2. Fall back to `GET /api/search` and pick the best candidate by
//!    title/artist/duration similarity.
//!
//! A descriptive `User-Agent` is sent because LRCLIB requires client
//! identification and grants higher rate limits to identified clients.

use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;

use super::lrc::parse_lrc;
use super::{LyricsError, LyricsProvider, LyricsResult, TrackQuery};

const BASE_URL: &str = "https://lrclib.net";
const USER_AGENT: &str = "Lynricsx/0.1.0 (https://github.com/AriepHidayat7/Lynricsx)";

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LrclibRecord {
    #[serde(default)]
    track_name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    album_name: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    plain_lyrics: Option<String>,
    #[serde(default)]
    synced_lyrics: Option<String>,
}

pub struct LrclibProvider {
    client: reqwest::Client,
    base_url: String,
}

impl Default for LrclibProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl LrclibProvider {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(6))
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url: BASE_URL.to_string(),
        }
    }

    /// Test/alternative-instance constructor.
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        let mut p = Self::new();
        p.base_url = base_url.into().trim_end_matches('/').to_string();
        p
    }
}

fn network_error(e: reqwest::Error) -> LyricsError {
    if e.is_timeout() {
        LyricsError::Network("request timed out".into())
    } else if e.is_connect() {
        LyricsError::Network("no internet connection".into())
    } else {
        LyricsError::Network(e.to_string())
    }
}

/// Lowercase + collapse whitespace + normalize smart quotes.
pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace('\u{2019}', "'")
        .replace('\u{201c}', "\"")
        .replace('\u{201d}', "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

impl LrclibProvider {
    async fn get_exact(&self, query: &TrackQuery) -> Result<Option<LrclibRecord>, LyricsError> {
        let mut req = self.client.get(format!("{}/api/get", self.base_url)).query(&[
            ("track_name", query.title.as_str()),
            ("artist_name", query.artist.as_str()),
        ]);
        if !query.album.is_empty() {
            req = req.query(&[("album_name", query.album.as_str())]);
        }
        if let Some(d) = query.duration_s.filter(|d| *d > 0) {
            req = req.query(&[("duration", d.to_string())]);
        }

        let response = req.send().await.map_err(network_error)?;
        match response.status() {
            StatusCode::OK => {
                let record = response.json::<LrclibRecord>().await.map_err(network_error)?;
                Ok(Some(record))
            }
            StatusCode::NOT_FOUND => Ok(None),
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                Err(LyricsError::RateLimited)
            }
            status => Err(LyricsError::Provider(format!("/api/get returned {status}"))),
        }
    }

    async fn search(&self, query: &TrackQuery) -> Result<Vec<LrclibRecord>, LyricsError> {
        let response = self
            .client
            .get(format!("{}/api/search", self.base_url))
            .query(&[
                ("track_name", query.title.as_str()),
                ("artist_name", query.artist.as_str()),
            ])
            .send()
            .await
            .map_err(network_error)?;

        match response.status() {
            StatusCode::OK => response
                .json::<Vec<LrclibRecord>>()
                .await
                .map_err(network_error),
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                Err(LyricsError::RateLimited)
            }
            status => Err(LyricsError::Provider(format!(
                "/api/search returned {status}"
            ))),
        }
    }
}

/// Picks the best record out of the search results using title/artist
/// similarity and, when available, the duration reported by the player.
fn select_best(records: Vec<LrclibRecord>, query: &TrackQuery) -> Option<LrclibRecord> {
    let want_title = normalize(&query.title);
    let want_artist = normalize(&query.artist);

    let has_lyrics = |r: &LrclibRecord| -> bool {
        r.synced_lyrics
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
            || r.plain_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
            || r.instrumental
    };

    let mut scored: Vec<(f64, LrclibRecord)> = records
        .into_iter()
        .filter(has_lyrics)
        .map(|r| {
            let title = normalize(&r.track_name);
            let artist = normalize(&r.artist_name);
            let mut score = 0.0;
            if title == want_title {
                score += 3.0;
            } else if !title.is_empty()
                && (title.contains(&want_title) || want_title.contains(&title))
            {
                score += 1.5;
            }
            if artist == want_artist {
                score += 2.0;
            } else if !want_artist.is_empty()
                && (artist.contains(&want_artist) || want_artist.contains(&artist))
            {
                score += 1.0;
            }
            if r.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty()) {
                score += 1.0;
            }
            if let Some(want) = query.duration_s.filter(|d| *d > 0) {
                let diff = (r.duration.round() as i64 - want).abs();
                score += if diff <= 2 {
                    1.5
                } else if diff <= 5 {
                    0.75
                } else {
                    -(diff.min(60) as f64 / 40.0)
                };
            }
            (score, r)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .next()
        .filter(|(score, _)| *score > 0.0)
        .map(|(_, r)| r)
}

/// Converts an LRCLIB record into a `LyricsResult`, preferring synced LRC.
fn record_to_result(record: LrclibRecord) -> Option<LyricsResult> {
    let synced_text = record
        .synced_lyrics
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let plain_text = record
        .plain_lyrics
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let duration_ms = (record.duration * 1000.0).round() as i64;

    if let Some(lrc_text) = synced_text {
        let parsed = parse_lrc(lrc_text);
        if !parsed.lines.is_empty() {
            return Some(LyricsResult {
                lines: parsed.lines,
                synced: true,
                word_synced: false,
                word_granularity: String::new(),
                instrumental: false,
                source: "lrclib".into(),
                title: record.track_name,
                artist: record.artist_name,
                album: record.album_name,
                duration_ms,
            });
        }
    }

    if let Some(plain) = plain_text {
        return Some(super::cache::plain_result(
            plain,
            &record.track_name,
            &record.artist_name,
            &record.album_name,
            duration_ms,
            "lrclib",
        ));
    }

    if record.instrumental {
        return Some(LyricsResult {
            lines: Vec::new(),
            synced: false,
            word_synced: false,
            word_granularity: String::new(),
            instrumental: true,
            source: "lrclib".into(),
            title: record.track_name,
            artist: record.artist_name,
            album: record.album_name,
            duration_ms,
        });
    }

    None
}

impl LyricsProvider for LrclibProvider {
    fn name(&self) -> &'static str {
        "lrclib"
    }

    async fn lookup(&self, query: &TrackQuery) -> Result<Option<LyricsResult>, LyricsError> {
        if query.title.trim().is_empty() {
            return Ok(None);
        }

        // 1. Exact signature lookup.
        if let Some(record) = self.get_exact(query).await? {
            if let Some(result) = record_to_result(record) {
                return Ok(Some(result));
            }
        }

        // 2. Fuzzy search fallback.
        let records = self.search(query).await?;
        Ok(select_best(records, query).and_then(record_to_result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        title: &str,
        artist: &str,
        duration: f64,
        synced: Option<&str>,
        plain: Option<&str>,
    ) -> LrclibRecord {
        LrclibRecord {
            track_name: title.into(),
            artist_name: artist.into(),
            album_name: "Album".into(),
            duration,
            instrumental: false,
            plain_lyrics: plain.map(str::to_string),
            synced_lyrics: synced.map(str::to_string),
        }
    }

    fn query(title: &str, artist: &str, duration: i64) -> TrackQuery {
        TrackQuery {
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            duration_s: Some(duration),
        }
    }

    #[test]
    fn best_candidate_prefers_exact_title_and_duration() {
        let q = query("Nightcall", "Kavinsky", 258);
        let records = vec![
            record("Nightcall (Live)", "Kavinsky", 300.0, Some("[00:01.00]live"), None),
            record("Nightcall", "Kavinsky", 258.0, Some("[00:01.00]studio"), None),
            record("Nightcall", "Some Cover Band", 259.0, Some("[00:01.00]cover"), None),
        ];
        let best = select_best(records, &q).expect("a candidate");
        assert_eq!(best.artist_name, "Kavinsky");
        assert!(best.synced_lyrics.unwrap().contains("studio"));
    }

    #[test]
    fn instrumental_records_are_kept_but_unrelated_ones_dropped() {
        let q = query("Song", "Artist", 100);
        let mut instrumental = record("Song", "Artist", 100.0, None, None);
        instrumental.instrumental = true;
        let unrelated = record("Other", "Nobody", 400.0, Some("[00:01.00]x"), None);
        let picked = select_best(vec![instrumental, unrelated.clone()], &q).unwrap();
        assert!(picked.instrumental);
        assert!(select_best(vec![unrelated], &q).is_none());
    }

    #[test]
    fn synced_lyrics_take_priority_over_plain() {
        let result = record_to_result(record(
            "Song",
            "Artist",
            200.0,
            Some("[00:10.00]first line\n[00:12.50]second line"),
            Some("first line\nsecond line"),
        ))
        .expect("result");
        assert!(result.synced);
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.lines[1].start_ms, 12_500);
        assert_eq!(result.lines[0].end_ms, 12_500);
        assert_eq!(result.duration_ms, 200_000);
    }

    #[test]
    fn plain_lyrics_fallback_is_untimed() {
        let result =
            record_to_result(record("Song", "Artist", 200.0, None, Some("a\nb"))).expect("result");
        assert!(!result.synced);
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.lines[0].start_ms, -1);
    }
}
