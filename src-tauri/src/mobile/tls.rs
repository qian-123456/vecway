//! Self-signed TLS certificate generation, persistence, and Rustls server config.

use parking_lot::Mutex;
use rcgen::generate_simple_self_signed;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[derive(Clone)]
pub struct TlsIdentity {
    pub server_config: Arc<rustls::ServerConfig>,
    pub cert_sha256: String,
}

#[derive(Serialize, Deserialize)]
struct CertMetadata {
    sans: Vec<String>,
    fingerprint: String,
}

static IDENTITY: Mutex<Option<(PathBuf, Option<String>, TlsIdentity)>> = Mutex::new(None);
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn tls_dir() -> PathBuf {
    crate::paths::data_dir().join("mobile-tls")
}

#[cfg(unix)]
fn set_key_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("设置私钥文件权限失败: {e}"))
}

#[cfg(not(unix))]
fn set_key_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Create the TLS directory with mode 0700; also re-enforced when it already
/// exists (e.g. created by an older version with default permissions).
fn ensure_tls_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        if dir.is_dir() {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("设置 TLS 证书目录权限失败: {e}"))?;
        } else {
            if let Some(parent) = dir.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建 TLS 证书目录失败: {e}"))?;
            }
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(dir)
                .map_err(|e| format!("创建 TLS 证书目录失败: {e}"))?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir).map_err(|e| format!("创建 TLS 证书目录失败: {e}"))
}

/// Create a unique temp file in `dir`, write `bytes`, fsync, and return its path.
/// When `private_0600` is true, Unix mode `0600` is enforced at file creation so
/// secret material is never world-readable even briefly.
fn stage_temp_file(
    dir: &Path,
    stem: &str,
    bytes: &[u8],
    private_0600: bool,
    err_prefix: &str,
) -> Result<PathBuf, String> {
    let pid = std::process::id();
    for _ in 0..16 {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp_path = dir.join(format!(".{stem}.{pid}-{seq}.tmp"));
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        if private_0600 {
            use std::os::unix::fs::OpenOptionsExt as _;
            opts.mode(0o600);
        }
        match opts.open(&tmp_path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    let _ = fs::remove_file(&tmp_path);
                    return Err(format!("{err_prefix}: {e}"));
                }
                return Ok(tmp_path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{err_prefix}: {e}")),
        }
    }
    Err(format!("{err_prefix}: 无法创建唯一临时文件"))
}

/// Persist `cert.der`, `key.der` (mode 0600 on Unix), and `meta.json` atomically
/// into `dir`: all three temp files are written and synced first before renaming
/// into place, with `meta.json` renamed last so interrupted writes never leave a
/// partially updated identity that passes metadata checks.
fn persist_identity_files(
    dir: &Path,
    sans: &[String],
    cert_der: &[u8],
    key_der: &[u8],
    fingerprint: &str,
) -> Result<(), String> {
    let meta = CertMetadata {
        sans: sans.to_vec(),
        fingerprint: fingerprint.to_string(),
    };
    let meta_json =
        serde_json::to_vec_pretty(&meta).map_err(|e| format!("序列化 TLS 元数据失败: {e}"))?;

    let cert_tmp = stage_temp_file(dir, "cert.der", cert_der, false, "保存 TLS 证书失败")?;
    let key_tmp = match stage_temp_file(dir, "key.der", key_der, true, "保存 TLS 私钥失败") {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_file(&cert_tmp);
            return Err(e);
        }
    };
    let meta_tmp = match stage_temp_file(dir, "meta.json", &meta_json, false, "保存 TLS 元数据失败")
    {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_file(&cert_tmp);
            let _ = fs::remove_file(&key_tmp);
            return Err(e);
        }
    };

    if let Err(e) = fs::rename(&cert_tmp, dir.join("cert.der")) {
        let _ = fs::remove_file(&cert_tmp);
        let _ = fs::remove_file(&key_tmp);
        let _ = fs::remove_file(&meta_tmp);
        return Err(format!("保存 TLS 证书失败: {e}"));
    }
    if let Err(e) = fs::rename(&key_tmp, dir.join("key.der")) {
        let _ = fs::remove_file(&key_tmp);
        let _ = fs::remove_file(&meta_tmp);
        return Err(format!("保存 TLS 私钥失败: {e}"));
    }
    if let Err(e) = fs::rename(&meta_tmp, dir.join("meta.json")) {
        let _ = fs::remove_file(&meta_tmp);
        return Err(format!("保存 TLS 元数据失败: {e}"));
    }
    Ok(())
}

