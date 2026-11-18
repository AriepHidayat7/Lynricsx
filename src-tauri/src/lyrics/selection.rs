//! Provider priority selection for the lyrics engine.

use super::LyricsResult;

/// Provider priority used by the lyrics engine:
///   0. LiriQo with native word/syllable timing
///   1. LRCLIB line-synced
///   2. LiriQo line-synced
///   3. LRCLIB plain
///   4. LiriQo plain
///
/// Returns the winning result, or `None` when nothing is usable.
pub fn select_result(
    liriqo: Option<&LyricsResult>,
    lrclib: Option<&LyricsResult>,
) -> Option<LyricsResult> {
    let has_lines = |r: &LyricsResult| !r.lines.is_empty();
    let usable = |r: &&LyricsResult| has_lines(r) || r.instrumental;

    if let Some(r) = liriqo.filter(|r| usable(&r) && r.word_synced) {
        return Some(r.clone());
    }
    if let Some(r) = lrclib.filter(|r| usable(&r) && r.synced) {
        return Some(r.clone());
    }
    if let Some(r) = liriqo.filter(|r| usable(&r) && r.synced) {
        return Some(r.clone());
    }
    if let Some(r) = lrclib.filter(|r| usable(&r)) {
        return Some(r.clone());
    }
    if let Some(r) = liriqo.filter(|r| usable(&r)) {
        return Some(r.clone());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lyrics::lrc::{LyricLine, TimedWord};

    fn line(text: &str, start: i64, words: Vec<TimedWord>) -> LyricLine {
        LyricLine {
            start_ms: start,
            end_ms: -1,
            text: text.into(),
            words,
        }
    }

    fn word_result(source: &str) -> LyricsResult {
        LyricsResult {
            lines: vec![line(
                "we will rock you",
                1000,
                vec![TimedWord {
                    start_ms: 1000,
                    end_ms: 1500,
                    text: "we".into(),
                }],
            )],
            synced: true,
            word_synced: true,
            word_granularity: "word".into(),
            source: source.into(),
            ..LyricsResult::default()
        }
    }

    fn line_result(source: &str) -> LyricsResult {
        LyricsResult {
            lines: vec![line("a line", 1000, Vec::new())],
            synced: true,
            word_synced: false,
            source: source.into(),
            ..LyricsResult::default()
        }
    }

    fn plain_result(source: &str) -> LyricsResult {
        LyricsResult {
            lines: vec![LyricLine {
                start_ms: -1,
                end_ms: -1,
                text: "plain".into(),
                words: Vec::new(),
            }],
            synced: false,
            word_synced: false,
            source: source.into(),
            ..LyricsResult::default()
        }
    }

    #[test]
    fn word_level_wins_over_everything() {
        let liriqo = word_result("liriqo");
        let lrclib = line_result("lrclib");
        let chosen = select_result(Some(&liriqo), Some(&lrclib)).unwrap();
        assert_eq!(chosen.source, "liriqo");
        assert!(chosen.word_synced);
    }

    #[test]
    fn lrclib_line_sync_beats_liriqo_line_sync() {
        let liriqo = line_result("liriqo");
        let lrclib = line_result("lrclib");
        let chosen = select_result(Some(&liriqo), Some(&lrclib)).unwrap();
        assert_eq!(chosen.source, "lrclib");
        assert!(chosen.synced);
        assert!(!chosen.word_synced);
    }

    #[test]
    fn liriqo_line_sync_used_when_lrclib_missing() {
        let liriqo = line_result("liriqo");
        let chosen = select_result(Some(&liriqo), None).unwrap();
        assert_eq!(chosen.source, "liriqo");
        assert!(chosen.synced);
    }

    #[test]
    fn plain_fallback_order_prefers_lrclib() {
        let liriqo = plain_result("liriqo");
        let lrclib = plain_result("lrclib");
        let chosen = select_result(Some(&liriqo), Some(&lrclib)).unwrap();
        assert_eq!(chosen.source, "lrclib");
        assert!(!chosen.synced);
        // With LRCLIB unavailable the LiriQo plain result is still used.
        let chosen = select_result(Some(&liriqo), None).unwrap();
        assert_eq!(chosen.source, "liriqo");
    }

    #[test]
    fn nothing_available_returns_none() {
        assert!(select_result(None, None).is_none());
        let empty = LyricsResult::default();
        assert!(select_result(Some(&empty), Some(&empty)).is_none());
    }
}