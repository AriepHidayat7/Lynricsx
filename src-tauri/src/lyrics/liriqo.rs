//! LiriQo provider (<https://github.com/AlFarrizi-Studio/LiriQo>).
//!
//! LiriQo is a multi-provider aggregator that returns a normalized payload with
//! native syllable/word timing (milliseconds) when available, plus line-synced
//! and plain fallbacks. This module parses that payload defensively and never
//! assumes every response contains word timestamps.

use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;

use super::lrc::{parse_lrc, parse_word_timed_lrc, LyricLine, TimedWord};
use super::{LyricsError, LyricsProvider, LyricsResult, TrackQuery};

const BASE_URL: &str = "https://api.liriqo-alfarrizi.my.id/v1/lyrics";
const USER_AGENT: &str = "Lynricsx/0.1.0 (https://github.com/AriepHidayat7/Lynricsx)";

// ---------------------------------------------------------------------------
// Raw response model (tolerant of missing optional fields).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiriQoResponse {
    #[serde(default)]
    primary: Option<LiriQoTrack>,
    #[serde(default)]
    tracks: Vec<LiriQoTrack>,
    #[serde(default)]
    metadata: Option<LiriQoMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiriQoMetadata {
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    album: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LiriQoTrack {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    sync_level: String,
    #[serde(default)]
    granularity: String,
    #[serde(default)]
    timed: Vec<LiriQoLine>,
    #[serde(default)]
    plain: Option<String>,
    #[serde(default)]
    lrc: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LiriQoLine {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    is_cue: bool,
    #[serde(default)]
    is_instrumental: bool,
    #[serde(default)]
    words: Vec<LiriQoWord>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LiriQoWord {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
}

pub struct LiriQoProvider {
    client: reqwest::Client,
    base_url: String,
}

impl Default for LiriQoProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl LiriQoProvider {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(10))
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

/// Orders tracks by synchronization quality: word/syllable first, then line,
/// then plain. Returns `None` when nothing is usable.
fn pick_track<'a>(
    primary: Option<&'a LiriQoTrack>,
    tracks: &'a [LiriQoTrack],
    duration_s: Option<i64>,
) -> Option<&'a LiriQoTrack> {
    let mut all: Vec<&'a LiriQoTrack> = primary.into_iter().chain(tracks.iter()).collect();

    // Duration-aware filter: reject tracks whose last timestamp runs far past
    // the reported duration (a strong signal of a wrong track match).
    all.retain(|t| {
        let Some(dur_s) = duration_s.filter(|d| *d > 0) else {
            return true;
        };
        let limit = dur_s * 1000 + 15_000;
        let last_end = t
            .timed
            .iter()
            .filter_map(|l| {
                if l.end > 0.0 {
                    Some(l.end.round() as i64)
                } else if !l.words.is_empty() {
                    l.words
                        .iter()
                        .filter_map(|w| (w.end > 0.0).then(|| w.end.round() as i64))
                        .max()
                } else {
                    None
                }
            })
            .max()
            .unwrap_or(0);
        last_end == 0 || last_end <= limit
    });

    let rank = |t: &LiriQoTrack| -> (u8, i64) {
        let word_count: i64 = t.timed.iter().map(|l| l.words.len() as i64).sum();
        let has_words = word_count > 0;
        let has_lines = !t.timed.is_empty();
        let level = if has_words {
            0
        } else if t.sync_level == "line" || has_lines {
            1
        } else {
            2
        };
        // Negative word count so more words sort first within a tier.
        (level, -word_count)
    };

    all.sort_by_key(|t| rank(t));
    all.into_iter().next()
}

fn sync_level_granularity(sync_level: &str) -> String {
    match sync_level {
        "syllable" => "syllable".to_string(),
        "word" => "word".to_string(),
        "character" => "character".to_string(),
        _ => String::new(),
    }
}

/// Returns the natural line text whose start time is within ±500ms of
/// `start_ms`. Used to recover correct word boundaries from the LRC when the
/// provider's `timed[].text` spaces apart syllable fragments.
fn nearest_natural_text(natural: &[(i64, String)], start_ms: i64) -> Option<String> {
    natural
        .iter()
        .filter(|(s, _)| (s - start_ms).abs() <= 500)
        .min_by_key(|(s, _)| (s - start_ms).abs())
        .map(|(_, t)| t.clone())
}
/// Converts a single LiriQo track into a normalized `LyricsResult`.
fn normalize_track(
    track: &LiriQoTrack,
    title: &str,
    artist: &str,
    album: &str,
    duration_s: Option<i64>,
) -> LyricsResult {
    let duration_ms = duration_s.unwrap_or(0) * 1000;

    // Syllable-synced tracks space fragments apart in `timed[].text`
    // (e.g. "Back burn er"), while `timed[].words[]` holds the fragments
    // ("Back", "burn", "er"). Reconstruct the natural display text from the LRC
    // (matched by line start time) so the composition keeps intact word
    // boundaries, while the native fragments drive the progressive reveal.
    //
    // Enhanced `<mm:ss.xx>` word timing is preferred; a plain line-level LRC is
    // the fallback. Word/character tracks already expose natural text, so they
    // are left untouched.
    let natural_lines: Option<Vec<LyricLine>> = if track.sync_level == "syllable" {
        track.lrc.as_deref().and_then(|lrc| {
            parse_word_timed_lrc(lrc)
                .filter(|lines| lines.iter().any(|l| l.has_word_timing()))
                .or_else(|| {
                    let plain = parse_lrc(lrc).lines;
                    (!plain.is_empty()).then_some(plain)
                })
        })
    } else {
        None
    };

    // Rare case: the provider supplied no per-word timing in `timed[]` but the
    // LRC has enhanced word timing — use the LRC word-level lines directly.
    let timed_has_words = track.timed.iter().any(|l| !l.words.is_empty());
    if !timed_has_words {
        if let Some(word_lines) = natural_lines.as_ref() {
            if word_lines.iter().any(|l| l.has_word_timing()) {
                let granularity = if track.granularity.trim().is_empty() {
                    "word".to_string()
                } else {
                    track.granularity.trim().to_string()
                };
                return LyricsResult {
                    lines: word_lines.clone(),
                    synced: true,
                    word_synced: true,
                    word_granularity: granularity,
                    instrumental: false,
                    source: "liriqo".into(),
                    title: title.to_string(),
                    artist: artist.to_string(),
                    album: album.to_string(),
                    duration_ms,
                };
            }
        }
    }

    let natural_texts: Vec<(i64, String)> = natural_lines
        .map(|lines| {
            lines
                .into_iter()
                .map(|l| (l.start_ms, l.text))
                .collect()
        })
        .unwrap_or_default();

    let mut lines: Vec<LyricLine> = Vec::new();
    for l in &track.timed {
        if l.text.trim().is_empty() && l.words.is_empty() {
            continue;
        }
        let start_ms = l.start.round() as i64;
        let text = nearest_natural_text(&natural_texts, start_ms)
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| l.text.trim().to_string());
        let end_ms = if l.end > 0.0 { l.end.round() as i64 } else { -1 };
        let mut words: Vec<TimedWord> = Vec::new();
        for w in &l.words {
            if w.text.trim().is_empty() {
                continue;
            }
            let ws = w.start.round() as i64;
            let we = if w.end > 0.0 { w.end.round() as i64 } else { ws };
            words.push(TimedWord {
                start_ms: ws,
                end_ms: we,
                text: w.text.trim().to_string(),
            });
        }
        lines.push(LyricLine {
            start_ms,
            end_ms,
            text,
            words,
        });
    }

    let word_synced = lines.iter().any(|l| !l.words.is_empty());
    if !lines.is_empty() {
        let granularity = if track.granularity.trim().is_empty() {
            sync_level_granularity(&track.sync_level)
        } else {
            track.granularity.trim().to_string()
        };
        return LyricsResult {
            lines,
            synced: true,
            word_synced,
            word_granularity: granularity,
            instrumental: false,
            source: "liriqo".into(),
            title: title.to_string(),
            artist: artist.to_string(),
            album: album.to_string(),
            duration_ms,
        };
    }

    if let Some(lrc) = track.lrc.as_deref().filter(|s| !s.trim().is_empty()) {
        let parsed = parse_lrc(lrc);
        if !parsed.lines.is_empty() {
            return LyricsResult {
                lines: parsed.lines,
                synced: true,
                word_synced: false,
                word_granularity: String::new(),
                instrumental: false,
                source: "liriqo".into(),
                title: title.to_string(),
                artist: artist.to_string(),
                album: album.to_string(),
                duration_ms,
            };
        }
    }

    if let Some(plain) = track.plain.as_deref().filter(|s| !s.trim().is_empty()) {
        return super::cache::plain_result(plain, title, artist, album, duration_ms, "liriqo");
    }

    LyricsResult::not_found(title, artist, album)
}