pub(crate) fn compute_fingerprint(der: &[u8]) -> String {
    let hash = Sha256::digest(der);
    hash.iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Compute SANs that must be present in the certificate.
fn required_sans(ddns_hostname: Option<&str>) -> Vec<String> {
    let mut sans = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    if let Some(host) = ddns_hostname {
        let trimmed = host.trim();
        if !trimmed.is_empty() && !sans.iter().any(|s| s.eq_ignore_ascii_case(trimmed)) {
            sans.push(trimmed.to_string());
        }
    }
    sans
}

fn is_covered(existing_sans: &[String], required: &[String]) -> bool {
    required.iter().all(|req| {
        existing_sans
            .iter()
            .any(|ext| ext.eq_ignore_ascii_case(req))
    })
}

/// Generate new self-signed certificate and persist atomically to disk with the key at 0600.
fn generate_and_persist_in(dir: &Path, sans: &[String]) -> Result<TlsIdentity, String> {
    ensure_tls_dir(dir)?;
    let cert_key = generate_simple_self_signed(sans.to_vec())
        .map_err(|e| format!("生成自签名证书失败: {e}"))?;

    let cert_der = cert_key.cert.der().to_vec();
    let key_der = cert_key.key_pair.serialize_der();
    let fingerprint = compute_fingerprint(&cert_der);

    persist_identity_files(dir, sans, &cert_der, &key_der, &fingerprint)?;

    build_identity(cert_der, key_der, fingerprint)
}

fn build_identity(
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
    fingerprint: String,
) -> Result<TlsIdentity, String> {
    let cert = CertificateDer::from(cert_der);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der));

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut server_config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 协议版本配置失败: {e}"))?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .map_err(|e| format!("TLS 证书加载失败: {e}"))?;
    server_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(TlsIdentity {
        server_config: Arc::new(server_config),
        cert_sha256: fingerprint,
    })
}

/// Ensure a self-signed certificate exists in `dir` that covers `localhost` and
/// `ddns_hostname` (if set). Regenerates atomically if the configured hostname is not covered.
pub(crate) fn ensure_tls_identity_in(
    dir: &Path,
    ddns_hostname: Option<&str>,
) -> Result<TlsIdentity, String> {
    ensure_tls_dir(dir)?;

    let cert_path = dir.join("cert.der");
    let key_path = dir.join("key.der");
    let meta_path = dir.join("meta.json");
    let needed_sans = required_sans(ddns_hostname);

    if cert_path.exists() && key_path.exists() && meta_path.exists() {
        if let Ok(meta_bytes) = fs::read(&meta_path) {
            if let Ok(meta) = serde_json::from_slice::<CertMetadata>(&meta_bytes) {
                if is_covered(&meta.sans, &needed_sans) {
                    if let (Ok(cert_der), Ok(key_der)) = (fs::read(&cert_path), fs::read(&key_path))
                    {
                        // Re-enforce 0600: an earlier failed chmod must not
                        // leave the key readable.
                        set_key_mode(&key_path)?;
                        let fp = compute_fingerprint(&cert_der);
                        if fp == meta.fingerprint {
                            if let Ok(ident) = build_identity(cert_der, key_der, fp) {
                                return Ok(ident);
                            }
                        }
                    }
                }
            }
        }
    }

    generate_and_persist_in(dir, &needed_sans)
}

