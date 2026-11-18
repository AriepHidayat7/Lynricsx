//! On-disk + in-memory lyrics cache.
//!
//! Every lookup is written to the app cache directory as a small JSON file
//! keyed by a hash of the normalized title/artist. Not-found results are
//! cached too (with no lines) so we do not hammer the API for tracks that
//! genuinely have no lyrics.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::lyrics::lrc::{plain_to_lines, LyricLine};
use crate::lyrics::{LyricsResult, TrackQuery};

const CACHE_VERSION: u32 = 2;
/// Entries older than this are removed on startup.
const MAX_AGE_SECS: u64 = 60 * 60 * 24 * 45;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    version: u32,
    saved_at: u64,
    title: String,
    artist: String,
    album: String,
    synced: bool,
    word_synced: bool,
    word_granularity: String,
    instrumental: bool,
    source: String,
    duration_ms: i64,
    lines: Vec<LyricLine>,
    #[serde(default)]
    not_found: bool,
}

impl CacheEntry {
    fn from_result(result: &LyricsResult, not_found: bool) -> Self {
        Self {
            version: CACHE_VERSION,
            saved_at: now_secs(),
            title: result.title.clone(),
            artist: result.artist.clone(),
            album: result.album.clone(),
            synced: result.synced,
            word_synced: result.word_synced,
            word_granularity: result.word_granularity.clone(),
            instrumental: result.instrumental,
            source: result.source.clone(),
            duration_ms: result.duration_ms,
            lines: result.lines.clone(),
            not_found,
        }
    }

    fn into_result(self) -> LyricsResult {
        LyricsResult {
            lines: self.lines,
            synced: self.synced,
            word_synced: self.word_synced,
            word_granularity: self.word_granularity,
            instrumental: self.instrumental,
            source: self.source,
            title: self.title,
            artist: self.artist,
            album: self.album,
            duration_ms: self.duration_ms,
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Lowercase, trimmed, whitespace-collapsed identity for a track.
pub fn normalize_key(title: &str, artist: &str) -> String {
    let clean = |s: &str| -> String {
        s.to_lowercase()
            .replace('\u{2019}', "'")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    format!("{}|{}", clean(title), clean(artist))
}

/// FNV-1a 64-bit hash rendered as hex, avoiding an extra hashing dependency.
fn hash_key(key: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub struct LyricsCache {
    dir: PathBuf,
    /// Short-lived in-process memo of results (locked only synchronously, so no
    /// guard is ever held across an `.await`).
    memory: Mutex<HashMap<String, LyricsResult>>,
    /// De-duplicates concurrent writes of the same entry.
    write_gate: tokio::sync::Mutex<()>,
}

impl LyricsCache {
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        Self {
            dir,
            memory: Mutex::new(HashMap::new()),
            write_gate: tokio::sync::Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file_for(&self, query: &TrackQuery) -> PathBuf {
        self.dir
            .join(format!("{}.json", hash_key(&query.cache_key())))
    }

    /// Looks up an entry in memory, then on disk.
    pub fn get(&self, query: &TrackQuery) -> Option<LyricsResult> {
        let key = query.cache_key();
        if let Ok(mem) = self.memory.lock() {
            if let Some(hit) = mem.get(&key) {
                return Some(hit.clone());
            }
        }
        let path = self.file_for(query);
        let text = fs::read_to_string(&path).ok()?;
        let entry: CacheEntry = serde_json::from_str(&text).ok()?;
        if entry.version != CACHE_VERSION {
            let _ = fs::remove_file(&path);
            return None;
        }
        let result = entry.into_result();
        if let Ok(mut mem) = self.memory.lock() {
            mem.insert(key, result.clone());
        }
        Some(result)
    }

    /// Stores a result. Writes to memory immediately and persists to disk
    /// asynchronously so the caller's future stays `Send`.
    pub async fn put(self: &Arc<Self>, query: &TrackQuery, result: &LyricsResult, not_found: bool) {
        let key = query.cache_key();
        if let Ok(mut mem) = self.memory.lock() {
            mem.insert(key, result.clone());
        }
        let entry = CacheEntry::from_result(result, not_found);
        let Ok(text) = serde_json::to_string(&entry) else {
            return;
        };
        let dir = self.dir.clone();
        let file = self.file_for(query);
        let _permit = self.write_gate.lock().await;
        let _ = tokio::task::spawn_blocking(move || {
            let _ = fs::create_dir_all(&dir);
            let tmp = file.with_extension("json.tmp");
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, &file);
            }
        })
        .await;
    }

    /// Number of cached files and their combined size in bytes.
    pub fn stats(&self) -> (usize, u64) {
        let mut count = 0usize;
        let mut bytes = 0u64;
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        count += 1;
                        bytes += meta.len();
                    }
                }
            }
        }
        (count, bytes)
    }

    /// Deletes all cache files and clears the memory cache.
    pub fn clear(&self) -> usize {
        let mut removed = 0usize;
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                if fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        if let Ok(mut mem) = self.memory.lock() {
            mem.clear();
        }
        removed
    }

    /// Removes cache files older than `MAX_AGE_SECS`. Called once at startup.
    pub fn prune(&self) {
        let cutoff = now_secs().saturating_sub(MAX_AGE_SECS);
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                match serde_json::from_str::<CacheEntry>(&text) {
                    Ok(entry) if entry.saved_at >= cutoff => {}
                    _ => {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
    }
}

/// Builds an untimed result from plain lyrics text.
pub fn plain_result(
    plain: &str,
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: i64,
    source: &str,
) -> LyricsResult {
    LyricsResult {
        lines: plain_to_lines(plain),
        synced: false,
        word_synced: false,
        word_granularity: String::new(),
        instrumental: false,
        source: source.to_string(),
        title: title.to_string(),
        artist: artist.to_string(),
        album: album.to_string(),
        duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(title: &str, artist: &str) -> TrackQuery {
        TrackQuery {
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            duration_s: None,
        }
    }

    #[test]
    fn keys_are_normalized() {
        assert_eq!(
            normalize_key("  Hello   World ", "The  Artist"),
            "hello world|the artist"
        );
        assert_eq!(normalize_key("A", "B"), normalize_key("a", "b"));
    }

    #[test]
    fn cache_roundtrip_and_clear() {
        let dir = std::env::temp_dir().join(format!("lynricsx-cache-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let cache = LyricsCache::new(dir.clone());
        let q = query("Song", "Artist");
        assert!(cache.get(&q).is_none());

        let result = plain_result("line one\nline two", "Song", "Artist", "Album", 1000, "lrclib");
        // Memory layer is written synchronously by the async API's first half.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let shared = std::sync::Arc::new(cache);
        rt.block_on(shared.put(&q, &result, false));
        assert_eq!(shared.get(&q).expect("memory hit").lines.len(), 2);

        // A brand new instance must read the entry back from disk.
        let fresh = LyricsCache::new(dir.clone());
        let hit = fresh.get(&q).expect("cached entry should be readable");
        assert_eq!(hit.lines.len(), 2);
        assert_eq!(hit.lines[0].text, "line one");
        assert!(!hit.synced);

        let (count, bytes) = fresh.stats();
        assert_eq!(count, 1);
        assert!(bytes > 0);

        assert_eq!(fresh.clear(), 1);
        assert!(fresh.get(&q).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
