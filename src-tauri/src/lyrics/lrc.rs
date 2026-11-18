//! LRC (timestamped lyrics) parser and the core line/word timing model.
//!
//! Supports standard `[mm:ss.xx]` timestamps, multiple timestamps on one line,
//! enhanced word-level timestamps (which are stripped down to their words), and
//! LRC metadata tags such as `[ar:...]`, `[ti:...]`, `[al:...]` and
//! `[offset:...]`.

use serde::{Deserialize, Serialize};

/// A single timed word (native karaoke unit). Times are in milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedWord {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// One lyric line. `start_ms`/`end_ms` are milliseconds; `end_ms` may be `-1`
/// when unknown (the consumer can derive it from the next line or duration).
/// `words` is non-empty only when native word-level timing is available.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<TimedWord>,
}

impl LyricLine {
    pub fn has_word_timing(&self) -> bool {
        !self.words.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedLrc {
    pub lines: Vec<LyricLine>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Offset in milliseconds from the `[offset:]` tag.
    pub offset_ms: i64,
}

impl ParsedLrc {
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

/// Parses an LRC document into line-synchronized lyrics (no word timing).
pub fn parse_lrc(input: &str) -> ParsedLrc {
    let mut parsed = ParsedLrc::default();
    let mut raw: Vec<(i64, String)> = Vec::new();

    for line in input.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let mut rest = line.trim_start();
        let mut times: Vec<i64> = Vec::new();

        // Leading [..] groups: either timestamps or metadata tags.
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let inner = &stripped[..end];
            let consumed = &stripped[end + 1..];

            if let Some(ms) = parse_timestamp(inner) {
                times.push(ms);
                rest = consumed;
                continue;
            }
            if let Some((key, value)) = inner.split_once(':') {
                let value = value.trim();
                match key.trim().to_ascii_lowercase().as_str() {
                    "ti" | "title" if !value.is_empty() => {
                        parsed.title = Some(value.to_string())
                    }
                    "ar" | "artist" if !value.is_empty() => {
                        parsed.artist = Some(value.to_string())
                    }
                    "al" | "album" if !value.is_empty() => {
                        parsed.album = Some(value.to_string())
                    }
                    "offset" => {
                        if let Ok(v) = value.parse::<i64>() {
                            parsed.offset_ms = v;
                        }
                    }
                    _ => {}
                }
            }
            rest = consumed;
        }

        if !times.is_empty() {
            // Enhanced LRC may carry inline word timestamps like <00:12.34>;
            // they are stripped here so the line text remains plain.
            let text = strip_word_timestamps(rest).trim().to_string();
            for t in times {
                raw.push((t, text.clone()));
            }
        }
    }

    // Per LRC convention the offset (ms) is subtracted from every timestamp.
    let offset = parsed.offset_ms;
    raw.sort_by_key(|(t, _)| *t);
    let mut lines: Vec<LyricLine> = raw
        .into_iter()
        .map(|(t, text)| LyricLine {
            start_ms: (t - offset).max(0),
            end_ms: -1,
            text,
            words: Vec::new(),
        })
        .collect();

    // Derive the line end time from the following line's start.
    for i in 0..lines.len() {
        let end = lines.get(i + 1).map(|n| n.start_ms).unwrap_or(-1);
        lines[i].end_ms = if end > lines[i].start_ms { end } else { -1 };
    }

    lines.dedup_by(|a, b| a.start_ms == b.start_ms && a.text == b.text);
    parsed.lines = lines;
    parsed
}

/// Parses a single `[mm:ss.xx]`, `[mm:ss.xxx]`, `[h:mm:ss.xx]` or `[mm:ss]`
/// timestamp body (without brackets) into milliseconds.
pub fn parse_timestamp(input: &str) -> Option<i64> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = input.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    if parts.iter().any(|p| p.trim().is_empty()) {
        return None;
    }

    let seconds_part = parts.pop()?;
    let minutes_part = parts.pop()?;
    let hours_part = parts.pop();

    let seconds: f64 = seconds_part.trim().parse().ok()?;
    let minutes: i64 = minutes_part.trim().parse().ok()?;
    let hours: i64 = match hours_part {
        Some(h) => h.trim().parse().ok()?,
        None => 0,
    };
    if minutes < 0 || hours < 0 || !(0.0..60.0).contains(&seconds) {
        return None;
    }
    let total_ms =
        ((hours * 3600 + minutes * 60) as f64 * 1000.0 + seconds * 1000.0).round() as i64;
    Some(total_ms)
}