/// Ensure a self-signed certificate exists that covers `localhost` and `ddns_hostname` (if set).
/// Regenerates if the configured hostname is not covered.
pub fn ensure_tls_identity(ddns_hostname: Option<&str>) -> Result<TlsIdentity, String> {
    let host_norm = ddns_hostname
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_string);

    let dir = tls_dir();
    let mut guard = IDENTITY.lock();
    if let Some((cached_dir, cached_host, ident)) = guard.as_ref() {
        if *cached_dir == dir && *cached_host == host_norm {
            return Ok(ident.clone());
        }
    }

    let ident = ensure_tls_identity_in(&dir, ddns_hostname)?;
    *guard = Some((dir, host_norm, ident.clone()));
    Ok(ident)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_identity_files_writes_atomically_with_0600_key_and_no_leftover_temps() {
        let dir = std::env::temp_dir().join(format!("omp-tls-test-{}", uuid::Uuid::new_v4()));
        ensure_tls_dir(&dir).unwrap();
        let sans = required_sans(Some("home.example.com"));
        let cert_key = generate_simple_self_signed(sans.clone()).unwrap();
        let cert_der = cert_key.cert.der().to_vec();
        let key_der = cert_key.key_pair.serialize_der();
        let fp = compute_fingerprint(&cert_der);

        persist_identity_files(&dir, &sans, &cert_der, &key_der, &fp).unwrap();

        assert_eq!(fs::read(dir.join("cert.der")).unwrap(), cert_der);
        assert_eq!(fs::read(dir.join("key.der")).unwrap(), key_der);
        let meta: CertMetadata =
            serde_json::from_slice(&fs::read(dir.join("meta.json")).unwrap()).unwrap();
        assert_eq!(meta.fingerprint, fp);
        assert!(is_covered(&meta.sans, &sans));
        build_identity(cert_der, key_der, fp).unwrap();

        let leftover_tmps = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .ok()
                    .is_some_and(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            })
            .count();
        assert_eq!(leftover_tmps, 0);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let key_mode = fs::metadata(dir.join("key.der"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let dir_mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(key_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn required_sans_keeps_stable_loopback_and_optional_ddns_without_lan_ipv4() {
        assert_eq!(required_sans(None), vec!["localhost", "127.0.0.1", "::1"]);
        assert_eq!(
            required_sans(Some("  ")),
            vec!["localhost", "127.0.0.1", "::1"]
        );
        assert_eq!(
            required_sans(Some(" home.example.com ")),
            vec!["localhost", "127.0.0.1", "::1", "home.example.com"]
        );
        assert_eq!(
            required_sans(Some("LOCALHOST")),
            vec!["localhost", "127.0.0.1", "::1"]
        );
    }

    #[test]
    fn ensure_tls_identity_in_reuses_persisted_cert_and_regenerates_for_new_ddns() {
        let dir = std::env::temp_dir().join(format!("omp-tls-reuse-{}", uuid::Uuid::new_v4()));
        let first = ensure_tls_identity_in(&dir, None).unwrap();
        assert_eq!(first.cert_sha256.len(), 95);
        assert_eq!(first.cert_sha256.split(':').count(), 32);
        assert!(first.cert_sha256.split(':').all(|part| {
            part.len() == 2
                && part
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        }));

        let second = ensure_tls_identity_in(&dir, None).unwrap();
        assert_eq!(second.cert_sha256, first.cert_sha256);

        // Adding a DDNS hostname regenerates the identity to cover it.
        let third = ensure_tls_identity_in(&dir, Some("ddns.example.com")).unwrap();
        assert_ne!(third.cert_sha256, first.cert_sha256);

        // Subsequent LAN-only call reuses the DDNS-covering certificate (single shared identity).
        let fourth = ensure_tls_identity_in(&dir, None).unwrap();
        assert_eq!(fourth.cert_sha256, third.cert_sha256);

        let _ = fs::remove_dir_all(&dir);
    }
}
