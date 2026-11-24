//! App wiring: state, plugins, invoke_handler list, background tasks. [LEAD]
//! Contract: docs/ARCHITECTURE.md — do not change shared contracts silently.

mod backlog;
mod catalog;
mod contracts;
mod db;
mod diagnostics;
mod git;
mod ime;
mod local_rows;
mod mobile;
mod model_replace;
mod model_templates;
mod notify;
mod omp_files;
mod omp_install;
mod paths;
mod privacy;
mod prompt_composition;
mod prompts;
mod providers;
mod rpc;
mod schedules;
mod services;
mod settings;
mod settings_mcp;
mod settings_model_roles;
mod settings_plugins;
mod skills;
mod state;
mod storage;
mod terminal;
mod todos;
mod visualize;

use contracts::{AppPaths, Settings};
use state::AppState;
use tauri::{Emitter as _, Manager as _};

/// Menu id of the custom Cmd+W item; the webview decides what it closes (src/lib/nativeShortcuts.ts).
const CLOSE_TAB_MENU_ID: &str = "close-tab";

/// Cached git worktree identity for the process cwd so menu construction,
/// startup window title, and the IPC query spawn `git` at most once.
fn cached_worktree_identity() -> Option<String> {
    static IDENTITY: std::sync::LazyLock<Option<String>> = std::sync::LazyLock::new(|| {
        std::env::current_dir()
            .ok()
            .and_then(|d| settings::worktree_identity(&d))
    });
    IDENTITY.clone()
}

/// Apply the startup window title using the cached worktree identity so `git`
/// is not invoked a second time right after `build_app_menu`.
fn apply_startup_window_title(state: &AppState) {
    if !state.settings.read().window_worktree_title {
        return;
    }
    let Some(identity) = cached_worktree_identity() else {
        return;
    };
    if let Some(window) = state.app.get_webview_window("main") {
        let config = state.app.config();
        let base = config
            .app
            .windows
            .iter()
            .find(|w| w.label == "main")
            .map(|w| w.title.clone())
            .filter(|t| !t.is_empty())
            .or_else(|| config.product_name.clone())
            .unwrap_or_default();
        if !base.is_empty() {
            let title = if identity.is_empty() || identity == base {
                base
            } else {
                format!("{base} · {identity}")
            };
            let _ = window.set_title(&title);
        }
    }
}

/// Default app menu with every native "Close Window" item (Cmd+W → `performClose:`,
/// which closes the only window and quits the app) swapped for a custom item that
/// just notifies the webview. The Window submenu copy is dropped to avoid a duplicate accelerator.
fn build_app_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuItem, MenuItemKind};
    let menu = tauri::menu::Menu::default(handle)?;
    let mut replaced = false;
    let mut is_first = true;
    let wt = cached_worktree_identity();
    for top in menu.items()? {
        let MenuItemKind::Submenu(sub) = top else {
            continue;
        };
        if is_first {
            is_first = false;
            if let Some(identity) = &wt {
                let clean = identity.strip_prefix("omp/").unwrap_or(identity);
                let _ = sub.set_text(format!("dev-{}", clean));
            }
        }
        for (pos, item) in sub.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(p) = &item else {
                continue;
            };
            if p.text()? != "Close Window" && p.text()? != "Close" {
                continue;
            }
            sub.remove(&item)?;
            if !replaced {
                let close = MenuItem::with_id(
                    handle,
                    CLOSE_TAB_MENU_ID,
                    "关闭标签页",
                    true,
                    Some("CmdOrCtrl+W"),
                )?;
                sub.insert(&close, pos)?;
                replaced = true;
            }
        }
    }
    Ok(menu)
}

// ---- LEAD commands (§7) — fully implemented ----

#[tauri::command]
async fn get_settings(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    let saved = settings::save(&state, settings).await?;
    notify::refresh_badge(&state).await;
    settings::apply_window_title(&state);
    settings::reconcile_launch_agent(&state).await;
    Ok(saved)
}

#[tauri::command]
async fn app_paths() -> Result<AppPaths, String> {
    Ok(AppPaths {
        data_dir: paths::data_dir().to_string_lossy().to_string(),
        global_dir: paths::global_dir().to_string_lossy().to_string(),
    })
}

