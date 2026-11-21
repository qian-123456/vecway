//! [E] LAN HTTP server, pairing, QR, SSE, cloudflared tunnel, IPv6 HTTPS.

pub mod api;
pub mod assets;
pub mod auth;
pub mod backend;
pub mod camera;
pub mod commands;
pub mod ddns;
pub mod ipv6;
pub mod last;
pub mod push;
pub mod server;
pub mod tls;
pub mod tunnel;
pub(crate) mod work;

use std::sync::Arc;

use base64::Engine as _;
use parking_lot::Mutex;
use tokio::sync::{oneshot, watch};

use crate::contracts::{MobileStatus, PairingInfo, PairingTarget};
use crate::state::AppState;

struct Running {
    port: u16,
    shutdown: watch::Sender<bool>,
    unbound: Option<oneshot::Receiver<()>>,
}

struct TlsRunning {
    port: u16,
    shutdown: watch::Sender<bool>,
    /// Fingerprint of the certificate this listener is actually serving.
    cert_sha256: String,
    /// Hostname covered when this listener's certificate was loaded.
    cert_hostname: Option<String>,
    unbound: Option<oneshot::Receiver<()>>,
}

static SERVER: Mutex<Option<Running>> = Mutex::new(None);
static LAN_TLS_SERVER: Mutex<Option<TlsRunning>> = Mutex::new(None);
static IPV6_SERVER: Mutex<Option<TlsRunning>> = Mutex::new(None);
static LIFECYCLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn await_unbind(rx: Option<oneshot::Receiver<()>>) {
    if let Some(rx) = rx {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), rx).await;
    }
}
pub(super) fn tunnel_origin() -> Result<(u16, watch::Receiver<bool>), String> {
    SERVER
        .lock()
        .as_ref()
        .map(|r| (r.port, r.shutdown.subscribe()))
        .ok_or_else(|| "手机服务已停止".into())
}

fn covered_ddns_host<'a>(advertised: Option<&'a str>, served: Option<&str>) -> Option<&'a str> {
    advertised.filter(|host| {
        served.is_some_and(|cert_host| cert_host.trim().eq_ignore_ascii_case(host.trim()))
    })
}

/// Autostart when settings.mobile_enabled (and settings.mobile_ipv6_enabled).
/// Skips all startup work (including DDNS background loop) when mobile is disabled.
pub fn init(state: AppState) {
    let (mobile_enabled, ipv6_enabled) = {
        let s = state.settings.read();
        (s.mobile_enabled, s.mobile_ipv6_enabled)
    };

    if !mobile_enabled {
        return;
    }

    let state_clone = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start(&state_clone).await {
            tracing::warn!("mobile autostart failed: {e}");
            return;
        }
        if ipv6_enabled {
            if let Err(e) = ipv6_start(&state_clone).await {
                tracing::warn!("mobile ipv6 autostart failed: {e}");
            }
        }
    });
}

fn lan_ip() -> String {
    match local_ip_address::local_ip() {
        Ok(ip) if ip.is_ipv4() => ip.to_string(),
        _ => "127.0.0.1".to_string(),
    }
}

