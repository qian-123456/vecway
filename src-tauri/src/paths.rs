//! Data locations (docs/ARCHITECTURE.md §3).
// Some helpers are consumed by module stubs filled in later.
#![allow(dead_code)]

use std::io;
use std::path::PathBuf;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// omp agent dir. `PI_CODING_AGENT_DIR` relocates it; a profile env
/// (`OMP_PROFILE` / `PI_PROFILE`) narrows it to `~/.omp/profiles/<name>/agent`;
/// otherwise `~/.omp/agent`.
pub(crate) fn agent_dir() -> PathBuf {
    let override_dir = std::env::var("PI_CODING_AGENT_DIR").ok();
    let profile = std::env::var("OMP_PROFILE")
        .or_else(|_| std::env::var("PI_PROFILE"))
        .ok();
    agent_dir_from(override_dir.as_deref(), profile.as_deref(), &home())
}

/// Pure core of [`agent_dir`]: env values are passed in so tests need no global env.
pub(crate) fn agent_dir_from(
    override_dir: Option<&str>,
    profile: Option<&str>,
    home: &std::path::Path,
) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.trim().is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(profile) = profile.map(str::trim).filter(|p| !p.is_empty()) {
        return home
            .join(".omp")
            .join("profiles")
            .join(profile)
            .join("agent");
    }
    home.join(".omp").join("agent")
}

/// `~/.vecway` (overridable via `OMPWS_DATA_DIR` for isolated dev/preview instances)
pub fn data_dir() -> PathBuf {
    if let Ok(val) = std::env::var("OMPWS_DATA_DIR") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home().join(".vecway")
}

/// `~/.vecway/app.db`
pub fn db_path() -> PathBuf {
    data_dir().join("app.db")
}

/// `~/.vecway/search.db` — disposable full-text index of session transcripts.
pub fn search_db_path() -> PathBuf {
    data_dir().join("search.db")
}

/// `~/.vecway/activity-cache.sqlite` — disposable activity accounting index.
pub fn activity_cache_db_path() -> PathBuf {
    data_dir().join("activity-cache.sqlite")
}

/// `~/.omp` — OMP global directory.
pub fn omp_root_dir() -> PathBuf {
    home().join(".omp")
}

/// `~/.vecway/images/` — durable store for pasted/dropped images.
/// The legacy cache dir `<app-cache>/ompws-clip` stays readable.
pub fn images_dir() -> PathBuf {
    data_dir().join("images")
}

/// `~/.vecway/global/` — cwd for the 🌐 global workspace.
pub fn global_dir() -> PathBuf {
    data_dir().join("global")
}

/// `~/.vecway/status/` — status files written by the extension (§8).
pub fn status_dir() -> PathBuf {
    data_dir().join("status")
}

/// `~/.vecway/extension/vecway-status.ts`
pub fn extension_path() -> PathBuf {
    data_dir().join("extension").join("vecway-status.ts")
}

/// `~/.vecway/extension/vecway-checkpoints.ts`
pub fn checkpoints_extension_path() -> PathBuf {
    data_dir()
        .join("extension")
        .join("vecway-checkpoints.ts")
}

/// `~/.vecway/extension/vecway-privacy.ts`
pub fn privacy_extension_path() -> PathBuf {
    data_dir()
        .join("extension")
        .join("vecway-privacy.ts")
}

/// `~/.vecway/extension/vecway-plan.ts`
pub fn plan_extension_path() -> PathBuf {
    data_dir().join("extension").join("vecway-plan.ts")
}

/// `~/.vecway/extension/vecway-automation.ts`
pub fn automation_extension_path() -> PathBuf {
    data_dir()
        .join("extension")
        .join("vecway-automation.ts")
}

/// True when using the default `~/.vecway` user data dir (not an isolated dev/test dir).
pub fn is_default_data_dir() -> bool {
    std::env::var_os("OMPWS_DATA_DIR").is_none_or(|v| v.to_string_lossy().trim().is_empty())
}

/// `~/.vecway/logs/`
pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

/// `~/.vecway/oneshot-sessions/`
pub fn oneshot_dir() -> PathBuf {
    data_dir().join("oneshot-sessions")
}

/// `~/.vecway/automations/`
pub fn automations_dir() -> PathBuf {
    data_dir().join("automations")
}

/// `~/.omp-workspace/automations/<sanitized-id>/`
pub fn automation_dir(id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('.');
    let name = if trimmed.is_empty() {
        "default"
    } else {
        trimmed
    };
    automations_dir().join(name)
}

/// `~/.omp/agent/sessions/`
pub fn omp_sessions_dir() -> PathBuf {
    home().join(".omp").join("agent").join("sessions")
}

/// One-time migration from `~/.omp-workspace` to `~/.vecway` when upgrading.
fn migrate_legacy_data_dir_in(legacy: &std::path::Path, target: &std::path::Path) {
    if !target.exists() && legacy.is_dir() {
        if let Err(e) = std::fs::rename(legacy, target) {
            eprintln!(
                "vecway: migrate {} -> {} failed: {e}",
                legacy.display(),
                target.display()
            );
        }
    }
}

/// Create all app-owned directories at startup.
pub fn ensure_dirs() -> io::Result<()> {
    if is_default_data_dir() {
        migrate_legacy_data_dir_in(&home().join(".omp-workspace"), &data_dir());
    }
    for dir in [
        data_dir(),
        global_dir(),
        status_dir(),
        oneshot_dir(),
        automations_dir(),
    ] {
        std::fs::create_dir_all(&dir)?;
    }
    if let Some(parent) = extension_path().parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Seed the global workspace guide once; never overwrite user edits.
    let guide = global_dir().join("AGENTS.md");
    if !guide.exists() {
        std::fs::write(&guide, include_str!("../prompts/global-agents.md"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_data_dir_default_and_override() {
        let default_dir = data_dir();
        assert!(default_dir.ends_with(".vecway"));

        std::env::set_var("OMPWS_DATA_DIR", "/tmp/ompws-test-env");
        assert_eq!(data_dir(), PathBuf::from("/tmp/ompws-test-env"));
        std::env::remove_var("OMPWS_DATA_DIR");
        assert_eq!(data_dir(), default_dir);
    }

    #[test]
    fn test_migrate_legacy_data_dir() {
        let base = std::env::temp_dir().join(format!("vecway-mig-{}", uuid::Uuid::new_v4()));
        let legacy = base.join(".omp-workspace");
        let target = base.join(".vecway");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("marker.txt"), "ok").unwrap();
        migrate_legacy_data_dir_in(&legacy, &target);
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read_to_string(target.join("marker.txt")).unwrap(),
            "ok"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}