/// Returns the enclosing `.app` bundle root when `exe_path` lives at
/// `<Bundle>.app/Contents/MacOS/<binary>`, so macOS relaunch can reopen the
/// bundle via LaunchServices after the current process has exited.
pub fn macos_app_bundle_root(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let macos_dir = exe_path.parent()?;
    if macos_dir.file_name() != Some(std::ffi::OsStr::new("MacOS")) {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name() != Some(std::ffi::OsStr::new("Contents")) {
        return None;
    }
    let bundle_root = contents_dir.parent()?;
    if bundle_root.extension() != Some(std::ffi::OsStr::new("app")) {
        return None;
    }
    Some(bundle_root.to_path_buf())
}

#[cfg(any(target_os = "macos", test))]
fn relaunch_extra_args(args: &[std::ffi::OsString]) -> Vec<std::ffi::OsString> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.to_string_lossy().starts_with("-psn_"))
        .cloned()
        .collect()
}

#[cfg(any(target_os = "macos", test))]
const MACOS_RELAUNCH_TOUCH_SCRIPT: &str = r#"for p in "$app" "$app/Contents/Info.plist" "$app/Contents/Resources/icon.icns" "$app/Contents/Resources/dev.icns"; do
  [ -e "$p" ] && /usr/bin/touch -c "$p" 2>/dev/null || true
done"#;