pub fn status(state: &AppState) -> MobileStatus {
    let port = SERVER.lock().as_ref().map(|r| r.port);
    let (configured_lan_tls_port, configured_ipv6_port) = {
        let s = state.settings.read();
        (s.mobile_lan_tls_port, s.mobile_ipv6_port)
    };
    let (lan_tls_running, lan_tls_port, lan_cert_sha256) = {
        let lan_tls = LAN_TLS_SERVER.lock();
        (
            lan_tls.is_some(),
            lan_tls
                .as_ref()
                .map(|r| r.port)
                .unwrap_or(configured_lan_tls_port),
            lan_tls.as_ref().map(|r| r.cert_sha256.clone()),
        )
    };
    let (ipv6_running, ipv6_port, ipv6_cert_sha256, cert_hostname) = {
        let ipv6 = IPV6_SERVER.lock();
        (
            ipv6.is_some(),
            ipv6.as_ref()
                .map(|r| r.port)
                .unwrap_or(configured_ipv6_port),
            // Fingerprint of the cert being served; never regenerated here.
            ipv6.as_ref().map(|r| r.cert_sha256.clone()),
            ipv6.as_ref().and_then(|r| r.cert_hostname.clone()),
        )
    };
    let cert_sha256 = lan_cert_sha256.or(ipv6_cert_sha256);
    let current_v6 = ipv6::current_address();
    let ddns_st = ddns::status(state);
    let ip = (port.is_some() || lan_tls_running).then(lan_ip);
    let lan_url = port
        .zip(ip.as_deref())
        .map(|(p, ip)| format!("http://{ip}:{p}"));
    let lan_tls_url = if lan_tls_running {
        ip.as_deref()
            .map(|ip| format!("https://{ip}:{lan_tls_port}"))
    } else {
        None
    };

    let ipv6_url = if ipv6_running {
        current_v6.map(|addr| {
            let addr_str = addr.to_string();
            let ddns_synced = ddns_st.enabled
                && ddns_st.last_ip.as_deref() == Some(&addr_str)
                && covered_ddns_host(ddns_st.hostname.as_deref(), cert_hostname.as_deref())
                    .is_some();
            if ddns_synced {
                let host = ddns_st.hostname.as_deref().unwrap_or(&addr_str);
                format!("https://{host}:{ipv6_port}")
            } else {
                format!("https://[{addr_str}]:{ipv6_port}")
            }
        })
    } else {
        None
    };

    MobileStatus {
        running: port.is_some(),
        port: port.unwrap_or(0),
        lan_url,
        lan_tls_running,
        lan_tls_port,
        lan_tls_url,
        tunnel_url: tunnel::url(),
        cloudflared_installed: tunnel::installed(),
        cloudflared_logged_in: tunnel::logged_in(),
        ipv6_running,
        ipv6_port,
        ipv6_address: current_v6.map(|a| a.to_string()),
        ipv6_url,
        cert_sha256,
        ddns: ddns_st,
    }
}

/// Persist the autostart flag through the shared settings writer (no lock held
/// across the await; errors are logged, never fatal to server start/stop).
async fn persist_enabled(state: &AppState, enabled: bool) {
    if state.settings.read().mobile_enabled == enabled {
        return;
    }
    if let Err(e) = crate::settings::set_mobile_enabled(state, enabled).await {
        tracing::warn!("persist mobile_enabled={enabled}: {e}");
    }
}

async fn persist_ipv6_enabled(state: &AppState, enabled: bool) {
    if state.settings.read().mobile_ipv6_enabled == enabled {
        return;
    }
    if let Err(e) = crate::settings::set_mobile_ipv6_enabled(state, enabled).await {
        tracing::warn!("persist mobile_ipv6_enabled={enabled}: {e}");
    }
}

