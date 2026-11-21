//! Pairing codes (one-time, 5 min) and device tokens (stored as sha256 hashes).

use crate::contracts::MobileDevice;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Instant;
use tokio::sync::broadcast;

/// Minimum interval between SQLite `last_seen_at` writes for the same device.
const LAST_SEEN_THROTTLE: std::time::Duration = std::time::Duration::from_secs(60);

static LAST_SEEN_WRITTEN: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static REVOCATIONS: LazyLock<broadcast::Sender<String>> =
    LazyLock::new(|| broadcast::channel(256).0);
pub fn subscribe_revocations() -> broadcast::Receiver<String> {
    REVOCATIONS.subscribe()
}

pub fn notify_revoked(token_hash: &str) {
    LAST_SEEN_WRITTEN.lock().remove(token_hash);
    super::push::clear_presence(token_hash);
    let _ = REVOCATIONS.send(token_hash.to_owned());
}

pub fn device_id_for_token(conn: &Connection, token: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM mobile_devices WHERE token_hash = ?1",
        [hash_token(token)],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn device_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MobileDevice> {
    let mut name: String = row.get(1)?;
    let user_agent: Option<String> = row.get(2)?;
    let agent = user_agent.as_deref().unwrap_or_default();
    if name.trim().is_empty() || (name == agent && agent.starts_with("Mozilla/")) {
        name = default_device_name(agent).to_owned();
    }
    Ok(MobileDevice {
        id: row.get(0)?,
        name,
        user_agent,
        created_at: row.get(3)?,
        last_seen_at: row.get(4)?,
    })
}

pub fn device_for_token(conn: &Connection, token: &str) -> rusqlite::Result<Option<MobileDevice>> {
    conn.query_row(
        "SELECT id, COALESCE(name, ''), user_agent, created_at, last_seen_at FROM mobile_devices WHERE token_hash = ?1",
        [hash_token(token)],
        device_from_row,
    ).optional()
}

pub fn list_devices(conn: &Connection) -> rusqlite::Result<Vec<MobileDevice>> {
    let mut stmt = conn.prepare("SELECT id, COALESCE(name, ''), user_agent, created_at, last_seen_at FROM mobile_devices ORDER BY created_at, id")?;
    let rows = stmt.query_map([], device_from_row)?;
    rows.collect()
}

/// A browser/platform hint, not a claim about the physical device model.
pub fn default_device_name(user_agent: &str) -> &'static str {
    let contains = |pattern: &[u8]| {
        user_agent
            .as_bytes()
            .windows(pattern.len())
            .any(|part| part.eq_ignore_ascii_case(pattern))
    };
    if contains(b"iphone") {
        "iPhone"
    } else if contains(b"ipad") {
        "iPad"
    } else if contains(b"ipod") {
        "iPod"
    } else if contains(b"android") {
        "Android"
    } else {
        "浏览器"
    }
}

pub fn rename_device(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<bool> {
    let name = name.trim();
    let fallback;
    let name = if name.is_empty() {
        let agent: Option<Option<String>> = conn
            .query_row(
                "SELECT user_agent FROM mobile_devices WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(agent) = agent else {
            return Ok(false);
        };
        fallback = default_device_name(agent.as_deref().unwrap_or_default());
        fallback
    } else {
        name
    };
    let name: String = name.chars().take(120).collect();
    conn.execute(
        "UPDATE mobile_devices SET name = ?2 WHERE id = ?1",
        params![id, name],
    )
    .map(|n| n > 0)
}

pub fn revoke_device(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    let tx = conn.unchecked_transaction()?;
    let hash: Option<String> = tx
        .query_row(
            "SELECT token_hash FROM mobile_devices WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(hash) = &hash {
        tx.execute(
            "DELETE FROM push_subscriptions WHERE token_hash = ?1",
            [hash],
        )?;
        tx.execute("DELETE FROM mobile_devices WHERE token_hash = ?1", [hash])?;
    }
    tx.commit()?;
    Ok(hash)
}

pub fn revoke_all_devices(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let tx = conn.unchecked_transaction()?;
    let devices = {
        let mut stmt = tx.prepare("SELECT id, token_hash FROM mobile_devices")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<(String, String)>>>()?
    };
    tx.execute_batch(
        "DELETE FROM push_subscriptions; DELETE FROM mobile_devices; DELETE FROM pairing_codes;",
    )?;
    tx.commit()?;
    Ok(devices)
}

pub fn set_user_agent(conn: &Connection, token: &str, user_agent: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE mobile_devices SET user_agent = ?2 WHERE token_hash = ?1",
        params![hash_token(token), user_agent],
    )?;
    Ok(())
}

