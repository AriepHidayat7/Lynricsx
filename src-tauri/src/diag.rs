//! Minimal persistent diagnostic logger.
//!
//! Writes to `%LOCALAPPDATA%\Lynricsx\logs\gsmtc.log` so media-detection
//! behaviour can be inspected even when the app has no console.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

struct Diag {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl Diag {
    fn new() -> Self {
        let root = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Lynricsx")
            .join("logs");
        let _ = fs::create_dir_all(&root);
        Self {
            path: root.join("gsmtc.log"),
            write_lock: Mutex::new(()),
        }
    }

    fn log(&self, channel: &str, msg: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(f, "[{now:>13}] [{channel}] {msg}");
        }
    }
}

static DIAG: OnceLock<Diag> = OnceLock::new();

pub fn gsmtc(msg: &str) {
    DIAG.get_or_init(Diag::new).log("GSMTC", msg);
}

pub fn media(msg: &str) {
    DIAG.get_or_init(Diag::new).log("MEDIA", msg);
}