async fn start_internal(state: &AppState) -> Result<(), String> {
    let need_http = SERVER.lock().is_none();
    let need_lan_tls = LAN_TLS_SERVER.lock().is_none();
    if !need_http && !need_lan_tls {
        return Ok(());
    }
    let (port, lan_tls_port, ddns_host) = {
        let s = state.settings.read();
        (
            s.mobile_port,
            s.mobile_lan_tls_port,
            s.ddns_hostname.clone(),
        )
    };
    let http_listener = if need_http {
        Some(
            tokio::net::TcpListener::bind(("0.0.0.0", port))
                .await
                .map_err(|e| format!("无法监听端口 {port}（可能被占用）: {e}"))?,
        )
    } else {
        None
    };
    let tls_ready = if need_lan_tls {
        let ident = tls::ensure_tls_identity(ddns_host.as_deref())?;
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", lan_tls_port))
            .await
            .map_err(|e| format!("无法监听局域网 TLS 端口 {lan_tls_port}（可能被占用）: {e}"))?;
        Some((ident, listener))
    } else {
        None
    };

    if let Some(listener) = http_listener {
        let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
        let (tx, rx) = watch::channel(false);
        let (unbind_tx, unbind_rx) = oneshot::channel();
        *SERVER.lock() = Some(Running {
            port: bound_port,
            shutdown: tx,
            unbound: Some(unbind_rx),
        });
        let ctx = Arc::new(server::Ctx {
            backend: backend::AppBackend(state.clone()),
            db: state.db.clone(),
            shutdown: rx,
        });
        let push_shutdown = ctx.shutdown.clone();
        tokio::spawn(server::serve_notifying(listener, ctx, Some(unbind_tx)));
        tokio::spawn(push::run(state.clone(), push_shutdown));
    }

    if let Some((ident, listener)) = tls_ready {
        let bound_port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(lan_tls_port);
        let (tx, rx) = watch::channel(false);
        let (unbind_tx, unbind_rx) = oneshot::channel();
        *LAN_TLS_SERVER.lock() = Some(TlsRunning {
            port: bound_port,
            shutdown: tx,
            cert_sha256: ident.cert_sha256.clone(),
            cert_hostname: ddns_host,
            unbound: Some(unbind_rx),
        });
        let ctx = Arc::new(server::Ctx {
            backend: backend::AppBackend(state.clone()),
            db: state.db.clone(),
            shutdown: rx,
        });
        let acceptor = tokio_rustls::TlsAcceptor::from(ident.server_config);
        tokio::spawn(server::serve_tls_notifying(
            listener,
            acceptor,
            ctx,
            Some(unbind_tx),
        ));
    }

    persist_enabled(state, true).await;
    Ok(())
}

async fn reload_lan_tls(
    state: &AppState,
    ident: &tls::TlsIdentity,
    ddns_host: Option<String>,
) -> Result<(), String> {
    let old = {
        let mut guard = LAN_TLS_SERVER.lock();
        match guard.as_ref() {
            Some(r) if r.cert_sha256 != ident.cert_sha256 => guard.take(),
            _ => return Ok(()),
        }
    };
    let Some(mut old) = old else {
        return Ok(());
    };
    let port = old.port;
    let _ = old.shutdown.send(true);
    await_unbind(old.unbound.take()).await;

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("无法重新监听局域网 TLS 端口 {port}（可能被占用）: {e}"))?;
    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let (tx, rx) = watch::channel(false);
    let (unbind_tx, unbind_rx) = oneshot::channel();
    *LAN_TLS_SERVER.lock() = Some(TlsRunning {
        port: bound_port,
        shutdown: tx,
        cert_sha256: ident.cert_sha256.clone(),
        cert_hostname: ddns_host,
        unbound: Some(unbind_rx),
    });
    let ctx = Arc::new(server::Ctx {
        backend: backend::AppBackend(state.clone()),
        db: state.db.clone(),
        shutdown: rx,
    });
    let acceptor = tokio_rustls::TlsAcceptor::from(ident.server_config.clone());
    tokio::spawn(server::serve_tls_notifying(
        listener,
        acceptor,
        ctx,
        Some(unbind_tx),
    ));
    Ok(())
}

pub async fn start(state: &AppState) -> Result<MobileStatus, String> {
    let _guard = LIFECYCLE_LOCK.lock().await;
    if SERVER.lock().is_none() || LAN_TLS_SERVER.lock().is_none() {
        start_internal(state).await?;
    }
    Ok(status(state))
}

pub async fn stop(state: &AppState) {
    let _guard = LIFECYCLE_LOCK.lock().await;
    tunnel::stop();
    let ipv6 = IPV6_SERVER.lock().take();
    let lan_tls = LAN_TLS_SERVER.lock().take();
    let http = SERVER.lock().take();
    if let Some(mut r) = ipv6 {
        let _ = r.shutdown.send(true);
        await_unbind(r.unbound.take()).await;
    }
    if let Some(mut r) = lan_tls {
        let _ = r.shutdown.send(true);
        await_unbind(r.unbound.take()).await;
    }
    if let Some(mut r) = http {
        let _ = r.shutdown.send(true);
        await_unbind(r.unbound.take()).await;
    }
    persist_enabled(state, false).await;
    persist_ipv6_enabled(state, false).await;
}

