//! Automations extension: bundled source + install-at-startup.
//!
//! Loaded alongside `omp-workspace-plan.ts` via `omp -e <path>` so interactive chat
//! sessions can inspect automations, stage check scripts in `~/.omp-workspace/automations/<id>/`,
//! and present an interactive draft confirmation card via the `ompws-automation` status key.

/// Bundled extension source (repo `extension/omp-workspace-automation.ts`).
pub const EXT_SOURCE: &str = include_str!("../../../extension/omp-workspace-automation.ts");

/// Install the bundled extension into `~/.omp-workspace/extension/` (startup).
pub fn install() {
    if let Err(e) =
        super::privacy_ext::write_if_changed(&crate::paths::automation_extension_path(), EXT_SOURCE)
    {
        tracing::warn!("install automation extension: {e}");
    }
}
