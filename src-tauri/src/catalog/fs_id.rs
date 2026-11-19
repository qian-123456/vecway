//! Filesystem identity tracking and post-relocation repairs for workspaces.
//!
//! 3-layer workspace path protection:
//! 1. Current path on `workspaces.path` (fast path).
//! 2. Filesystem directory identity `(dir_dev, dir_ino)`:
//!    - macOS: `(st_dev, st_ino)` via sibling scan + `/.vol/<dev>/<ino>` (`F_GETPATH`).
//!    - Linux: `(st_dev, st_ino)` via sibling scan (and `add_workspace` same-inode matching).
//!    - Windows: NTFS `(dwVolumeSerialNumber, FileId)` via `GetFileInformationByHandle`
//!      + `OpenFileById` / `GetFinalPathNameByHandleW` volume resolution.
//! 3. Explicit manual relocation (`relocate_workspace`), with path aliases so
//!    historical read-only OMP transcripts remain linked and runnable.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirIdentity {
    pub dev: u64,
    pub ino: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct WinFileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

#[repr(C)]
struct WinByHandleFileInformation {
    dw_file_attributes: u32,
    ft_creation_time: WinFileTime,
    ft_last_access_time: WinFileTime,
    ft_last_write_time: WinFileTime,
    dw_volume_serial_number: u32,
    n_file_size_high: u32,
    n_file_size_low: u32,
    n_number_of_links: u32,
    n_file_index_high: u32,
    n_file_index_low: u32,
}

/// Mirrors Win32 `FILE_ID_DESCRIPTOR` (24 bytes on 64-bit Windows due to the
/// 16-byte `DUMMYUNIONNAME` holding `FileId` / `ObjectId` / `ExtendedFileId`).
#[repr(C)]
struct WinFileIdDescriptor {
    dw_size: u32,
    id_type: i32,
    file_id: i64,
    _pad: [u8; 8],
}

/// Read the filesystem identity `(dev, ino)` of an existing directory.
#[cfg(unix)]
pub fn read_dir_identity(path: &Path) -> Option<DirIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    Some(DirIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
    })
}

#[cfg(windows)]
pub fn read_dir_identity(path: &Path) -> Option<DirIdentity> {
    win_impl::read_dir_identity(path)
}

#[cfg(not(any(unix, windows)))]
pub fn read_dir_identity(_path: &Path) -> Option<DirIdentity> {
    None
}

fn is_trash_path(path: &Path) -> bool {
    path.to_string_lossy().split(['/', '\\']).any(|s| {
        s == ".Trash"
            || s == ".Trashes"
            || s.eq_ignore_ascii_case("$Recycle.Bin")
            || s.eq_ignore_ascii_case("RECYCLER")
    })
}

fn strip_win32_extended_prefix(raw: &str) -> String {
    if raw.len() >= 8 && raw[..8].eq_ignore_ascii_case(r"\\?\UNC\") {
        format!(r"\\{}", &raw[8..])
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.to_string()
    }
}

fn trim_trailing_seps(path: &str) -> &str {
    let bytes = path.as_bytes();
    if bytes.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return path;
    }
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() && !path.is_empty() {
        "/"
    } else {
        trimmed
    }
}