pub async fn ipv6_start(state: &AppState) -> Result<MobileStatus, String> {
    let _guard = LIFECYCLE_LOCK.lock().await;

    // Ensures the main mobile HTTP + LAN TLS servers are running
    if SERVER.lock().is_none() || LAN_TLS_SERVER.lock().is_none() {
        start_internal(state).await?;
    }

    if IPV6_SERVER.lock().is_some() {
        persist_ipv6_enabled(state, true).await;
        return Ok(status(state));
    }

    let port = state.settings.read().mobile_ipv6_port;

    // Bind [::]:<port> with IPV6_V6ONLY=true
    let domain = socket2::Domain::IPV6;
    let socket = socket2::Socket::new(domain, socket2::Type::STREAM, Some(socket2::Protocol::TCP))
        .map_err(|e| format!("创建 IPv6 套接字失败: {e}"))?;
    socket
        .set_only_v6(true)
        .map_err(|e| format!("设置 IPV6_V6ONLY 失败: {e}"))?;
    socket.set_reuse_address(true).ok();
    socket
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {e}"))?;

    let addr: std::net::SocketAddr = (std::net::Ipv6Addr::UNSPECIFIED, port).into();
    socket
        .bind(&addr.into())
        .map_err(|e| format!("无法监听端口 {port}（可能被占用）: {e}"))?;
    socket
        .listen(1024)
        .map_err(|e| format!("无法监听端口 {port}（可能被占用）: {e}"))?;

    let std_listener: std::net::TcpListener = socket.into();
    let listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|e| format!("无法监听端口 {port}（可能被占用）: {e}"))?;
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);

    let ddns_host = state.settings.read().ddns_hostname.clone();
    let ident = tls::ensure_tls_identity(ddns_host.as_deref())?;
    // Keep LAN TLS and IPv6 TLS serving the exact same certificate & fingerprint.
    reload_lan_tls(state, &ident, ddns_host.clone()).await?;
    let acceptor = tokio_rustls::TlsAcceptor::from(ident.server_config);
    let cert_sha256 = ident.cert_sha256.clone();

    let (tx, rx) = watch::channel(false);
    let (unbind_tx, unbind_rx) = oneshot::channel();
    *IPV6_SERVER.lock() = Some(TlsRunning {
        port,
        shutdown: tx,
        cert_sha256,
        cert_hostname: ddns_host,
        unbound: Some(unbind_rx),
    });

    let ctx = Arc::new(server::Ctx {
        backend: backend::AppBackend(state.clone()),
        db: state.db.clone(),
        shutdown: rx,
    });
    tokio::spawn(server::serve_tls_notifying(
        listener,
        acceptor,
        ctx,
        Some(unbind_tx),
    ));

    ddns::init(state.clone());
    persist_ipv6_enabled(state, true).await;
    Ok(status(state))
}

pub async fn ipv6_stop(state: &AppState) {
    let _guard = LIFECYCLE_LOCK.lock().await;
    let ipv6 = IPV6_SERVER.lock().take();
    if let Some(mut r) = ipv6 {
        let _ = r.shutdown.send(true);
        await_unbind(r.unbound.take()).await;
    }
    persist_ipv6_enabled(state, false).await;
}

/// SVG QR code for `text` (light background so phones scan it reliably).
pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| format!("生成二维码失败: {e}"))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build())
}

fn percent_encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

fn https_only(url: Option<&str>) -> Option<&str> {
    url.map(str::trim).filter(|u| u.starts_with("https://"))
}

#[derive(serde::Serialize)]
struct AppPairingPayload<'a> {
    v: u8,
    t: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    lt: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fp: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    v6: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tn: Option<&'a str>,
}

