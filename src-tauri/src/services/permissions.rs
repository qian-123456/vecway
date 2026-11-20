//! [C] Guided macOS system permissions checks, System Settings deep links, and Finder reveal.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MacosPermissionState {
    Granted,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacosPermissionEntry {
    pub id: String,
    pub state: MacosPermissionState,
    pub can_prompt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacosPermissionsStatus {
    pub supported: bool,
    pub app_path: Option<String>,
    pub app_name: String,
    pub permissions: Vec<MacosPermissionEntry>,
}

const DEFAULT_APP_NAME: &str = "Vecway";

/// Resolve the enclosing `.app` bundle directory from `exe_path`, falling back
/// to `exe_path` itself for unpackaged dev builds.
pub(crate) fn resolve_app_bundle_or_exe(exe_path: &Path) -> (PathBuf, String) {
    for ancestor in exe_path.ancestors() {
        if ancestor.extension() == Some(OsStr::new("app")) {
            let name = ancestor
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_APP_NAME)
                .to_string();
            return (ancestor.to_path_buf(), name);
        }
    }
    (exe_path.to_path_buf(), DEFAULT_APP_NAME.to_string())
}

/// Strict allowlist mapping permission ids to macOS System Settings Privacy deep links.
pub(crate) fn permission_pane_url(permission_id: &str) -> Result<&'static str, String> {
    match permission_id {
        "accessibility" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        "screenRecording" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
        "fullDiskAccess" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        }
        "localNetwork" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
        }
        "developerTools" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools")
        }
        _ => Err(format!("unsupported permission id: {permission_id}")),
    }
}

#[cfg(any(target_os = "macos", test))]
fn classify_fda_probe<T>(result: std::io::Result<T>) -> Option<MacosPermissionState> {
    match result {
        Ok(_) => Some(MacosPermissionState::Granted),
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            Some(MacosPermissionState::Denied)
        }
        Err(_) => None,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{classify_fda_probe, MacosPermissionState};
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use std::fs::{self, File};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn accessibility_state() -> MacosPermissionState {
        // SAFETY: Pure query with no arguments or out-pointers.
        if unsafe { AXIsProcessTrusted() } {
            MacosPermissionState::Granted
        } else {
            MacosPermissionState::Denied
        }
    }

    pub fn prompt_accessibility() {
        // SAFETY: `kAXTrustedCheckOptionPrompt` is an immutable framework CFStringRef;
        // `CFDictionary` retains keys/values for the duration of the call.
        unsafe {
            if kAXTrustedCheckOptionPrompt.is_null() {
                let _ = AXIsProcessTrusted();
                return;
            }
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let val = CFBoolean::true_value();
            let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
            let _ = AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef());
        }
    }

    pub fn screen_recording_state() -> MacosPermissionState {
        // SAFETY: Non-prompting CoreGraphics preflight check.
        if unsafe { CGPreflightScreenCaptureAccess() } {
            MacosPermissionState::Granted
        } else {
            MacosPermissionState::Denied
        }
    }

    pub fn prompt_screen_recording() {
        // SAFETY: Standard CoreGraphics request call; triggers system prompt at most once.
        unsafe {
            let _ = CGRequestScreenCaptureAccess();
        }
    }

    /// Silent Full Disk Access check via TCC-protected files/dirs (never pops a TCC prompt).
    pub fn full_disk_access_state() -> MacosPermissionState {
        let Some(home) = dirs::home_dir() else {
            return MacosPermissionState::Unknown;
        };
        let tcc_db = home.join("Library/Application Support/com.apple.TCC/TCC.db");
        if let Some(state) = classify_fda_probe(File::open(&tcc_db)) {
            return state;
        }
        for dir in ["Library/Mail", "Library/Safari"] {
            if let Some(state) = classify_fda_probe(fs::read_dir(home.join(dir))) {
                return state;
            }
        }
        MacosPermissionState::Unknown
    }
}