fn same_canon(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

#[cfg(target_os = "macos")]
fn resolve_volfs_macos(id: DirIdentity) -> Option<PathBuf> {
    use std::ffi::{CStr, CString};

    let vol = format!("/.vol/{}/{}", id.dev, id.ino);
    let c_vol = CString::new(vol).ok()?;
    // SAFETY: `c_vol` is NUL-terminated; `fd` is checked >= 0 and always closed
    // before returning; `buf` is a stack-allocated buffer of `PATH_MAX` bytes
    // zero-initialized and explicitly NUL-terminated on the last byte.
    let resolved = unsafe {
        let fd = libc::open(
            c_vol.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        );
        if fd < 0 {
            return None;
        }
        let mut buf = [0u8; libc::PATH_MAX as usize];
        let rc = libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr());
        libc::close(fd);
        if rc < 0 {
            return None;
        }
        buf[buf.len() - 1] = 0;
        let cstr = CStr::from_ptr(buf.as_ptr().cast::<libc::c_char>());
        cstr.to_str().ok().map(PathBuf::from)
    }?;
    if !resolved.is_dir() || is_trash_path(&resolved) {
        return None;
    }
    if read_dir_identity(&resolved) == Some(id) {
        Some(resolved)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn resolve_volfs_macos(_id: DirIdentity) -> Option<PathBuf> {
    None
}

#[cfg(windows)]
mod win_impl {
    use super::{
        is_trash_path, strip_win32_extended_prefix, DirIdentity, WinByHandleFileInformation,
        WinFileIdDescriptor, WinFileTime,
    };
    use core::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_NAME_NORMALIZED: u32 = 0x0;
    const VOLUME_NAME_DOS: u32 = 0x0;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: *mut c_void,
        ) -> *mut c_void;
        fn GetFileInformationByHandle(
            h_file: *mut c_void,
            lp_file_information: *mut WinByHandleFileInformation,
        ) -> i32;
        fn OpenFileById(
            h_volume_hint: *mut c_void,
            lp_file_id: *const WinFileIdDescriptor,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut c_void,
            dw_flags_and_attributes: u32,
        ) -> *mut c_void;
        fn GetFinalPathNameByHandleW(
            h_file: *mut c_void,
            lpsz_file_path: *mut u16,
            cch_file_path: u32,
            dw_flags: u32,
        ) -> u32;
        fn GetLogicalDriveStringsW(n_buffer_length: u32, lp_buffer: *mut u16) -> u32;
        fn CloseHandle(h_object: *mut c_void) -> i32;
    }

    struct HandleGuard(*mut c_void);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: `self.0` is an owned valid Win32 HANDLE opened by CreateFileW/OpenFileById.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide_nul(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn open_dir_handle(path: &Path) -> Option<HandleGuard> {
        let wide = to_wide_nul(path);
        // SAFETY: `wide` is NUL-terminated UTF-16; `FILE_FLAG_BACKUP_SEMANTICS` allows opening
        // directory handles with 0 access (metadata-only, non-locking).
        let h = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                core::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                core::ptr::null_mut(),
            )
        };
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(HandleGuard(h))
        }
    }

    fn handle_identity(handle: &HandleGuard) -> Option<(DirIdentity, bool)> {
        let mut info = WinByHandleFileInformation {
            dw_file_attributes: 0,
            ft_creation_time: WinFileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            ft_last_access_time: WinFileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            ft_last_write_time: WinFileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            dw_volume_serial_number: 0,
            n_file_size_high: 0,
            n_file_size_low: 0,
            n_number_of_links: 0,
            n_file_index_high: 0,
            n_file_index_low: 0,
        };
        // SAFETY: `handle.0` is a valid open handle and `info` is stack-allocated and properly aligned.
        let ok = unsafe { GetFileInformationByHandle(handle.0, &mut info) };
        if ok == 0 {
            return None;
        }
        let is_dir = (info.dw_file_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        let ino = ((info.n_file_index_high as u64) << 32) | (info.n_file_index_low as u64);
        Some((
            DirIdentity {
                dev: info.dw_volume_serial_number as u64,
                ino,
            },
            is_dir,
        ))
    }

    pub fn read_dir_identity(path: &Path) -> Option<DirIdentity> {
        let handle = open_dir_handle(path)?;
        let (id, is_dir) = handle_identity(&handle)?;
        is_dir.then_some(id)
    }

    fn volume_roots(old_path: &Path) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        let raw = old_path.to_string_lossy();
        let b = raw.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            roots.push(PathBuf::from(format!("{}:\\", b[0] as char)));
        }
        let mut buf = vec![0u16; 512];
        // SAFETY: `buf` holds `buf.len()` UTF-16 code units; `GetLogicalDriveStringsW` returns
        // the number of code units written (excluding final NUL) or required length.
        let mut len = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) };
        if len as usize >= buf.len() {
            buf.resize(len as usize + 2, 0);
            len = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) };
        }
        if len > 0 && (len as usize) <= buf.len() {
            for slice in buf[..len as usize].split(|&c| c == 0) {
                if slice.is_empty() {
                    continue;
                }
                let s = String::from_utf16_lossy(slice);
                if !roots
                    .iter()
                    .any(|r| r.to_string_lossy().eq_ignore_ascii_case(&s))
                {
                    roots.push(PathBuf::from(s));
                }
            }
        }
        roots
    }

    fn final_path_of_handle(handle: &HandleGuard) -> Option<PathBuf> {
        let mut buf = vec![0u16; 512];
        // SAFETY: `handle.0` is valid and `buf` has capacity `buf.len()`.
        let mut len = unsafe {
            GetFinalPathNameByHandleW(
                handle.0,
                buf.as_mut_ptr(),
                buf.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if len == 0 {
            return None;
        }
        if len as usize >= buf.len() {
            buf.resize(len as usize + 1, 0);
            len = unsafe {
                GetFinalPathNameByHandleW(
                    handle.0,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            };
            if len == 0 || len as usize >= buf.len() {
                return None;
            }
        }
        let s = String::from_utf16(&buf[..len as usize]).ok()?;
        Some(PathBuf::from(strip_win32_extended_prefix(&s)))
    }

    pub fn resolve_file_id_windows(old_path: &Path, id: DirIdentity) -> Option<PathBuf> {
        let desc = WinFileIdDescriptor {
            dw_size: core::mem::size_of::<WinFileIdDescriptor>() as u32,
            id_type: 0, // FileIdType (64-bit FileId)
            file_id: id.ino as i64,
            _pad: [0u8; 8],
        };
        for root in volume_roots(old_path) {
            let Some(vol_handle) = open_dir_handle(&root) else {
                continue;
            };
            let Some((vol_id, _)) = handle_identity(&vol_handle) else {
                continue;
            };
            if vol_id.dev != id.dev {
                continue;
            }
            // SAFETY: `vol_handle.0` is an open handle on the matching volume and `desc`
            // has `dw_size == 24` matching Win32 `FILE_ID_DESCRIPTOR`.
            let target_raw = unsafe {
                OpenFileById(
                    vol_handle.0,
                    &desc,
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    core::ptr::null_mut(),
                    FILE_FLAG_BACKUP_SEMANTICS,
                )
            };
            if target_raw.is_null() || target_raw == INVALID_HANDLE_VALUE {
                continue;
            }
            let target_handle = HandleGuard(target_raw);
            let Some(resolved) = final_path_of_handle(&target_handle) else {
                continue;
            };
            if !resolved.is_dir() || is_trash_path(&resolved) {
                continue;
            }
            if read_dir_identity(&resolved) == Some(id) {
                return Some(resolved);
            }
        }
        None
    }
}

#[cfg(windows)]
fn resolve_file_id_windows(old_path: &Path, id: DirIdentity) -> Option<PathBuf> {
    win_impl::resolve_file_id_windows(old_path, id)
}

#[cfg(not(windows))]
fn resolve_file_id_windows(_old_path: &Path, _id: DirIdentity) -> Option<PathBuf> {
    None
}

fn scan_parent_for_identity(old_path: &Path, id: DirIdentity) -> Option<PathBuf> {
    let parent = old_path.parent()?;
    if !parent.is_dir() {
        return None;
    }
    let parent_dev = read_dir_identity(parent).map(|p| p.dev);
    let entries = std::fs::read_dir(parent).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        let Some(cand_id) = read_dir_identity(&candidate) else {
            continue;
        };
        if is_trash_path(&candidate) {
            continue;
        }
        let exact = cand_id == id;
        // Tolerate mount-id drift across remounts when staying in the same parent dir.
        let same_parent_ino = parent_dev.is_some_and(|d| cand_id.dev == d) && cand_id.ino == id.ino;
        if exact || same_parent_ino {
            return Some(candidate);
        }
    }
    None
}

/// Resolve a missing directory using its stored `(dev, ino)` identity.
/// Returns `None` if it cannot be found, was trashed, or resolves back to the
/// same canonical path.
pub fn resolve_moved_dir(old_path: &Path, id: DirIdentity) -> Option<PathBuf> {
    // Check the original parent first so renames in place keep any user
    // symlink/junction prefix; fall back to macOS volfs (`/.vol`) or Windows
    // `OpenFileById` to track moves anywhere on the volume.
    let found = scan_parent_for_identity(old_path, id)
        .or_else(|| resolve_volfs_macos(id))
        .or_else(|| resolve_file_id_windows(old_path, id))?;
    if !found.is_dir() || is_trash_path(&found) || same_canon(old_path, &found) {
        return None;
    }
    Some(found)
}

/// Rewrite a path prefix on a clean directory boundary (`path == old` or
/// `path` followed by `/` or `\`).
pub fn remap_path_prefix(path: &str, old_prefix: &str, new_prefix: &str) -> Option<String> {
    let p = trim_trailing_seps(path);
    let old = trim_trailing_seps(old_prefix);
    let new = trim_trailing_seps(new_prefix);
    if old.is_empty() || new.is_empty() {
        return None;
    }
    #[cfg(windows)]
    let rest = {
        let p_norm = p.replace('/', "\\").to_ascii_lowercase();
        let old_norm = old.replace('/', "\\").to_ascii_lowercase();
        if p_norm == old_norm {
            return Some(new.to_string());
        }
        p_norm
            .strip_prefix(&old_norm)
            .and_then(|r| p.get(p.len().saturating_sub(r.len())..))
    };
    #[cfg(not(windows))]
    let rest = {
        if p == old {
            return Some(new.to_string());
        }
        p.strip_prefix(old)
    };
    let rest = rest?;
    if rest.starts_with('/') || rest.starts_with('\\') {
        Some(format!("{new}{rest}"))
    } else {
        None
    }
}

/// Mirrors `cwdToMemorySlug` in `memoryFiles.ts` (`--` + trimmed path with `/`
/// and `:` replaced by `-` + `--`).
pub fn cwd_to_memory_slug(cwd: &str) -> String {
    let trimmed = if cwd.len() > 1 {
        cwd.trim_end_matches(['/', '\\'])
    } else {
        cwd
    };
    let no_lead = trimmed.trim_start_matches(['/', '\\']);
    let replaced: String = no_lead
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect();
    format!("--{replaced}--")
}

/// Best-effort rename of OMP project memory folders under `~/.omp/agent/memories/`
/// when a project moves from `old_path` to `new_path` (main dir + worktree slugs).
pub fn migrate_memory_dirs(old_path: &str, new_path: &str) {
    let mem_dir = crate::paths::agent_dir().join("memories");
    migrate_memory_dirs_in(&mem_dir, old_path, new_path);
}

pub(crate) fn migrate_memory_dirs_in(mem_dir: &Path, old_path: &str, new_path: &str) {
    if !mem_dir.is_dir() {
        return;
    }
    let old_slug = cwd_to_memory_slug(old_path);
    let new_slug = cwd_to_memory_slug(new_path);
    if old_slug == new_slug {
        return;
    }
    let old_src = mem_dir.join(&old_slug);
    let new_dst = mem_dir.join(&new_slug);
    if old_src.is_dir() && !new_dst.exists() {
        if let Err(e) = std::fs::rename(&old_src, &new_dst) {
            tracing::warn!(
                "migrate memory dir {} -> {}: {e}",
                old_src.display(),
                new_dst.display()
            );
        }
    }
    let old_inner = old_slug
        .strip_prefix("--")
        .and_then(|s| s.strip_suffix("--"))
        .unwrap_or(&old_slug);
    let new_inner = new_slug
        .strip_prefix("--")
        .and_then(|s| s.strip_suffix("--"))
        .unwrap_or(&new_slug);
    let wt_prefix = format!("--{old_inner}-.worktrees-");
    let cache_wt_prefix = format!("--{old_inner}-.cache-wt-");
    let Ok(entries) = std::fs::read_dir(mem_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let matched = name.starts_with(&wt_prefix) || name.starts_with(&cache_wt_prefix);
        if !matched || !name.ends_with("--") {
            continue;
        }
        let Some(suffix) = name.strip_prefix(&format!("--{old_inner}")) else {
            continue;
        };
        let target_name = format!("--{new_inner}{suffix}");
        let dst = mem_dir.join(target_name);
        if !dst.exists() {
            if let Err(e) = std::fs::rename(entry.path(), &dst) {
                tracing::warn!(
                    "migrate worktree memory {} -> {}: {e}",
                    entry.path().display(),
                    dst.display()
                );
            }
        }
    }
}

/// Best-effort `git worktree repair` after a repository directory is renamed/moved
/// so `.git/worktrees/*/gitdir` and `.worktrees/*/.git` stay valid.
pub fn repair_git_worktrees(new_path: &str) {
    let root = Path::new(new_path);
    if !root.join(".git").exists() {
        return;
    }
    let mut args: Vec<String> = vec!["worktree".into(), "repair".into()];
    let wt_dir = root.join(".worktrees");
    if let Ok(entries) = std::fs::read_dir(&wt_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join(".git").exists() {
                args.push(p.to_string_lossy().into_owned());
            }
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let _ = crate::git::cmd::git_ok(root, &arg_refs);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remap_path_prefix_respects_boundaries() {
        assert_eq!(
            remap_path_prefix("/a/old", "/a/old", "/a/new").as_deref(),
            Some("/a/new")
        );
        assert_eq!(
            remap_path_prefix("/a/old/.worktrees/wt1", "/a/old", "/a/new").as_deref(),
            Some("/a/new/.worktrees/wt1")
        );
        assert_eq!(remap_path_prefix("/a/older", "/a/old", "/a/new"), None);
    }

    #[test]
    fn cwd_to_memory_slug_matches_ts_helper() {
        assert_eq!(
            cwd_to_memory_slug("/Users/me/Documents/omp-workspace"),
            "--Users-me-Documents-omp-workspace--"
        );
        assert_eq!(
            cwd_to_memory_slug("/Users/me/Documents/omp-workspace/.worktrees/bug-fix/"),
            "--Users-me-Documents-omp-workspace-.worktrees-bug-fix--"
        );
    }

    #[test]
    fn resolve_moved_dir_tracks_rename_and_excludes_trash() {
        let base = std::env::temp_dir().join(format!("vecway-fsid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let old_dir = base.join("old-proj");
        let new_dir = base.join("new-proj");
        std::fs::create_dir_all(&old_dir).unwrap();
        let id = read_dir_identity(&old_dir).unwrap();
        std::fs::rename(&old_dir, &new_dir).unwrap();

        let resolved = resolve_moved_dir(&old_dir, id).unwrap();
        assert!(same_canon(&resolved, &new_dir));

        // Trashed folders must never be auto-relocated back into active projects.
        let trash_dir = base.join(".Trash").join("trashed-proj");
        std::fs::create_dir_all(trash_dir.parent().unwrap()).unwrap();
        std::fs::rename(&new_dir, &trash_dir).unwrap();
        assert_eq!(resolve_moved_dir(&old_dir, id), None);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn migrate_memory_dirs_moves_project_and_worktree_only() {
        let base = std::env::temp_dir().join(format!("vecway-mem-{}", uuid::Uuid::new_v4()));
        let mem = base.join("memories");
        let main_old = mem.join("--Users-q-Docs-omp-workspace--");
        let wt_old = mem.join("--Users-q-Docs-omp-workspace-.worktrees-fix--");
        let unrelated = mem.join("--Users-q-Docs-omp-workspace-v2--");
        std::fs::create_dir_all(&main_old).unwrap();
        std::fs::create_dir_all(&wt_old).unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();

        migrate_memory_dirs_in(&mem, "/Users/q/Docs/omp-workspace", "/Users/q/Docs/Vecway");

        assert!(!main_old.exists());
        assert!(mem.join("--Users-q-Docs-Vecway--").is_dir());
        assert!(!wt_old.exists());
        assert!(mem.join("--Users-q-Docs-Vecway-.worktrees-fix--").is_dir());
        assert!(unrelated.is_dir());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn windows_abi_and_path_helpers_match_spec() {
        assert_eq!(core::mem::size_of::<WinFileIdDescriptor>(), 24);
        assert_eq!(core::mem::size_of::<WinByHandleFileInformation>(), 52);
        assert_eq!(
            strip_win32_extended_prefix(r"\\?\C:\Users\me\Vecway"),
            r"C:\Users\me\Vecway"
        );
        assert_eq!(
            strip_win32_extended_prefix(r"\\?\UNC\server\share\Vecway"),
            r"\\server\share\Vecway"
        );
        assert!(is_trash_path(Path::new(r"C:\$Recycle.Bin\S-1-5-21\Vecway")));
        assert_eq!(
            remap_path_prefix(
                r"C:\Users\me\omp-workspace\.worktrees\fix",
                r"C:\Users\me\omp-workspace\",
                r"C:\Users\me\Vecway\",
            )
            .as_deref(),
            Some(r"C:\Users\me\Vecway\.worktrees\fix")
        );
    }
}
