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

/// Default `~/.vecway` data directory (ignoring `OMPWS_DATA_DIR`).
pub fn default_data_dir() -> PathBuf {
    home().join(".vecway")
}

/// Pure core of [`data_dir`]: env override is passed in so tests need no global env.
pub(crate) fn data_dir_from(override_dir: Option<&str>, home: &std::path::Path) -> PathBuf {
    if let Some(dir) = override_dir.map(str::trim).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    home.join(".vecway")
}

/// `~/.vecway` (overridable via `OMPWS_DATA_DIR` for isolated dev/preview instances)
pub fn data_dir() -> PathBuf {
    let override_dir = std::env::var("OMPWS_DATA_DIR").ok();
    data_dir_from(override_dir.as_deref(), &home())
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

/// Remap a legacy `~/.omp-workspace/images/<rel>` path into `images_dir` when
/// the legacy path no longer exists on disk and the migrated file does.
pub fn resolve_migrated_image_in(raw: &str, images_dir: &std::path::Path) -> Option<PathBuf> {
    let p = std::path::Path::new(raw);
    if p.is_file() {
        return None;
    }
    let legacy_dir = std::ffi::OsStr::new(".omp-workspace");
    let images_seg = std::ffi::OsStr::new("images");
    let mut comps = p.components();
    while let Some(c) = comps.next() {
        if c == std::path::Component::Normal(legacy_dir) {
            let mut rest = comps.clone();
            if rest.next() == Some(std::path::Component::Normal(images_seg)) {
                let rel: PathBuf = rest.collect();
                if !rel.as_os_str().is_empty() {
                    let candidate = images_dir.join(rel);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

/// Resolve a stored image path: returns the path itself when it exists as a
/// file, or its migrated counterpart inside `images_dir` if it came from
/// `~/.omp-workspace/images/`.
pub fn resolve_image_path_in(raw: &str, images_dir: &std::path::Path) -> Option<PathBuf> {
    let p = std::path::Path::new(raw);
    if p.is_file() {
        return Some(p.to_path_buf());
    }
    resolve_migrated_image_in(raw, images_dir)
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
    data_dir().join("extension").join("vecway-checkpoints.ts")
}

/// `~/.vecway/extension/vecway-privacy.ts`
pub fn privacy_extension_path() -> PathBuf {
    data_dir().join("extension").join("vecway-privacy.ts")
}

/// `~/.vecway/extension/vecway-plan.ts`
pub fn plan_extension_path() -> PathBuf {
    data_dir().join("extension").join("vecway-plan.ts")
}

/// `~/.vecway/extension/vecway-automation.ts`
pub fn automation_extension_path() -> PathBuf {
    data_dir().join("extension").join("vecway-automation.ts")
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

/// `~/.vecway/automations/<sanitized-id>/`
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

/// Move entries from `src` into an existing `dst` directory without overwriting
/// any file that already exists in `dst`.
fn merge_dir_missing(src: &std::path::Path, dst: &std::path::Path) {
    let entries = match std::fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!(
                "vecway: read {} failed during migration: {e}",
                src.display()
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if dst_path.symlink_metadata().is_err() {
            if let Err(e) = std::fs::rename(&src_path, &dst_path) {
                eprintln!(
                    "vecway: migrate {} -> {} failed: {e}",
                    src_path.display(),
                    dst_path.display()
                );
            }
        } else if src_path.symlink_metadata().is_ok_and(|m| m.is_dir())
            && dst_path.symlink_metadata().is_ok_and(|m| m.is_dir())
        {
            merge_dir_missing(&src_path, &dst_path);
            let _ = std::fs::remove_dir(&src_path);
        }
    }
}

/// One-time migration from `~/.omp-workspace` to `~/.vecway` when upgrading.
///
/// If `~/.vecway` already exists (for instance because shell-init or status
/// files were written before first launch) but has no database yet, merge all
/// non-conflicting files and directories from `~/.omp-workspace` into it.
fn migrate_legacy_data_dir_in(legacy: &std::path::Path, target: &std::path::Path) {
    if !legacy.is_dir() {
        return;
    }
    if target.symlink_metadata().is_err() {
        if let Err(e) = std::fs::rename(legacy, target) {
            eprintln!(
                "vecway: migrate {} -> {} failed: {e}",
                legacy.display(),
                target.display()
            );
        }
        return;
    }
    if !target.is_dir() {
        return;
    }
    // Never overwrite an initialized database (or partial WAL/SHM journal).
    if ["app.db", "app.db-wal", "app.db-shm"]
        .iter()
        .any(|name| target.join(name).exists())
    {
        return;
    }
    merge_dir_missing(legacy, target);
    let _ = std::fs::remove_dir(legacy);
}

/// Create all app-owned directories at startup.
pub fn ensure_dirs() -> io::Result<()> {
    if is_default_data_dir() {
        migrate_legacy_data_dir_in(&home().join(".omp-workspace"), &default_data_dir());
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
    fn test_data_dir_from_trims_and_falls_back() {
        let h = std::path::Path::new("/Users/tester");
        assert_eq!(
            data_dir_from(None, h),
            PathBuf::from("/Users/tester/.vecway")
        );
        assert_eq!(
            data_dir_from(Some("   "), h),
            PathBuf::from("/Users/tester/.vecway")
        );
        assert_eq!(
            data_dir_from(Some("  /tmp/vecway-isolated  "), h),
            PathBuf::from("/tmp/vecway-isolated")
        );
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

    #[test]
    fn test_migrate_legacy_data_dir_merges_when_target_exists_without_db() {
        let base = std::env::temp_dir().join(format!("vecway-mig-merge-{}", uuid::Uuid::new_v4()));
        let legacy = base.join(".omp-workspace");
        let target = base.join(".vecway");
        std::fs::create_dir_all(legacy.join("images")).unwrap();
        std::fs::create_dir_all(legacy.join("status")).unwrap();
        std::fs::write(legacy.join("app.db"), "legacy-db").unwrap();
        std::fs::write(legacy.join("app.db-wal"), "legacy-wal").unwrap();
        std::fs::write(legacy.join("images").join("a.png"), "png").unwrap();
        std::fs::write(legacy.join("status").join("old.json"), "old").unwrap();
        std::fs::write(legacy.join("status").join("shared.json"), "from-legacy").unwrap();
        std::fs::write(legacy.join("bashrc"), "old-bashrc").unwrap();

        // Simulate pre-existing target created by shell-init / status before first app launch.
        std::fs::create_dir_all(target.join("status")).unwrap();
        std::fs::write(target.join("bashrc"), "new-bashrc").unwrap();
        std::fs::write(target.join("status").join("shared.json"), "from-target").unwrap();

        migrate_legacy_data_dir_in(&legacy, &target);

        assert_eq!(
            std::fs::read_to_string(target.join("app.db")).unwrap(),
            "legacy-db"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("app.db-wal")).unwrap(),
            "legacy-wal"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("images").join("a.png")).unwrap(),
            "png"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("status").join("old.json")).unwrap(),
            "old"
        );
        // Existing files in target are preserved.
        assert_eq!(
            std::fs::read_to_string(target.join("bashrc")).unwrap(),
            "new-bashrc"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("status").join("shared.json")).unwrap(),
            "from-target"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_migrate_legacy_data_dir_skips_when_target_has_db() {
        let base = std::env::temp_dir().join(format!("vecway-mig-skip-{}", uuid::Uuid::new_v4()));
        let legacy = base.join(".omp-workspace");
        let target = base.join(".vecway");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(legacy.join("app.db"), "legacy-db").unwrap();
        std::fs::write(legacy.join("extra.txt"), "legacy-extra").unwrap();
        std::fs::write(target.join("app.db"), "target-db").unwrap();

        migrate_legacy_data_dir_in(&legacy, &target);

        assert_eq!(
            std::fs::read_to_string(target.join("app.db")).unwrap(),
            "target-db"
        );
        assert!(!target.join("extra.txt").exists());
        assert!(legacy.join("app.db").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_resolve_migrated_image_in() {
        let base = std::env::temp_dir().join(format!("vecway-img-rel-{}", uuid::Uuid::new_v4()));
        let images_dir = base.join(".vecway").join("images");
        std::fs::create_dir_all(&images_dir).unwrap();
        let target = images_dir.join("shot.png");
        std::fs::write(&target, b"png").unwrap();

        let legacy_path = base.join(".omp-workspace").join("images").join("shot.png");
        let legacy_str = legacy_path.to_string_lossy().into_owned();
        assert_eq!(
            resolve_migrated_image_in(&legacy_str, &images_dir),
            Some(target.clone())
        );
        assert_eq!(
            resolve_image_path_in(&legacy_str, &images_dir),
            Some(target.clone())
        );
        assert_eq!(
            resolve_migrated_image_in(target.to_str().unwrap(), &images_dir),
            None
        );
        assert_eq!(
            resolve_image_path_in(target.to_str().unwrap(), &images_dir),
            Some(target)
        );
        let missing = base
            .join(".omp-workspace")
            .join("images")
            .join("missing.png");
        assert_eq!(
            resolve_image_path_in(missing.to_str().unwrap(), &images_dir),
            None
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}