pub const COOKIE: &str = "ompws_token";
pub const PAIRING_TTL_MINUTES: i64 = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token(pub String);

/// 32 random bytes, base64url without padding.
pub fn random_secret() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Create a pairing code; returns (code, expires_at RFC3339). Purges stale codes.
pub fn create_pairing(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<(String, String)> {
    conn.execute(
        "DELETE FROM pairing_codes WHERE used = 1 OR expires_at < ?1",
        params![now.to_rfc3339()],
    )?;
    let code = random_secret();
    let expires = (now + Duration::minutes(PAIRING_TTL_MINUTES)).to_rfc3339();
    conn.execute(
        "INSERT INTO pairing_codes(code, expires_at, used) VALUES(?1, ?2, 0)",
        params![code, expires],
    )?;
    Ok((code, expires))
}

/// Consume a pairing code and mint a device token. `None` when the code is
/// unknown, used, or expired.
pub fn redeem(
    conn: &Connection,
    code: &str,
    device_name: &str,
    now: DateTime<Utc>,
) -> rusqlite::Result<Option<String>> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT expires_at, used FROM pairing_codes WHERE code = ?1",
            params![code],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((expires_at, used)) = row else {
        return Ok(None);
    };
    let expired = DateTime::parse_from_rfc3339(&expires_at)
        .map(|t| t.with_timezone(&Utc) < now)
        .unwrap_or(true);
    if used != 0 || expired {
        return Ok(None);
    }
    // Conditional update makes redemption single-use even under races.
    let changed = conn.execute(
        "UPDATE pairing_codes SET used = 1 WHERE code = ?1 AND used = 0",
        params![code],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    let token = random_secret();
    conn.execute(
        "INSERT INTO mobile_devices(token_hash, id, name, user_agent, created_at, last_seen_at) VALUES(?1, ?2, ?3, ?3, ?4, ?4)",
        params![hash_token(&token), uuid::Uuid::new_v4().to_string(), device_name, now.to_rfc3339()],
    )?;
    Ok(Some(token))
}

/// True when the token belongs to a paired device; touches `last_seen_at`.
#[cfg(test)]
pub fn verify(conn: &Connection, token: &str, now: DateTime<Utc>) -> bool {
    if token.is_empty() {
        return false;
    }
    conn.execute(
        "UPDATE mobile_devices SET last_seen_at = ?2 WHERE token_hash = ?1",
        params![hash_token(token), now.to_rfc3339()],
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// Authenticate `token`, returning the paired device id in a single read query.
/// Updates `last_seen_at` in SQLite at most once per 60 seconds per device
/// (tracked in memory) so frequent GETs and SSE ticks avoid write-lock contention.
pub fn authenticate(conn: &Connection, token: &str, now: DateTime<Utc>) -> Option<String> {
    authenticate_with_cache(conn, token, now, &LAST_SEEN_WRITTEN, Instant::now())
}

fn authenticate_with_cache(
    conn: &Connection,
    token: &str,
    now: DateTime<Utc>,
    cache: &Mutex<HashMap<String, Instant>>,
    tick: Instant,
) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    let hash = hash_token(token);
    let id: String = conn
        .query_row(
            "SELECT id FROM mobile_devices WHERE token_hash = ?1",
            [&hash],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()?;

    let should_write = {
        let mut map = cache.lock();
        match map.get(&hash) {
            Some(&prev) if tick.saturating_duration_since(prev) < LAST_SEEN_THROTTLE => false,
            _ => {
                map.insert(hash.clone(), tick);
                true
            }
        }
    };
    if should_write {
        let _ = conn.execute(
            "UPDATE mobile_devices SET last_seen_at = ?2 WHERE token_hash = ?1",
            params![hash, now.to_rfc3339()],
        );
    }
    Some(id)
}

/// True when the token belongs to a paired device, without updating `last_seen_at`.
pub fn is_valid(conn: &Connection, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    conn.query_row(
        "SELECT 1 FROM mobile_devices WHERE token_hash = ?1",
        params![hash_token(token)],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .unwrap_or(false)
}

#[cfg(test)]
pub fn revoke_all(conn: &Connection) -> rusqlite::Result<()> {
    for (_, hash) in revoke_all_devices(conn)? {
        notify_revoked(&hash);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthSource {
    Bearer(String),
    Cookie(String),
}

impl AuthSource {
    pub fn token(&self) -> &str {
        match self {
            Self::Bearer(t) | Self::Cookie(t) => t,
        }
    }

    pub fn into_token(self) -> String {
        match self {
            Self::Bearer(t) | Self::Cookie(t) => t,
        }
    }
}

fn cookie_token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

/// True when the request includes the `ompws_token` auth cookie (even alongside Bearer).
pub fn has_auth_cookie(headers: &axum::http::HeaderMap) -> bool {
    cookie_token_from_headers(headers).is_some()
}

/// Extract the device token and its source (`Authorization: Bearer` preferred over `Cookie`).
pub fn auth_from_headers(headers: &axum::http::HeaderMap) -> Option<AuthSource> {
    if let Some(auth) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(t) = auth.strip_prefix("Bearer ") {
            let trimmed = t.trim();
            if !trimmed.is_empty() {
                return Some(AuthSource::Bearer(trimmed.to_string()));
            }
        }
    }
    cookie_token_from_headers(headers).map(AuthSource::Cookie)
}

/// Extract the device token from `Cookie` or `Authorization: Bearer` headers.
#[cfg(test)]
pub fn token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    auth_from_headers(headers).map(AuthSource::into_token)
}

#[cfg(test)]
pub fn test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE mobile_devices(token_hash TEXT PRIMARY KEY, id TEXT UNIQUE, name TEXT, user_agent TEXT, created_at TEXT NOT NULL, last_seen_at TEXT);
         CREATE TABLE pairing_codes(code TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
           token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_name_and_agent_produce_independent_devices_and_revoke_cleans_only_owner() {
        let db = test_db();
        let now = Utc::now();
        let (a, _) = create_pairing(&db, now).unwrap();
        let (b, _) = create_pairing(&db, now).unwrap();
        let a = redeem(&db, &a, "same agent", now).unwrap().unwrap();
        let b = redeem(&db, &b, "same agent", now).unwrap().unwrap();
        let devices = list_devices(&db).unwrap();
        assert_eq!(devices.len(), 2);
        assert_ne!(devices[0].id, devices[1].id);
        let id_a = device_id_for_token(&db, &a).unwrap();
        let id_b = device_id_for_token(&db, &b).unwrap();
        assert_ne!(id_a, id_b);
        assert_ne!(id_a, hash_token(&a));
        for (endpoint, token) in [("a", &a), ("b", &b)] {
            db.execute(
                "INSERT INTO push_subscriptions VALUES (?1, 'p', 'a', ?2, 't')",
                params![endpoint, hash_token(token)],
            )
            .unwrap();
        }
        assert!(rename_device(&db, &id_a, " named ").unwrap());
        assert_eq!(
            list_devices(&db)
                .unwrap()
                .into_iter()
                .find(|d| d.id == id_a)
                .unwrap()
                .name,
            "named"
        );
        assert!(rename_device(&db, &id_a, "").unwrap());
        assert_eq!(
            list_devices(&db)
                .unwrap()
                .into_iter()
                .find(|d| d.id == id_a)
                .unwrap()
                .name,
            "浏览器"
        );
        assert_eq!(revoke_device(&db, &id_a).unwrap(), Some(hash_token(&a)));
        assert!(!is_valid(&db, &a));
        assert!(is_valid(&db, &b));
        let endpoints: Vec<String> = db
            .prepare("SELECT endpoint FROM push_subscriptions")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(endpoints, vec!["b"]);
    }

    #[test]
    fn legacy_device_names_are_normalized_only_in_read_dtos() {
        let db = test_db();
        db.pragma_update(None, "user_version", 24).unwrap();
        let token = "legacy-token";
        let hash = hash_token(token);
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        db.execute(
            "INSERT INTO mobile_devices VALUES (?1, 'legacy-id', ?2, ?2, 'created', 'seen')",
            params![hash, ua],
        )
        .unwrap();

        let read_dtos = || {
            let current =
                serde_json::to_value(device_for_token(&db, token).unwrap().unwrap()).unwrap();
            let listed = serde_json::to_value(list_devices(&db).unwrap().remove(0)).unwrap();
            assert_eq!(current, listed);
            current
        };
        let dto = read_dtos();
        assert_eq!(dto["id"], "legacy-id");
        assert_eq!(dto["name"], "iPhone");
        assert_eq!(dto["userAgent"], ua);
        assert_eq!(dto["createdAt"], "created");
        assert_eq!(dto["lastSeenAt"], "seen");
        let stored: (String, String, String, String, String, String) = db
            .query_row(
                "SELECT token_hash, id, name, user_agent, created_at, last_seen_at FROM mobile_devices",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                hash,
                "legacy-id".into(),
                ua.into(),
                ua.into(),
                "created".into(),
                "seen".into()
            )
        );

        let custom = "Mozilla/5.0 — my deliberately long custom device name that differs from the actual user agent";
        assert!(rename_device(&db, "legacy-id", custom).unwrap());
        let renamed = read_dtos();
        assert_eq!(renamed["name"], custom);
        assert_eq!(renamed["id"], dto["id"]);
        assert_eq!(renamed["userAgent"], ua);
        assert_eq!(renamed["createdAt"], dto["createdAt"]);
        assert_eq!(renamed["lastSeenAt"], dto["lastSeenAt"]);
    }

    #[test]
    fn read_dtos_normalize_blank_and_legacy_platform_names() {
        let db = test_db();
        for (index, name, ua, expected) in [
            (0, "", "Mozilla/5.0 (iPad)", "iPad"),
            (1, "   ", "Mozilla/5.0 (iPod)", "iPod"),
            (
                2,
                "Mozilla/5.0 (Linux; Android 14)",
                "Mozilla/5.0 (Linux; Android 14)",
                "Android",
            ),
            (
                3,
                "Mozilla/5.0 (desktop)",
                "Mozilla/5.0 (desktop)",
                "浏览器",
            ),
            (4, "custom", "Mozilla/5.0 (iPhone)", "custom"),
        ] {
            let token = format!("token-{index}");
            db.execute(
                "INSERT INTO mobile_devices VALUES (?1, ?2, ?3, ?4, 'created', NULL)",
                params![hash_token(&token), index.to_string(), name, ua],
            )
            .unwrap();
            let device = device_for_token(&db, &token).unwrap().unwrap();
            assert_eq!(device.name, expected);
            assert_eq!(device.user_agent.as_deref(), Some(ua));
        }
        let devices = list_devices(&db).unwrap();
        assert_eq!(
            devices.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            vec!["iPad", "iPod", "Android", "浏览器", "custom"]
        );
    }

    #[test]
    fn pairing_is_one_time_and_expires() {
        let db = test_db();
        let now = Utc::now();
        let (code, _) = create_pairing(&db, now).unwrap();
        assert_eq!(code.len(), 43); // 32 bytes base64url
        let token = redeem(&db, &code, "phone", now).unwrap().expect("token");
        assert!(verify(&db, &token, now));
        assert!(
            redeem(&db, &code, "phone", now).unwrap().is_none(),
            "reused"
        );
        assert!(!verify(&db, "bogus", now));

        let (late, _) = create_pairing(&db, now).unwrap();
        let later = now + Duration::minutes(PAIRING_TTL_MINUTES + 1);
        assert!(
            redeem(&db, &late, "phone", later).unwrap().is_none(),
            "expired"
        );
        assert!(redeem(&db, "nope", "phone", now).unwrap().is_none());

        // Only the hash is stored.
        let stored: String = db
            .query_row("SELECT token_hash FROM mobile_devices", [], |r| r.get(0))
            .unwrap();
        assert_ne!(stored, token);
        assert_eq!(stored, hash_token(&token));
        assert!(is_valid(&db, &token));

        revoke_all(&db).unwrap();
        assert!(!verify(&db, &token, now));
        assert!(!is_valid(&db, &token));
    }

    #[test]
    fn token_extraction() {
        use axum::http::{header, HeaderMap, HeaderValue};
        let empty = HeaderMap::new();
        assert!(auth_from_headers(&empty).is_none());
        assert!(!has_auth_cookie(&empty));
        assert!(token_from_headers(&empty).is_none());

        let mut other_cookie = HeaderMap::new();
        other_cookie.insert(header::COOKIE, HeaderValue::from_static("a=1; theme=dark"));
        assert!(auth_from_headers(&other_cookie).is_none());
        assert!(!has_auth_cookie(&other_cookie));

        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; ompws_token=abc; b=2"),
        );
        assert_eq!(
            auth_from_headers(&h),
            Some(AuthSource::Cookie("abc".to_string()))
        );
        assert!(has_auth_cookie(&h));
        assert_eq!(token_from_headers(&h).as_deref(), Some("abc"));

        // Bearer takes precedence over cookie, while has_auth_cookie remains true.
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer xyz"),
        );
        assert_eq!(
            auth_from_headers(&h),
            Some(AuthSource::Bearer("xyz".to_string()))
        );
        assert!(has_auth_cookie(&h));
        assert_eq!(token_from_headers(&h).as_deref(), Some("xyz"));

        // Bearer-only (with or without unrelated cookies) has_auth_cookie == false.
        let mut bearer_only = HeaderMap::new();
        bearer_only.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer native-tok"),
        );
        bearer_only.insert(header::COOKIE, HeaderValue::from_static("prefs=1"));
        assert_eq!(
            auth_from_headers(&bearer_only),
            Some(AuthSource::Bearer("native-tok".to_string()))
        );
        assert!(!has_auth_cookie(&bearer_only));
        assert_eq!(
            token_from_headers(&bearer_only).as_deref(),
            Some("native-tok")
        );
    }

    #[test]
    fn authenticate_throttles_last_seen_sqlite_writes() {
        let db = test_db();
        let t0 = Utc::now();
        let (code, _) = create_pairing(&db, t0).unwrap();
        let token = redeem(&db, &code, "phone", t0).unwrap().unwrap();
        let cache: Mutex<HashMap<String, Instant>> = Mutex::new(HashMap::new());
        let base = Instant::now();

        let last_seen = |conn: &Connection| -> Option<String> {
            conn.query_row(
                "SELECT last_seen_at FROM mobile_devices WHERE token_hash = ?1",
                [hash_token(&token)],
                |r| r.get(0),
            )
            .unwrap()
        };

        // First call records last_seen_at.
        let t1 = t0 + Duration::seconds(5);
        let id = authenticate_with_cache(&db, &token, t1, &cache, base).unwrap();
        assert!(!id.is_empty());
        assert_eq!(last_seen(&db).as_deref(), Some(t1.to_rfc3339().as_str()));

        // Within 60s, authenticate succeeds without issuing another SQLite UPDATE.
        let t2 = t1 + Duration::seconds(30);
        assert_eq!(
            authenticate_with_cache(
                &db,
                &token,
                t2,
                &cache,
                base + std::time::Duration::from_secs(30)
            ),
            Some(id.clone())
        );
        assert_eq!(last_seen(&db).as_deref(), Some(t1.to_rfc3339().as_str()));

        // Once 60s elapse, last_seen_at is persisted again.
        let t3 = t1 + Duration::seconds(61);
        assert_eq!(
            authenticate_with_cache(
                &db,
                &token,
                t3,
                &cache,
                base + std::time::Duration::from_secs(61)
            ),
            Some(id)
        );
        assert_eq!(last_seen(&db).as_deref(), Some(t3.to_rfc3339().as_str()));

        // Invalid token returns None.
        assert!(authenticate_with_cache(&db, "bogus", t3, &cache, base).is_none());
    }
}
