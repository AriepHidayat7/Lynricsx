//! "Start with Windows" support.
//!
//! Two mechanisms are used, in order of preference:
//!
//! 1. The per-user `Run` registry key
//!    (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`). This needs no
//!    elevation and works for unpacked/portable builds.
//! 2. A shortcut in the user's Startup folder, which also works when the app
//!    is installed in a directory the current user cannot write to but the
//!    shell can still launch from.
//!
//! All access goes through the per-user registry hive / profile directory, so
//! no administrator rights are required.

use std::path::{Path, PathBuf};

use windows::core::HSTRING;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
};

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/// Registry value name written by this build.
pub const VALUE_NAME: &str = "Lynricsx";
/// Value name written by builds that shipped under the old product name.
///
/// Still read (and removed when autostart is turned off) so users who upgrade
/// keep their "start with Windows" choice instead of ending up registered twice.
const LEGACY_VALUE_NAMES: [&str; 1] = ["RedLyrics"];

fn run_key_handle(access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Option<HKEY> {
    let path = HSTRING::from(RUN_KEY);
    let mut key = HKEY::default();
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &path, 0, access, &mut key) };
    (status == ERROR_SUCCESS).then_some(key)
}

/// Reads the currently registered command, if any.
///
/// The current value name is preferred; a value written by an older build under
/// the previous product name is honoured so upgrades keep their autostart state.
pub fn current_command() -> Option<String> {
    read_value(VALUE_NAME).or_else(|| {
        LEGACY_VALUE_NAMES
            .iter()
            .find_map(|legacy| read_value(legacy))
    })
}

fn read_value(value_name: &str) -> Option<String> {
    let key = run_key_handle(KEY_QUERY_VALUE)?;
    let mut size: u32 = 0;
    let name = HSTRING::from(value_name);
    let status = unsafe {
        RegQueryValueExW(key, &name, None, None, None, Some(&mut size as *mut u32))
    };
    if status != ERROR_SUCCESS || size == 0 {
        unsafe {
            let _ = RegCloseKey(key);
        }
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        RegQueryValueExW(
            key,
            &name,
            None,
            None,
            Some(buffer.as_mut_ptr()),
            Some(&mut size as *mut u32),
        )
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    if status != ERROR_SUCCESS {
        return None;
    }
    let utf16: Vec<u16> = buffer
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|c| *c != 0)
        .collect();
    Some(String::from_utf16_lossy(&utf16))
}

pub fn is_enabled() -> bool {
    current_command().is_some()
}

/// Enables or disables autostart for the given executable.
pub fn set_enabled(exe: &Path, enable: bool) -> Result<(), String> {
    let key = run_key_handle(KEY_SET_VALUE).ok_or_else(|| "cannot open Run registry key".to_string())?;
    let name = HSTRING::from(VALUE_NAME);
    let result = if enable {
        // Quote the path so directories with spaces still launch correctly.
        let command = format!("\"{}\"", exe.display());
        let mut data: Vec<u8> = command.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        data.extend_from_slice(&[0, 0]);
        let status = unsafe {
            RegSetValueExW(key, &name, 0, REG_SZ, Some(&data))
        };
        if status == ERROR_SUCCESS {
            // Drop any entry left behind by an older product name so the app is
            // not registered twice at logon.
            for legacy in LEGACY_VALUE_NAMES {
                let legacy = HSTRING::from(legacy);
                unsafe {
                    let _ = RegDeleteValueW(key, &legacy);
                }
            }
            Ok(())
        } else {
            Err(format!("RegSetValueExW failed with {status:?}"))
        }
    } else {
        let status = unsafe { RegDeleteValueW(key, &name) };
        for legacy in LEGACY_VALUE_NAMES {
            let legacy = HSTRING::from(legacy);
            unsafe {
                let _ = RegDeleteValueW(key, &legacy);
            }
        }
        if status == ERROR_SUCCESS
            || status == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND
        {
            Ok(())
        } else {
            Err(format!("RegDeleteValueW failed with {status:?}"))
        }
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    result
}

/// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`
pub fn startup_folder() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup");
    dir.is_dir().then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_folder_points_at_appdata() {
        if let Some(dir) = startup_folder() {
            assert!(dir.ends_with("Startup"));
        }
    }

    #[test]
    fn reading_the_run_key_never_panics() {
        // The value may or may not exist depending on the machine state.
        let _ = current_command();
        let _ = is_enabled();
    }
}