/// Build the dual-use web/App pairing URL (`<base>/pair?code=...#app=...`) and
/// optional App-direct deep link (`vecway://pair?...`). Only `https://` channels
/// are ever included in the App payload.
pub(crate) fn build_pairing_urls(
    base: &str,
    code: &str,
    target: PairingTarget,
    lan_tls_url: Option<&str>,
    cert_sha256: Option<&str>,
    ipv6_url: Option<&str>,
    tunnel_url: Option<&str>,
) -> (String, Option<String>) {
    let web_url = format!("{}/pair?code={code}", base.trim_end_matches('/'));
    let lt = https_only(lan_tls_url);
    let v6 = https_only(ipv6_url);
    let tn = https_only(tunnel_url);
    if lt.is_none() && v6.is_none() && tn.is_none() {
        return (web_url, None);
    }
    let fp = cert_sha256.map(str::trim).filter(|s| !s.is_empty());
    let t = match target {
        PairingTarget::Lan => "lan",
        PairingTarget::Ipv6 => "ipv6",
        PairingTarget::Tunnel => "tunnel",
    };
    let payload = AppPairingPayload {
        v: 1,
        t,
        lt,
        fp,
        v6,
        tn,
    };
    let encoded = serde_json::to_vec(&payload)
        .map(|bytes| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
        .unwrap_or_default();
    let dual_url = if encoded.is_empty() {
        web_url
    } else {
        format!("{web_url}#app={encoded}")
    };

    let mut app_url = format!(
        "vecway://pair?v=1&code={}&t={t}",
        percent_encode_query_value(code)
    );
    if let Some(u) = lt {
        app_url.push_str("&lt=");
        app_url.push_str(&percent_encode_query_value(u));
    }
    if let Some(f) = fp {
        app_url.push_str("&fp=");
        app_url.push_str(&percent_encode_query_value(f));
    }
    if let Some(u) = v6 {
        app_url.push_str("&v6=");
        app_url.push_str(&percent_encode_query_value(u));
    }
    if let Some(u) = tn {
        app_url.push_str("&tn=");
        app_url.push_str(&percent_encode_query_value(u));
    }
    (dual_url, Some(app_url))
}

/// New one-time pairing link for the selected target (`lan`, `tunnel`, or `ipv6`).
pub async fn create_pairing(
    state: &AppState,
    target: PairingTarget,
) -> Result<PairingInfo, String> {
    let st = start(state).await?;
    let base = match target {
        PairingTarget::Lan => st.lan_url.clone().ok_or("服务未启动")?,
        PairingTarget::Tunnel => st.tunnel_url.clone().ok_or("隧道未启动")?,
        PairingTarget::Ipv6 => st
            .ipv6_url
            .clone()
            .ok_or_else(|| "IPv6 直连不可用（未启动或无公网 IPv6 地址）".to_string())?,
    };
    let (code, expires_at) = auth::create_pairing(&state.db.lock(), chrono::Utc::now())
        .map_err(|e| format!("创建配对码失败: {e}"))?;
    let (url, app_url) = build_pairing_urls(
        &base,
        &code,
        target,
        st.lan_tls_url.as_deref(),
        st.cert_sha256.as_deref(),
        st.ipv6_url.as_deref(),
        st.tunnel_url.as_deref(),
    );
    let app_qr_svg = match app_url.as_deref() {
        Some(u) => Some(qr_svg(u)?),
        None => None,
    };
    Ok(PairingInfo {
        qr_svg: qr_svg(&url)?,
        url,
        expires_at,
        cert_sha256: st.cert_sha256,
        app_url,
        app_qr_svg,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod infra_tests {
    use super::*;

    #[test]
    fn changed_ddns_hostname_is_not_advertised_under_old_certificate() {
        assert_eq!(
            covered_ddns_host(Some("old.example"), Some("old.example")),
            Some("old.example")
        );
        assert_eq!(
            covered_ddns_host(Some("new.example"), Some("old.example")),
            None
        );
        assert_eq!(covered_ddns_host(Some("new.example"), None), None);
        // Only a new listener with the new certificate may advertise this name.
        assert_eq!(
            covered_ddns_host(Some("new.example"), Some("new.example")),
            Some("new.example")
        );
        assert_eq!(
            covered_ddns_host(Some("OLD.example"), Some(" old.example ")),
            Some("OLD.example")
        );
    }
}