#[tauri::command]
pub async fn macos_permissions_status() -> Result<MacosPermissionsStatus, String> {
    #[cfg(not(target_os = "macos"))]
    {
        Ok(MacosPermissionsStatus {
            supported: false,
            app_path: None,
            app_name: DEFAULT_APP_NAME.to_string(),
            permissions: Vec::new(),
        })
    }

    #[cfg(target_os = "macos")]
    {
        let (app_path, app_name) = match std::env::current_exe() {
            Ok(exe) => {
                let (path, name) = resolve_app_bundle_or_exe(&exe);
                (Some(path.to_string_lossy().into_owned()), name)
            }
            Err(_) => (None, DEFAULT_APP_NAME.to_string()),
        };

        let permissions = vec![
            MacosPermissionEntry {
                id: "accessibility".to_string(),
                state: macos::accessibility_state(),
                can_prompt: true,
            },
            MacosPermissionEntry {
                id: "screenRecording".to_string(),
                state: macos::screen_recording_state(),
                can_prompt: true,
            },
            MacosPermissionEntry {
                id: "fullDiskAccess".to_string(),
                state: macos::full_disk_access_state(),
                can_prompt: false,
            },
            MacosPermissionEntry {
                id: "localNetwork".to_string(),
                state: MacosPermissionState::Unknown,
                can_prompt: false,
            },
            MacosPermissionEntry {
                id: "developerTools".to_string(),
                state: MacosPermissionState::Unknown,
                can_prompt: false,
            },
        ];

        Ok(MacosPermissionsStatus {
            supported: true,
            app_path,
            app_name,
            permissions,
        })
    }
}

#[tauri::command]
pub async fn macos_open_permission_pane(
    permission_id: String,
    prompt: Option<bool>,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (permission_id, prompt);
        Err("macOS permissions are only available on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let url = permission_pane_url(&permission_id)?;
        if prompt == Some(true) {
            match permission_id.as_str() {
                "accessibility" => macos::prompt_accessibility(),
                "screenRecording" => macos::prompt_screen_recording(),
                _ => {}
            }
        }
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("failed to open System Settings: {e}"))?;
        if !status.success() {
            return Err(format!("open exited with status {status}"));
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn macos_reveal_current_app() -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        Err("macOS permissions are only available on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("failed to resolve current executable: {e}"))?;
        let (target, _) = resolve_app_bundle_or_exe(&exe);
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .status()
            .map_err(|e| format!("failed to reveal app in Finder: {e}"))?;
        if !status.success() {
            return Err(format!("open -R exited with status {status}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn test_permission_pane_url_allowlist() {
        assert_eq!(
            permission_pane_url("accessibility").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        assert_eq!(
            permission_pane_url("screenRecording").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(
            permission_pane_url("fullDiskAccess").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );
        assert_eq!(
            permission_pane_url("localNetwork").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork"
        );
        assert_eq!(
            permission_pane_url("developerTools").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools"
        );
    }

    #[test]
    fn test_permission_pane_url_rejects_unknown() {
        assert!(permission_pane_url("").is_err());
        assert!(permission_pane_url("camera").is_err());
        assert!(permission_pane_url("accessibility&extra=1").is_err());
    }

    #[test]
    fn test_resolve_app_bundle_or_exe() {
        let (path, name) =
            resolve_app_bundle_or_exe(Path::new("/Applications/Vecway.app/Contents/MacOS/vecway"));
        assert_eq!(path, PathBuf::from("/Applications/Vecway.app"));
        assert_eq!(name, "Vecway");

        let (custom_path, custom_name) = resolve_app_bundle_or_exe(Path::new(
            "/Users/dev/Applications/Vecway Dev.app/Contents/MacOS/vecway",
        ));
        assert_eq!(
            custom_path,
            PathBuf::from("/Users/dev/Applications/Vecway Dev.app")
        );
        assert_eq!(custom_name, "Vecway Dev");

        let (dev_path, dev_name) =
            resolve_app_bundle_or_exe(Path::new("/Users/dev/Vecway/target/debug/vecway"));
        assert_eq!(
            dev_path,
            PathBuf::from("/Users/dev/Vecway/target/debug/vecway")
        );
        assert_eq!(dev_name, "Vecway");
    }

    #[test]
    fn test_classify_fda_probe() {
        assert_eq!(
            classify_fda_probe(Ok(())),
            Some(MacosPermissionState::Granted)
        );
        assert_eq!(
            classify_fda_probe::<()>(Err(io::Error::from(io::ErrorKind::PermissionDenied))),
            Some(MacosPermissionState::Denied)
        );
        assert_eq!(
            classify_fda_probe::<()>(Err(io::Error::from(io::ErrorKind::NotFound))),
            None
        );
    }
}