/// Removes `<mm:ss.xx>` word timestamps used in enhanced LRC files.
fn strip_word_timestamps(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut probe = String::new();
            let mut closed = false;
            for n in chars.by_ref() {
                if n == '>' {
                    closed = true;
                    break;
                }
                probe.push(n);
                if probe.len() > 16 {
                    break;
                }
            }
            if closed && parse_timestamp(&probe).is_some() {
                continue;
            }
            out.push('<');
            out.push_str(&probe);
            if closed {
                out.push('>');
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Converts plain lyrics into untimed lines. `start_ms = -1` means "no timing".
pub fn plain_to_lines(input: &str) -> Vec<LyricLine> {
    let mut lines: Vec<String> = Vec::new();
    for line in input.lines() {
        let line = line.trim_end_matches('\r').trim_end().to_string();
        if line.is_empty() && lines.last().map(|l| l.is_empty()).unwrap_or(true) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|text| LyricLine {
            start_ms: -1,
            end_ms: -1,
            text,
            words: Vec::new(),
        })
        .collect()
}

/// Parses "enhanced" LRC that carries inline `<mm:ss.xx>` word timestamps.
///
/// Providers such as Apple Music expose word boundaries like:
///
/// ```text
/// [00:31.74]<00:31.74>Kini <00:34.27>ku <00:34.64>harus <00:35.42>bernafas <00:36.70>tanpamu <00:38.33>
/// ```
///
/// The result preserves the natural word boundaries (no artificial syllable
/// spacing). Line and word end times are derived from the next unit's start.
/// Returns `None` when the document contains no inline word timestamps.
pub fn parse_word_timed_lrc(input: &str) -> Option<Vec<LyricLine>> {
    let mut grouped: Vec<(i64, Vec<TimedWord>)> = Vec::new();

    for raw in input.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let mut rest = line.trim_start();

        // Consume leading [..] tags (line timestamp + metadata).
        let mut line_start: Option<i64> = None;
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let inner = &stripped[..end];
            let consumed = &stripped[end + 1..];
            if let Some(ms) = parse_timestamp(inner) {
                if line_start.is_none() {
                    line_start = Some(ms);
                }
            }
            rest = consumed;
        }

        // Parse "<mm:ss.xx>text" word segments.
        let mut words: Vec<TimedWord> = Vec::new();
        for seg in rest.split('<') {
            let seg = seg.trim();
            if seg.is_empty() {
                continue;
            }
            let Some((ts, text)) = seg.split_once('>') else { continue };
            let Some(ms) = parse_timestamp(ts.trim()) else { continue };
            let text = text.trim();
            if text.is_empty() {
                // A trailing timestamp closes the previous word.
                if let Some(w) = words.last_mut() {
                    if w.end_ms < 0 {
                        w.end_ms = ms;
                    }
                }
            } else {
                // A new word starts at `ms`; it also ends the previous word.
                if let Some(w) = words.last_mut() {
                    if w.end_ms < 0 {
                        w.end_ms = ms;
                    }
                }
                words.push(TimedWord {
                    start_ms: ms,
                    end_ms: -1,
                    text: text.to_string(),
                });
            }
        }

        if let Some(ls) = line_start {
            if !words.is_empty() {
                grouped.push((ls, words));
            }
        }
    }

    if grouped.is_empty() {
        return None;
    }

    // Fix line and dangling word end times.
    let n = grouped.len();
    let mut lines: Vec<LyricLine> = Vec::with_capacity(n);
    for i in 0..n {
        let (line_start, mut words) = grouped[i].clone();
        let line_end = if i + 1 < n { grouped[i + 1].0 } else { -1 };
        for j in 0..words.len() {
            let next_start = words.get(j + 1).map(|w| w.start_ms).unwrap_or(-1);
            if words[j].end_ms < 0 {
                words[j].end_ms = if next_start > words[j].start_ms {
                    next_start
                } else if line_end > words[j].start_ms {
                    line_end
                } else {
                    words[j].start_ms + 1
                };
            }
        }
        let text = words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(LyricLine {
            start_ms: line_start,
            end_ms: line_end,
            text,
            words,
        });
    }

    Some(lines)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_timestamp("00:00"), Some(0));
        assert_eq!(parse_timestamp("01:05"), Some(65_000));
        assert_eq!(parse_timestamp("01:05.50"), Some(65_500));
        assert_eq!(parse_timestamp("1:05.500"), Some(65_500));
        assert_eq!(parse_timestamp("1:05.5"), Some(65_500));
        assert_eq!(parse_timestamp("01:60"), None);
        assert_eq!(parse_timestamp("61:05"), Some(3_665_000));
        assert_eq!(parse_timestamp("not-a-time"), None);
    }

    #[test]
    fn parses_synced_lrc_with_offset() {
        let parsed = parse_lrc(
            "[ar:Artist]\n[ti:Title]\n[offset:500]\n[00:01.00]first\n[00:03.50]second\n[00:05.00]third",
        );
        assert_eq!(parsed.artist.as_deref(), Some("Artist"));
        assert_eq!(parsed.title.as_deref(), Some("Title"));
        assert_eq!(parsed.lines.len(), 3);
        // offset is subtracted: 1000 - 500 = 500
        assert_eq!(parsed.lines[0].start_ms, 500);
        assert_eq!(parsed.lines[1].start_ms, 3_000);
        assert_eq!(parsed.lines[0].text, "first");
        assert_eq!(parsed.lines[0].end_ms, 3_000);
        assert!(!parsed.lines[0].has_word_timing());
    }

    #[test]
    fn multiple_timestamps_expand_to_multiple_lines() {
        let parsed = parse_lrc("[00:01.00][00:02.00]shared line");
        assert_eq!(parsed.lines.len(), 2);
        assert_eq!(parsed.lines[0].start_ms, 1_000);
        assert_eq!(parsed.lines[1].start_ms, 2_000);
    }

    #[test]
    fn strips_word_timestamps_in_enhanced_lrc() {
        let parsed = parse_lrc("[00:01.00]<00:01.00>hello <00:01.50>world");
        assert_eq!(parsed.lines[0].text, "hello world");
    }

    #[test]
    fn plain_to_lines_trims_blanks() {
        let lines = plain_to_lines("a\n\nb\n\n");
        // Blank runs collapse to ONE blank line, which is kept: the overlay
        // renders `l.text || "\u{a0}"`, so a stanza break is a visible gap, not
        // something to delete. Trailing blanks at the end of the file *are*
        // dropped, so the result ends on "b".
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "a");
        assert_eq!(lines[1].text, "");
        assert_eq!(lines[2].text, "b");
        assert_eq!(lines[0].start_ms, -1);
        assert_eq!(lines[0].end_ms, -1);
    }

    #[test]
    fn word_timed_lrc_preserves_natural_words() {
        let parsed = parse_word_timed_lrc(
            "[00:31.74]<00:31.74>Kini <00:34.27>ku <00:34.64>harus <00:35.42>bernafas <00:36.70>tanpamu <00:38.33>\n[00:39.02]<00:39.02>Yang <00:39.28>meninggikan <00:40.89>diriku <00:42.51>selalu <00:43.92>",
        )
        .expect("word timestamps present");

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].start_ms, 31_740);
        assert_eq!(parsed[0].text, "Kini ku harus bernafas tanpamu");

        let words = &parsed[0].words;
        assert_eq!(words.len(), 5);
        assert_eq!(words[0].text, "Kini");
        assert_eq!(words[0].start_ms, 31_740);
        assert_eq!(words[0].end_ms, 34_270); // derived from the next word start
        assert_eq!(words[4].text, "tanpamu");
        assert_eq!(words[4].start_ms, 36_700);
        assert_eq!(words[4].end_ms, 38_330); // closed by the trailing timestamp

        // Natural word boundaries are preserved, never syllable-spaced.
        assert!(parsed[0].text.starts_with("Kini ku"));
        assert!(!parsed[0].text.contains("Ki ni"));
    }

    #[test]
    fn word_timed_lrc_returns_none_without_word_tags() {
        assert!(parse_word_timed_lrc("[00:01.00]no word timing here").is_none());
    }
}