#[cfg(any(target_os = "macos", test))]
fn macos_relaunch_script() -> String {
    format!(
        r#"pid="$1"
app="$2"
shift 2
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do
  sleep 0.05
  i=$((i + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  exit 1
fi
{MACOS_RELAUNCH_TOUCH_SCRIPT}
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$app" >/dev/null 2>&1 || true
fi
sleep 0.2
if [ "$#" -gt 0 ]; then
  exec /usr/bin/open "$app" --args "$@"
else
  exec /usr/bin/open "$app"
fi"#
    )
}

/// Locate the `.icns` resource inside a packaged macOS `.app` bundle.
#[cfg(any(target_os = "macos", test))]
fn macos_bundle_icon_path(bundle_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let resources = bundle_root.join("Contents").join("Resources");
    for name in ["icon.icns", "dev.icns"] {
        let candidate = resources.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Build a lightweight stamp for `(app_version, icon_size, icon_mtime)` so LaunchServices
/// re-registration only runs once when a new app bundle or icon is first launched.
#[cfg(any(target_os = "macos", test))]
fn bundle_icon_stamp(icon_path: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(icon_path).ok()?;
    let secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(format!(
        "{}:{}:{}",
        env!("CARGO_PKG_VERSION"),
        meta.len(),
        secs
    ))
}

#[cfg(target_os = "macos")]
mod macos_icon {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use std::ffi::c_char;
    use std::os::raw::c_void;
    use std::path::Path;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    unsafe fn msg0(obj: *mut c_void, sel: *const c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, sel)
    }

    unsafe fn msg1_ret(obj: *mut c_void, sel: *const c_void, arg: *const c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, sel, arg)
    }

    unsafe fn msg1_void(obj: *mut c_void, sel: *const c_void, arg: *const c_void) {
        let f: unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, sel, arg);
    }

    unsafe fn msg0_void(obj: *mut c_void, sel: *const c_void) {
        let f: unsafe extern "C" fn(*mut c_void, *const c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, sel);
    }

    /// Notify Finder/IconServices of bundle changes and force the live Dock tile to render
    /// the `.app` bundle's own `.icns` file rather than a stale IconServices cache entry.
    pub fn apply_bundle_icon(bundle_root: &Path, icon_path: Option<&Path>) {
        // SAFETY: Called on the main AppKit thread during Tauri `setup`; CFString is
        // toll-free bridged to NSString and retained/released per AppKit ownership rules.
        unsafe {
            let ws_cls = objc_getClass(c"NSWorkspace".as_ptr());
            if !ws_cls.is_null() {
                let ws = msg0(ws_cls, sel_registerName(c"sharedWorkspace".as_ptr()));
                if !ws.is_null() {
                    let ns_bundle = CFString::new(&bundle_root.to_string_lossy());
                    msg1_void(
                        ws,
                        sel_registerName(c"noteFileSystemChanged:".as_ptr()),
                        ns_bundle.as_concrete_TypeRef() as *const c_void,
                    );
                }
            }
            let Some(icon_path) = icon_path else {
                return;
            };
            let img_cls = objc_getClass(c"NSImage".as_ptr());
            let app_cls = objc_getClass(c"NSApplication".as_ptr());
            if img_cls.is_null() || app_cls.is_null() {
                return;
            }
            let img_alloc = msg0(img_cls, sel_registerName(c"alloc".as_ptr()));
            if img_alloc.is_null() {
                return;
            }
            let ns_icon = CFString::new(&icon_path.to_string_lossy());
            let img = msg1_ret(
                img_alloc,
                sel_registerName(c"initWithContentsOfFile:".as_ptr()),
                ns_icon.as_concrete_TypeRef() as *const c_void,
            );
            if img.is_null() {
                return;
            }
            let ns_app = msg0(app_cls, sel_registerName(c"sharedApplication".as_ptr()));
            if !ns_app.is_null() {
                msg1_void(
                    ns_app,
                    sel_registerName(c"setApplicationIconImage:".as_ptr()),
                    img,
                );
            }
            msg0_void(img, sel_registerName(c"release".as_ptr()));
        }
    }
}

/// When running from a packaged macOS `.app` bundle, sync the live Dock icon immediately
/// and re-register the bundle with LaunchServices once whenever the bundle icon changes.
fn sync_macos_bundle_icon(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Ok(exe) = tauri::process::current_binary(&app.env()) else {
            return;
        };
        let Some(bundle_root) = macos_app_bundle_root(&exe) else {
            return;
        };
        let icon_path = macos_bundle_icon_path(&bundle_root);
        macos_icon::apply_bundle_icon(&bundle_root, icon_path.as_deref());

        let Some(stamp) = icon_path.as_deref().and_then(bundle_icon_stamp) else {
            return;
        };
        let stamp_file = paths::data_dir().join(".macos-bundle-icon-stamp");
        let prev = std::fs::read_to_string(&stamp_file).ok();
        if prev.as_deref().map(str::trim) == Some(stamp.as_str()) {
            return;
        }
        std::thread::spawn(move || {
            let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
            if std::path::Path::new(lsregister).is_file() {
                let _ = std::process::Command::new(lsregister)
                    .arg("-f")
                    .arg(&bundle_root)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
            let _ = std::fs::write(&stamp_file, &stamp);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn spawn_macos_relaunch_helper(
    bundle_root: &std::path::Path,
    extra_args: &[std::ffi::OsString],
) -> Result<(), String> {
    use std::os::unix::process::CommandExt as _;
    use std::process::{Command, Stdio};

    // Wait for the current process to exit before invoking `open` (without `-n`)
    // so LaunchServices rebinds the new instance to the existing Dock tile instead
    // of creating a duplicate running icon beside the pinned Dock item.
    Command::new("/bin/sh")
        .arg("-c")
        .arg(macos_relaunch_script())
        .arg("omp-workspace-relaunch")
        .arg(std::process::id().to_string())
        .arg(bundle_root)
        .args(extra_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch macOS relaunch helper: {e}"))
}

#[tauri::command]
async fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static RELAUNCHING: AtomicBool = AtomicBool::new(false);

        if let Ok(exe) = tauri::process::current_binary(&app.env()) {
            if let Some(bundle_root) = macos_app_bundle_root(&exe) {
                if RELAUNCHING.swap(true, Ordering::SeqCst) {
                    return Ok(());
                }
                let extra_args = relaunch_extra_args(&app.env().args_os);
                if let Err(err) = spawn_macos_relaunch_helper(&bundle_root, &extra_args) {
                    RELAUNCHING.store(false, Ordering::SeqCst);
                    return Err(err);
                }
                app.exit(0);
                return Ok(());
            }
        }
    }

    app.request_restart();
    Ok(())
}
#[tauri::command]
async fn current_worktree_identity() -> Result<Option<String>, String> {
    Ok(cached_worktree_identity())
}

pub fn parse_allowed_tools_from_text(content: &str) -> Option<Vec<String>> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("allowed_tools") || trimmed.starts_with("allowed-tools") {
            let sep = if trimmed.contains('=') { '=' } else { ':' };
            if let Some((_, val)) = trimmed.split_once(sep) {
                let val = val.trim();
                if val.starts_with('[') && val.ends_with(']') {
                    let inner = &val[1..val.len() - 1];
                    let tools: Vec<String> = inner
                        .split(',')
                        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    return Some(tools);
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn allowed_tools_list() -> Result<Vec<String>, String> {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
    let candidates = [
        home.join(".omp").join("settings.toml"),
        home.join(".omp").join("agent").join("settings.toml"),
        home.join(".config").join("omp").join("settings.toml"),
        home.join(".omp").join("agent").join("config.yml"),
    ];

    for path in candidates {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Some(tools) = parse_allowed_tools_from_text(&content) {
                    return Ok(tools);
                }
            }
        }
    }

    Ok(Vec::new())
}

/// CLI flag of the legacy key-reference fast path (`omp-workspace --ompws-key <id>`).
pub const KEY_FLAG: &str = providers::key_ref::KEY_FLAG;

/// `--ompws-key <id>`: print the legacy vault key for provider `id` to stdout
/// (so leftover `!` references in models.yml keep working) and return the
/// process exit code. Never starts Tauri, logging or the database.
pub fn run_key_cli(id: Option<String>) -> i32 {
    providers::key_ref::run_cli(id)
}

/// CLI flag of the headless automation daemon (`omp-workspace --ompws-automation-daemon`).
pub const AUTOMATION_DAEMON_FLAG: &str = schedules::daemon::DAEMON_FLAG;

/// Run one headless automation sweep without creating any window or Dock icon.
pub fn run_automation_daemon() -> i32 {
    schedules::daemon::run_cli()
}

/// Report an unrecoverable startup error (stderr + native dialog on macOS) and exit cleanly
/// instead of surfacing a raw panic.
fn fatal_startup(what: &str, err: &dyn std::fmt::Display) -> ! {
    let phase = match what {
        "无法创建数据目录 ~/.omp-workspace" => "ensure_dirs",
        "无法打开应用数据库" => "database",
        "无法初始化全局工作区" => "global_workspace",
        _ => "tauri_setup",
    };
    diagnostics::record_startup_failure(phase);
    diagnostics::shutdown();
    let msg = format!("{what}：{err}\n请检查 ~/.omp-workspace 的权限与磁盘空间后重试。");
    eprintln!("vecway: {msg}");
    #[cfg(target_os = "macos")]
    {
        let escaped = msg.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display dialog \"{escaped}\" with title \"Vecway 启动失败\" buttons {{\"好\"}} default button 1 with icon stop"
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    }
    std::process::exit(1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    paths::ensure_dirs().unwrap_or_else(|e| fatal_startup("无法创建数据目录 ~/.omp-workspace", &e));
    schedules::daemon::hold_gui_lock();
    let conn = db::open().unwrap_or_else(|e| fatal_startup("无法打开应用数据库", &e));
    let settings = db::load_settings(&conn);
    let _diagnostics_guard =
        diagnostics::init(&paths::data_dir(), settings.diagnostics_enabled).ok();
    diagnostics::install_panic_hook();
    diagnostics::record_app_started();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id() == CLOSE_TAB_MENU_ID {
                let _ = app.emit("native:close-tab", ());
            }
        })
        .setup(move |app| {
            diagnostics::start_health_task();
            // Isolated instances (`OMPWS_DATA_DIR`) keep images outside the static
            // `$HOME/.omp-workspace/images` scope in tauri.conf.json; allow the live dir.
            {
                use tauri::Manager;
                let _ = std::fs::create_dir_all(paths::images_dir());
                let _ = app
                    .asset_protocol_scope()
                    .allow_directory(paths::images_dir(), true);
            }
            db::ensure_global_workspace(&conn)
                .unwrap_or_else(|e| fatal_startup("无法初始化全局工作区", &e));
            let state = AppState::new(app.handle().clone(), conn, settings);
            app.manage(state.clone());
            // Rewrite privacy files from the DB before any OMP process spawns.
            privacy::init(&state);

            // Register event consumers before catalog and process producers start.
            sync_macos_bundle_icon(app.handle());
            providers::init();
            todos::init(state.clone());
            backlog::init(state.clone());
            notify::init(state.clone());
            catalog::init(state.clone());
            rpc::init(state.clone());
            git::init(state.clone());
            services::init(state.clone());
            apply_startup_window_title(&state);
            mobile::init(state.clone());
            terminal::init(state.clone());
            schedules::init(state.clone());
            model_templates::rules::init(state.clone());
            ime::watch(app.handle());
            skills::usage::warm_up(45);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // LEAD
            get_settings,
            save_settings,
            app_paths,
            app_relaunch,
            current_worktree_identity,
            allowed_tools_list,
            ime::ime_active,
            diagnostics::diagnostics_record,
            // A — catalog
            catalog::commands::list_sessions,
            catalog::commands::get_transcript,
            catalog::commands::update_session_meta,
            catalog::commands::mark_seen,
            catalog::commands::set_quiet_turn,
            catalog::commands::accept_session,
            catalog::commands::list_workspaces,
            catalog::commands::add_workspace,
            catalog::commands::relocate_workspace,
            catalog::commands::remove_workspace,
            catalog::commands::reorder_workspaces,
            catalog::commands::list_session_groups,
            catalog::commands::create_session_group,
            catalog::commands::rename_session_group,
            catalog::commands::delete_session_group,
            catalog::commands::reorder_session_groups,
            catalog::commands::set_session_group,
            catalog::commands::session_usage,
            catalog::commands::activity_usage,
            catalog::commands::session_snapshot,
            catalog::commands::rescan_sessions,
            catalog::search::search_sessions,
            catalog::search::search_index_status,
            catalog::commands::delete_session,
            catalog::commands::list_models,
            catalog::commands::list_workspace_files,
            catalog::commands::session_export_html,
            catalog::commands::session_share,
            catalog::commands::heatmap_diagnose,
            storage::storage_overview,
            storage::storage_images_preview,
            storage::storage_images_clean,
            storage::storage_image_gc_auto,
            storage::storage_clear_web_cache,
            storage::storage_clear_omp_cache,
            storage::storage_clean_status_records,
            storage::storage_compact_db,
            storage::storage_sessions_overview,
            storage::storage_stale_sessions_preview,
            storage::storage_trash_sessions,
            // B — rpc
            rpc::commands::rpc_start,
            rpc::commands::rpc_ensure_live,
            rpc::commands::rpc_send,
            rpc::commands::rpc_touch,
            rpc::commands::rpc_retain,
            rpc::commands::rpc_release,
            rpc::commands::rpc_ui_respond,
            rpc::commands::rpc_pending_ui,
            rpc::commands::rpc_stop,
            rpc::commands::rpc_restart,
            rpc::commands::rpc_list_live,
            rpc::commands::rpc_omp_staleness,
            rpc::commands::takeover_external,
            rpc::commands::create_side_chat,
            rpc::commands::side_chat_ask,
            rpc::commands::image_contents_from_paths,
            rpc::commands::fork_session,
            rpc::commands::tree_navigate,
            rpc::commands::tree_get,
            rpc::commands::subagent_list,
            rpc::commands::subagent_transcript,
            // C — git + time machine
            git::commands::git_summary,
            git::commands::git_badge,
            git::commands::git_repo_root,
            git::commands::git_log,
            git::commands::git_diff,
            git::commands::git_create_worktree,
            git::commands::git_list_worktrees,
            git::commands::git_remove_worktree,
            git::commands::git_scan_orphans,
            git::commands::git_reset_to,
            git::commands::git_restore_file,
            git::commands::git_list_branches,
            git::commands::git_list_branches_detailed,
            git::commands::git_delete_branch,
            git::commands::git_sync_branch,
            git::commands::git_merge_preview,
            git::commands::git_merge_branch,
            git::commands::git_diff_base,
            git::commands::git_rebase_onto_base,
            git::commands::git_discard_all,
            git::commands::git_sync_with_base,
            git::commands::git_get_pr_url,
            git::commands::git_commit_suggest,
            git::commands::git_commit,
            git::commands::git_session_turns,
            git::commands::git_worktree_turns,
            git::commands::git_undo_turn,
            git::commands::checkpoints_rule,
            git::commands::create_project_dir,
            git::commands::git_clone_repo,
            git::commands::tm_run,
            git::commands::tm_list,
            git::commands::tm_stop,
            // C — services + file IO
            services::commands::services_list,
            services::commands::services_stop,
            services::commands::read_text_file,
            services::commands::write_text_file,
            omp_files::omp_memory_projects,
            omp_files::omp_memory_files,
            omp_files::omp_memory_read,
            omp_files::omp_memory_write,
            omp_files::omp_memory_delete_skill,
            omp_files::omp_rule_read,
            omp_files::omp_rule_write,
            omp_files::omp_agent_read,
            omp_files::omp_agent_write,
            services::commands::fs_read_dir,
            services::commands::validate_path,
            services::commands::save_clipboard_image,
            services::commands::import_image_file,
            services::clipboard::clipboard_file_paths,
            services::clipboard::clipboard_write_message,
            services::clipboard::clipboard_text_beside_files,
            services::clipboard::save_clipboard_file,
            services::commands::save_share_image,
            services::commands::app_memory_usage,
            services::commands::perf_breakdown,
            services::permissions::macos_permissions_status,
            services::permissions::macos_open_permission_pane,
            services::permissions::macos_reveal_current_app,
            // D — todos / summaries / diagnose
            todos::commands::todos_list,
            todos::commands::todos_act,
            todos::commands::todos_counts,
            local_rows::local_rows_get,
            local_rows::local_rows_set,
            todos::commands::summary_get,
            todos::commands::diagnose_build_prompt,
            todos::commands::dispatch_prompt,
            // D — backlog
            backlog::commands::backlog_list,
            backlog::commands::backlog_add,
            backlog::commands::backlog_update,
            backlog::commands::backlog_delete,
            backlog::commands::backlog_restore,
            backlog::commands::backlog_purge,
            backlog::commands::backlog_build_prompt,
            // D — notify
            notify::commands::notify_test,
            // D — settings (OMP config bridge)
            settings::omp_config_list,
            settings::omp_config_set,
            settings::omp_config_reset,
            settings::omp_project_config_read,
            settings_model_roles::omp_model_roles_read,
            settings_model_roles::omp_model_roles_set,
            // D — bulk model replace (全局批量替换模型)
            model_replace::model_usage_scan,
            model_replace::model_replace_apply,
            model_replace::model_replace_history,
            model_replace::model_replace_undo,
            model_replace::model_probe,
            model_replace::model_kind_catalog,
            prompt_composition::prompt_composition_probe,
            prompt_composition::session_prompt_composition,
            settings::omp_info,
            settings::omp_update_check,
            settings::omp_update_run,
            omp_install::omp_install_run,
            omp_install::omp_install_cancel,
            // providers (API provider manager)
            providers::commands::provider_rows,
            providers::commands::provider_set_enabled,
            providers::commands::provider_upsert,
            providers::commands::provider_set_key,
            providers::commands::provider_save_builtin,
            providers::service_config::service_config_read,
            providers::service_config::service_config_write,
            providers::commands::provider_delete,
            providers::commands::provider_test,
            providers::commands::provider_test_model,
            providers::commands::provider_fetch_models,
            providers::commands::provider_export_env_text,
            providers::commands::provider_read_env_file,
            providers::models_yml_write::omp_models_set_context_windows,
            providers::models_yml_write::omp_models_context_window_overrides,
            providers::commands::oauth_login_providers,
            providers::commands::oauth_login_start,
            providers::commands::oauth_login_respond,
            providers::commands::oauth_login_cancel,
            providers::commands::oauth_login_open_url,
            providers::commands::oauth_login_status,
            providers::commands::oauth_logout,
            providers::commands::omp_usage_report,
            // E — mobile + tunnel
            mobile::commands::mobile_camera_start,
            mobile::commands::mobile_camera_poll,
            mobile::commands::mobile_camera_ack,
            mobile::commands::mobile_camera_stop,
            mobile::api::voice::voice_transcribe,
            mobile::commands::mobile_start,
            mobile::commands::mobile_stop,
            mobile::commands::mobile_status,
            mobile::commands::mobile_create_pairing,
            mobile::commands::mobile_revoke_all,
            mobile::commands::mobile_list_devices,
            mobile::commands::mobile_rename_device,
            mobile::commands::mobile_device_work,
            mobile::commands::mobile_revoke_device,
            mobile::commands::mobile_ipv6_start,
            mobile::commands::mobile_ipv6_stop,
            mobile::commands::tunnel_start,
            mobile::commands::tunnel_stop,
            mobile::commands::tunnel_cloudflared_login,
            // E — mobile DDNS
            mobile::ddns::mobile_ddns_set_token,
            mobile::ddns::mobile_ddns_clear_token,
            mobile::ddns::mobile_ddns_sync,
            // E — terminal
            terminal::commands::term_open,
            terminal::commands::term_write,
            terminal::commands::term_resize,
            terminal::commands::term_close,
            terminal::commands::term_open_session,
            terminal::commands::session_resume_command,
            terminal::commands::terminal_set_current_session,
            terminal::commands::install_status_extension_globally,
            // E — schedules (自动化)
            schedules::commands::schedules_list,
            schedules::commands::schedules_save,
            schedules::commands::schedules_delete,
            schedules::commands::schedules_set_enabled,
            schedules::commands::schedules_run_now,
            schedules::commands::schedules_resume_awaiting,
            schedules::commands::schedules_release_awaiting,
            schedules::commands::schedules_list_awaiting,
            schedules::commands::schedule_runs,
            schedules::commands::schedules_test_probe,
            schedules::commands::schedules_generate_draft,
            // F — skills & extensions (技能与扩展)
            skills::commands::skills_list,
            skills::commands::skills_read,
            skills::usage::skills_usage,
            skills::commands::skills_trash,
            skills::commands::extension_enable_file,
            // D — MCP servers + plugin enablement (OMP-managed config files)
            settings_mcp::mcp_config_list,
            settings_mcp::mcp_catalog,
            settings_mcp::mcp_server_save,
            settings_mcp::mcp_server_set_scope,
            settings_mcp::mcp_server_set_enabled,
            settings_mcp::mcp_server_delete,
            settings_plugins::plugins_list,
            settings_plugins::plugin_set_enabled,
            settings_plugins::extension_delete,
            // D — model templates + quota switching
            model_templates::model_templates_snapshot,
            model_templates::model_template_capture,
            model_templates::model_template_save,
            model_templates::model_template_delete,
            model_templates::model_template_preview,
            model_templates::model_template_apply,
            model_templates::model_switch_rule_save,
            model_templates::model_switch_rule_delete,
            model_templates::model_switch_rules_reorder,
            model_templates::model_switch_settings_set,
            model_templates::model_switch_status,
            model_templates::model_switch_run_now,
            model_templates::model_switch_undo,
            // P — privacy placeholders
            privacy::commands::privacy_list,
            privacy::commands::privacy_classify,
            privacy::commands::privacy_mark,
            privacy::commands::privacy_update,
            privacy::commands::privacy_delete,
            privacy::commands::privacy_session_entry_ids,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Cmd+W with nothing left to close hides the window; a Dock click brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            if let tauri::RunEvent::Exit = event {
                terminal::pty::close_all();
                mobile::tunnel::stop();
                // Preserve worktrees and autostart settings; stop only app-owned processes.
                let runs = git::tm::list();
                std::thread::scope(|scope| {
                    for run in runs {
                        scope.spawn(move || {
                            let _ = git::tm::stop(&run.id, false);
                        });
                    }
                });
                tauri::async_runtime::block_on(rpc::shutdown());
                diagnostics::emit(diagnostics::DiagnosticEvent::new("app.exit", "startup"));
                diagnostics::shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_allowed_tools_from_toml() {
        let content = r#"
default_model = "gpt-4o"
allowed_tools = ["read", "write", "bash"]
"#;
        let tools = parse_allowed_tools_from_text(content).unwrap();
        assert_eq!(tools, vec!["read", "write", "bash"]);
    }

    #[test]
    fn test_parse_allowed_tools_from_yaml() {
        let content = r#"
tools:
  approvalMode: write
allowed-tools: ["edit", "glob"]
"#;
        let tools = parse_allowed_tools_from_text(content).unwrap();
        assert_eq!(tools, vec!["edit", "glob"]);
    }

    #[test]
    fn test_macos_app_bundle_root() {
        assert_eq!(
            macos_app_bundle_root(std::path::Path::new(
                "/Applications/omp-workspace.app/Contents/MacOS/omp-workspace"
            )),
            Some(std::path::PathBuf::from("/Applications/omp-workspace.app"))
        );
        assert_eq!(
            macos_app_bundle_root(std::path::Path::new(
                "/Users/dev/target/debug/omp-workspace"
            )),
            None
        );
        assert_eq!(
            macos_app_bundle_root(std::path::Path::new(
                "/Applications/NotABundle/Contents/MacOS/omp-workspace"
            )),
            None
        );
        assert_eq!(
            macos_app_bundle_root(std::path::Path::new(
                "/Applications/omp-workspace.app/Contents/Resources/helper"
            )),
            None
        );
    }

    #[test]
    fn test_relaunch_extra_args_filters_program_and_psn() {
        let args = vec![
            std::ffi::OsString::from(
                "/Applications/omp-workspace.app/Contents/MacOS/omp-workspace",
            ),
            std::ffi::OsString::from("-psn_0_123456"),
            std::ffi::OsString::from("--flag"),
            std::ffi::OsString::from("value"),
        ];
        assert_eq!(
            relaunch_extra_args(&args),
            vec![
                std::ffi::OsString::from("--flag"),
                std::ffi::OsString::from("value"),
            ]
        );
    }

    #[test]
    fn test_parse_allowed_tools_none() {
        let content = r#"
tools:
  approvalMode: write
"#;
        assert!(parse_allowed_tools_from_text(content).is_none());
    }

    #[test]
    fn test_macos_relaunch_script_refreshes_bundle_before_open() {
        let script = macos_relaunch_script();
        assert!(script.contains("/usr/bin/touch -c"));
        assert!(script.contains("[ -e \"$p\" ]"));
        assert!(script.contains("lsregister"));
        assert!(script.contains("-f \"$app\""));
        let touch_pos = script.find("/usr/bin/touch -c").unwrap();
        let lsreg_pos = script.find("lsregister").unwrap();
        let open_pos = script.find("/usr/bin/open").unwrap();
        assert!(touch_pos < lsreg_pos && lsreg_pos < open_pos);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_macos_relaunch_touch_script_never_creates_missing_icons() {
        let tmp = std::env::temp_dir().join(format!("vecway-touch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);

        let prod_app = tmp.join("Vecway.app");
        let prod_contents = prod_app.join("Contents");
        let prod_res = prod_contents.join("Resources");
        std::fs::create_dir_all(&prod_res).unwrap();
        std::fs::write(prod_contents.join("Info.plist"), b"plist").unwrap();
        std::fs::write(prod_res.join("icon.icns"), b"prod-icon").unwrap();

        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(MACOS_RELAUNCH_TOUCH_SCRIPT)
            .env("app", &prod_app)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(prod_res.join("icon.icns").is_file());
        assert!(!prod_res.join("dev.icns").exists());

        let dev_app = tmp.join("Vecway Dev.app");
        let dev_contents = dev_app.join("Contents");
        let dev_res = dev_contents.join("Resources");
        std::fs::create_dir_all(&dev_res).unwrap();
        std::fs::write(dev_contents.join("Info.plist"), b"plist").unwrap();
        std::fs::write(dev_res.join("dev.icns"), b"dev-icon").unwrap();

        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(MACOS_RELAUNCH_TOUCH_SCRIPT)
            .env("app", &dev_app)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(dev_res.join("dev.icns").is_file());
        assert!(!dev_res.join("icon.icns").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_macos_bundle_icon_path_and_stamp() {
        let tmp = std::env::temp_dir().join(format!("vecway-icon-test-{}", std::process::id()));
        let res = tmp.join("Vecway.app").join("Contents").join("Resources");
        std::fs::create_dir_all(&res).unwrap();

        assert!(macos_bundle_icon_path(&tmp.join("Vecway.app")).is_none());

        let dev_icon = res.join("dev.icns");
        std::fs::write(&dev_icon, b"dev-bytes").unwrap();
        assert_eq!(
            macos_bundle_icon_path(&tmp.join("Vecway.app")),
            Some(dev_icon.clone())
        );

        let prod_icon = res.join("icon.icns");
        std::fs::write(&prod_icon, b"prod-v1").unwrap();
        assert_eq!(
            macos_bundle_icon_path(&tmp.join("Vecway.app")),
            Some(prod_icon.clone())
        );

        let stamp1 = bundle_icon_stamp(&prod_icon).unwrap();
        std::fs::write(&prod_icon, b"prod-v2-longer").unwrap();
        let stamp2 = bundle_icon_stamp(&prod_icon).unwrap();
        assert_ne!(stamp1, stamp2);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