impl LyricsProvider for LiriQoProvider {
    fn name(&self) -> &'static str {
        "liriqo"
    }

    async fn lookup(&self, query: &TrackQuery) -> Result<Option<LyricsResult>, LyricsError> {
        if query.title.trim().is_empty() {
            return Ok(None);
        }

        let mut req = self.client.get(&self.base_url).query(&[
            ("title", query.title.as_str()),
            ("artist", query.artist.as_str()),
        ]);
        if let Some(d) = query.duration_s.filter(|d| *d > 0) {
            req = req.query(&[("duration", d.to_string())]);
        }

        let response = req.send().await.map_err(network_error)?;
        match response.status() {
            StatusCode::OK => {
                let data: LiriQoResponse = response.json().await.map_err(network_error)?;

                let title = data
                    .metadata
                    .as_ref()
                    .map(|m| m.title.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| query.title.clone());
                let artist = data
                    .metadata
                    .as_ref()
                    .map(|m| m.artist.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| query.artist.clone());
                let album = data
                    .metadata
                    .as_ref()
                    .map(|m| m.album.clone())
                    .unwrap_or_default();

                let Some(track) = pick_track(data.primary.as_ref(), &data.tracks, query.duration_s)
                else {
                    return Ok(None);
                };

                let result = normalize_track(track, &title, &artist, &album, query.duration_s);
                if result.lines.is_empty() && !result.instrumental {
                    Ok(None)
                } else {
                    Ok(Some(result))
                }
            }
            StatusCode::NOT_FOUND => Ok(None),
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                Err(LyricsError::RateLimited)
            }
            status => Err(LyricsError::Provider(format!("liriqo returned {status}"))),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> LiriQoResponse {
        serde_json::from_str::<LiriQoResponse>(json).expect("fixture should parse")
    }

    #[test]
    fn parses_word_level_fixture() {
        let data = parse(
            r#"{
              "metadata": {"title": "Nightcall", "artist": "Kavinsky", "album": "OutRun"},
              "tracks": [{
                "provider": "apple_music_liriqo",
                "syncLevel": "word",
                "granularity": "word",
                "timed": [{
                  "text": "I'm giving you a night call",
                  "start": 32059, "end": 35100,
                  "words": [
                    {"text": "I'm", "start": 32059, "end": 32425},
                    {"text": "giving", "start": 32425, "end": 33169},
                    {"text": "you", "start": 33169, "end": 33512}
                  ]
                }]
              }]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, Some(258)).unwrap();
        let result = normalize_track(track, "Nightcall", "Kavinsky", "OutRun", Some(258));
        assert!(result.word_synced);
        assert!(result.synced);
        assert_eq!(result.word_granularity, "word");
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].words.len(), 3);
        assert_eq!(result.lines[0].words[0].text, "I'm");
        assert_eq!(result.lines[0].words[0].start_ms, 32059);
        assert_eq!(result.lines[0].words[0].end_ms, 32425);
        assert_eq!(result.lines[0].start_ms, 32059);
        assert_eq!(result.lines[0].end_ms, 35100);
    }

    #[test]
    fn prefers_word_track_over_line_and_plain() {
        let data = parse(
            r#"{
              "tracks": [
                {"provider": "kuwo", "syncLevel": "line",
                 "timed": [{"text": "first", "start": 1000, "end": 2000}]},
                {"provider": "apple_music_liriqo", "syncLevel": "word",
                 "timed": [{"text": "first line", "start": 1000, "end": 2000,
                   "words": [{"text": "first", "start": 1000, "end": 1500},
                              {"text": "line", "start": 1500, "end": 2000}]}]}
              ]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, None).unwrap();
        assert!(track.timed.iter().any(|l| !l.words.is_empty()));
    }

    #[test]
    fn plain_track_falls_back_without_word_timing() {
        let data = parse(
            r#"{
              "tracks": [{"provider": "musixmatch", "syncLevel": "plain", "plain": "hello\nworld"}]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, None).unwrap();
        let result = normalize_track(track, "T", "A", "", None);
        assert!(!result.word_synced);
        assert!(!result.synced);
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.lines[0].start_ms, -1);
    }

    #[test]
    fn primary_only_envelope_is_used() {
        let data = parse(
            r#"{
              "primary": {"provider": "netease", "syncLevel": "syllable",
                "timed": [{"text": "hi", "start": 0, "end": 100,
                  "words": [{"text": "hi", "start": 0, "end": 100}]}]}
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, None).unwrap();
        assert_eq!(track.provider, "netease");
    }

    #[test]
    fn duration_mismatch_is_filtered_out() {
        // A track whose timestamps extend far past the known duration is skipped.
        let data = parse(
            r#"{
              "tracks": [
                {"provider": "wrong", "syncLevel": "word",
                 "timed": [{"text": "x", "start": 0, "end": 999000,
                   "words": [{"text": "x", "start": 0, "end": 999000}]}]},
                {"provider": "right", "syncLevel": "line",
                 "timed": [{"text": "x", "start": 0, "end": 2000}]}
              ]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, Some(30)).unwrap();
        assert_eq!(track.provider, "right");
    }

    #[test]
    fn syllable_track_reconstructs_natural_text_from_lrc() {
        // The `timed[].text` spaces syllable fragments ("Back burn er"), but the
        // `lrc` has the natural word "Backburner". The normalized line keeps the
        // syllable fragments for reveal while reconstructing natural text.
        let data = parse(
            r#"{
              "metadata": {"title": "Backburner", "artist": "NIKI"},
              "tracks": [{
                "provider": "apple_music_liriqo",
                "syncLevel": "syllable",
                "granularity": "syllable",
                "lrc": "[01:32.43]<01:32.43>Backburner <01:34.47>",
                "timed": [{
                  "text": "Back burn er",
                  "start": 92430, "end": 94470,
                  "words": [
                    {"text": "Back", "start": 92430, "end": 93200},
                    {"text": "burn", "start": 93200, "end": 94000},
                    {"text": "er", "start": 94000, "end": 94470}
                  ]
                }]
              }]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, Some(230)).unwrap();
        let result = normalize_track(track, "Backburner", "NIKI", "", Some(230));
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].text, "Backburner");
        assert_eq!(result.lines[0].words.len(), 3);
        assert!(result.word_synced);
        assert_eq!(result.word_granularity, "syllable");
    }

    #[test]
    fn syllable_text_without_lrc_falls_back_to_provider_text() {
        // No `lrc` field: the provider's own `text` is kept unchanged.
        let data = parse(
            r#"{
              "metadata": {"title": "T", "artist": "A"},
              "tracks": [{
                "provider": "p", "syncLevel": "syllable",
                "timed": [{
                  "text": "call ing", "start": 1000, "end": 2000,
                  "words": [
                    {"text": "call", "start": 1000, "end": 1500},
                    {"text": "ing", "start": 1500, "end": 2000}
                  ]
                }]
              }]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, None).unwrap();
        let result = normalize_track(track, "T", "A", "", None);
        assert_eq!(result.lines[0].text, "call ing");
        assert_eq!(result.lines[0].words.len(), 2);
    }

    #[test]
    fn syllable_track_uses_plain_lrc_for_natural_text() {
        // A syllable track with a plain line-level LRC (no `<..>` word timing)
        // still recovers natural word boundaries from the LRC line text.
        let data = parse(
            r#"{
              "metadata": {"title": "T", "artist": "A"},
              "tracks": [{
                "provider": "p", "syncLevel": "syllable", "granularity": "syllable",
                "lrc": "[01:32.43]kau hancurkan diriku saat engkau pergi",
                "timed": [{
                  "text": "kau han cur kan di ri ku sa at eng kau per gi",
                  "start": 92430, "end": 96000,
                  "words": [
                    {"text": "kau", "start": 92430, "end": 93000},
                    {"text": "han", "start": 93000, "end": 93500},
                    {"text": "cur", "start": 93500, "end": 94000},
                    {"text": "kan", "start": 94000, "end": 94500},
                    {"text": "di", "start": 94500, "end": 95000},
                    {"text": "ri", "start": 95000, "end": 95300},
                    {"text": "ku", "start": 95300, "end": 95600}
                  ]
                }]
              }]
            }"#,
        );
        let track = pick_track(data.primary.as_ref(), &data.tracks, Some(200)).unwrap();
        let result = normalize_track(track, "T", "A", "", Some(200));
        assert_eq!(result.lines[0].text, "kau hancurkan diriku saat engkau pergi");
        assert_eq!(result.lines[0].words.len(), 7);
        assert_eq!(result.word_granularity, "syllable");
    }
}
