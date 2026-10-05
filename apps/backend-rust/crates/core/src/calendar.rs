//! Google Calendar integration (service + core router).
//!
//! The reusable service lives in core (open-core) so the Enterprise crate can
//! build the paywalled connect/sync/import/settings surface on top of it.
//! Tokens are stored in `user_tokens` with the Fernet `enc:` envelope, per-user
//! sync preferences live in `user_preferences`, and the Google Calendar REST v3
//! API is called with `reqwest`.
//!
//! The community build serves the core `/api/calendar` status + manual pull
//! routes; the premium calendar routes (connect, callback, sync, import,
//! settings, calendars, disconnect) live in the Enterprise crate.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::config::Settings;
use crate::error::ApiError;
use crate::{auth, db, AppState};

pub const PROVIDER: &str = "google_calendar";
const ENC_PREFIX: &str = "enc:";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/auth";
const REVOKE_URI: &str = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";

pub const GOOGLE_CALENDAR_SCOPES: [&str; 2] = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

pub const CAL_SYNC_INTERVAL_KEY: &str = "calendar_sync_interval_minutes";
pub const CAL_SELECTED_IDS_KEY: &str = "calendar_selected_calendars";

pub const CAL_INTERVAL_CHOICES: [i64; 7] = [15, 30, 60, 180, 360, 720, 1440];
pub const CAL_INTERVAL_FLOOR: i64 = 15;
pub const CAL_INTERVAL_MAX: i64 = 1440;

const GOOGLE_PAGE_SIZE: i64 = 250;
const MAX_EVENT_PAGES: usize = 2;
const IMPORT_LOOKBACK_DAYS: i64 = 30;
const MAX_SYNC_TASKS: i64 = 100;
const MAX_CALENDARS: i64 = 50;

// ---------------------------------------------------------------------------
// Token encryption (Fernet `enc:` envelope, Python-compatible)
// ---------------------------------------------------------------------------

pub fn encrypt_token(key: &str, value: &str) -> Result<String, ApiError> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let token = crate::fernet::encrypt(key, value.as_bytes())
        .map_err(|e| ApiError::Internal(format!("token encryption failed: {e}")))?;
    Ok(format!("{ENC_PREFIX}{token}"))
}

pub fn decrypt_token(key: &str, value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    if let Some(raw) = value.strip_prefix(ENC_PREFIX) {
        if let Ok(bytes) = crate::fernet::decrypt(key, raw) {
            if let Ok(text) = String::from_utf8(bytes) {
                return text;
            }
        }
        return value.to_string();
    }
    value.to_string()
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

pub async fn store_tokens(
    conn: &mut PgConnection,
    key: &str,
    user_id: Uuid,
    access_token: &str,
    refresh_token: Option<&str>,
    expiry: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    let enc_access = encrypt_token(key, access_token)
        .map_err(|_| sqlx::Error::Protocol("encrypt".into()))?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM user_tokens WHERE user_id = $1 AND provider = $2",
    )
    .bind(user_id)
    .bind(PROVIDER)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(id) = existing {
        let enc_refresh = match refresh_token {
            Some(rt) => {
                Some(encrypt_token(key, rt).map_err(|_| sqlx::Error::Protocol("encrypt".into()))?)
            }
            None => None,
        };
        sqlx::query(
            "UPDATE user_tokens SET access_token = $1, \
             refresh_token = COALESCE($2, refresh_token), expiry = $3, updated_at = now() \
             WHERE id = $4",
        )
        .bind(enc_access)
        .bind(enc_refresh)
        .bind(expiry)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    } else {
        let enc_refresh = match refresh_token {
            Some(rt) => {
                Some(encrypt_token(key, rt).map_err(|_| sqlx::Error::Protocol("encrypt".into()))?)
            }
            None => None,
        };
        let scopes = GOOGLE_CALENDAR_SCOPES.join(" ");
        sqlx::query(
            "INSERT INTO user_tokens \
             (user_id, provider, access_token, refresh_token, token_uri, scopes, expiry) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(user_id)
        .bind(PROVIDER)
        .bind(enc_access)
        .bind(enc_refresh)
        .bind(TOKEN_URI)
        .bind(scopes)
        .bind(expiry)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Returns (access_token, refresh_token) decrypted, or None when not connected.
pub async fn get_stored_tokens(
    conn: &mut PgConnection,
    key: &str,
    user_id: Uuid,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT access_token, refresh_token FROM user_tokens \
         WHERE user_id = $1 AND provider = $2",
    )
    .bind(user_id)
    .bind(PROVIDER)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let access: String = row.try_get("access_token")?;
    if access.is_empty() {
        return Ok(None);
    }
    let refresh: Option<String> = row.try_get("refresh_token").ok().flatten();
    Ok(Some((
        decrypt_token(key, &access),
        decrypt_token(key, refresh.as_deref().unwrap_or("")),
    )))
}

// ---------------------------------------------------------------------------
// Per-user preferences
// ---------------------------------------------------------------------------

async fn get_pref(
    conn: &mut PgConnection,
    user_id: Uuid,
    key: &str,
) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2")
        .bind(user_id)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
}

pub fn clamp_interval(minutes: i64) -> i64 {
    minutes.clamp(CAL_INTERVAL_FLOOR, CAL_INTERVAL_MAX)
}

/// Mirrors Python `get_user_calendar_interval`: the stored value is minutes,
/// the fallback is `settings.gcal_pull_interval` (seconds). The caller treats
/// the returned number the same way Python does (seconds in the pull loop).
pub async fn get_user_calendar_interval(
    conn: &mut PgConnection,
    user_id: Uuid,
    default_interval: u64,
) -> i64 {
    let value = match get_pref(conn, user_id, CAL_SYNC_INTERVAL_KEY).await {
        Ok(v) => v,
        Err(_) => return default_interval as i64,
    };
    let Some(value) = value else { return default_interval as i64 };
    let minutes = match value.get("minutes").and_then(|m| m.as_i64()) {
        Some(m) => m,
        None => return default_interval as i64,
    };
    clamp_interval(minutes)
}

pub async fn get_user_calendar_ids(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> Result<Option<Vec<String>>, sqlx::Error> {
    let value = get_pref(conn, user_id, CAL_SELECTED_IDS_KEY).await?;
    let Some(value) = value else { return Ok(None) };
    let Some(raw) = value.get("ids").and_then(|v| v.as_array()) else {
        return Ok(None);
    };
    let ids: Vec<String> = raw
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(MAX_CALENDARS as usize)
        .collect();
    if ids.is_empty() {
        Ok(None)
    } else {
        Ok(Some(ids))
    }
}

pub async fn set_user_calendar_prefs(
    conn: &mut PgConnection,
    user_id: Uuid,
    interval_minutes: Option<i64>,
    calendar_ids: Option<Vec<String>>,
) -> Result<(), sqlx::Error> {
    if let Some(minutes) = interval_minutes {
        let value = json!({ "minutes": clamp_interval(minutes) });
        upsert_pref(conn, user_id, CAL_SYNC_INTERVAL_KEY, value).await?;
    }
    if let Some(ids) = calendar_ids {
        let ids: Vec<String> = ids
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(MAX_CALENDARS as usize)
            .collect();
        upsert_pref(conn, user_id, CAL_SELECTED_IDS_KEY, json!({ "ids": ids })).await?;
    }
    Ok(())
}

async fn upsert_pref(
    conn: &mut PgConnection,
    user_id: Uuid,
    key: &str,
    value: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(user_id)
    .bind(key)
    .bind(value)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Google OAuth helpers
// ---------------------------------------------------------------------------

pub fn build_auth_url(client_id: &str, redirect_uri: &str, state: &str, extra_scopes: &[String]) -> String {
    let mut scopes: Vec<&str> = GOOGLE_CALENDAR_SCOPES.to_vec();
    for s in extra_scopes {
        scopes.push(s.as_str());
    }
    let scope = scopes.join(" ");
    let mut url = format!(
        "{AUTH_URI}?response_type=code&access_type=offline&prompt=consent\
         &include_granted_scopes=true&client_id={}&redirect_uri={}&scope={}&state={}",
        enc(client_id),
        enc(redirect_uri),
        enc(&scope),
        enc(state),
    );
    url = url.replace(' ', "%20");
    url
}

fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Debug)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
) -> Result<OAuthTokens, ApiError> {
    let client = reqwest::Client::new();
    let params = [
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    let resp = client
        .post(TOKEN_URI)
        .form(&params)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| ApiError::BadGateway(format!("Google connection failed: {e}")))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| ApiError::BadGateway(format!("Google connection failed: {e}")))?;
    if !status.is_success() {
        let detail = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(ApiError::BadRequest(format!(
            "Google rejected the connection: {detail}"
        )));
    }
    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadGateway("Google connection failed: missing token".into()))?
        .to_string();
    let refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_at = body
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .map(|secs| Utc::now() + chrono::Duration::seconds(secs));
    Ok(OAuthTokens { access_token, refresh_token, expires_at })
}

pub async fn revoke_google_token(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(REVOKE_URI)
        .form(&[("token", token)])
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match resp {
        Ok(r) => matches!(r.status().as_u16(), 200 | 400),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Google Calendar REST
// ---------------------------------------------------------------------------

fn google_error_reason(status: u16, body: &str) -> String {
    let low = body.to_lowercase();
    if low.contains("accessnotconfigured")
        || low.contains("has not been used in project")
        || (low.contains("disabled") && low.contains("console.developers.google.com"))
    {
        return "The Google Calendar API is not enabled for this server's Google Cloud project. \
                An administrator must enable it, then try again."
            .to_string();
    }
    if low.contains("insufficient") {
        return "The saved Google connection is missing calendar permissions. \
                Reconnect Google Calendar to grant access, then try again."
            .to_string();
    }
    if low.contains("invalid_grant") || low.contains("invalid credentials") || status == 401 {
        return "Google rejected the saved credentials. Reconnect Google Calendar and try again."
            .to_string();
    }
    if status == 403 {
        return "Google denied the request. Reconnect Google Calendar and check its permissions."
            .to_string();
    }
    if status == 429 || low.contains("ratelimitexceeded") || low.contains("quota") {
        return "Google rate limited the request. Try again in a few minutes.".to_string();
    }
    if low.contains("timed out") || low.contains("timeout") {
        return "Google did not respond in time. Try again.".to_string();
    }
    body.chars().take(200).collect()
}

async fn google_get(access_token: &str, url: &str) -> Result<(u16, Value), ApiError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| ApiError::BadGateway(format!("Google request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&body).unwrap_or(json!({ "raw": body }));
    Ok((status, json))
}

async fn list_events_blocking(
    access_token: &str,
    max_results: i64,
    time_min: &str,
    calendar_id: &str,
) -> Result<Vec<Value>, ApiError> {
    let mut items: Vec<Value> = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_EVENT_PAGES {
        let remaining = max_results - items.len() as i64;
        if remaining <= 0 {
            break;
        }
        let mut url = format!(
            "{CALENDAR_API}/calendars/{}/events?timeMin={}&singleEvents=true&orderBy=startTime&maxResults={}",
            enc(calendar_id),
            enc(time_min),
            GOOGLE_PAGE_SIZE.min(remaining),
        );
        if let Some(token) = &page_token {
            url.push_str(&format!("&pageToken={}", enc(token)));
        }
        let (status, body) = google_get(access_token, &url).await?;
        if !(200..300).contains(&status) {
            return Err(ApiError::BadGateway(google_error_reason(
                status,
                &body.to_string(),
            )));
        }
        if let Some(arr) = body.get("items").and_then(|v| v.as_array()) {
            items.extend(arr.iter().cloned());
        }
        page_token = body.get("nextPageToken").and_then(|v| v.as_str()).map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    Ok(items)
}

async fn upsert_event_blocking(
    access_token: &str,
    event_body: &Value,
    google_event_id: Option<&str>,
) -> Result<(String, String), ApiError> {
    let client = reqwest::Client::new();
    let url = match google_event_id {
        Some(id) => format!(
            "{CALENDAR_API}/calendars/primary/events/{}",
            enc(id)
        ),
        None => format!("{CALENDAR_API}/calendars/primary/events"),
    };
    let req = if google_event_id.is_some() {
        client.put(&url)
    } else {
        client.post(&url)
    };
    let resp = req
        .bearer_auth(access_token)
        .json(event_body)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| ApiError::BadGateway(format!("Google request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(json!({}));
    if !(200..300).contains(&status) {
        return Err(ApiError::BadGateway(google_error_reason(
            status,
            &body.to_string(),
        )));
    }
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let link = body.get("htmlLink").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok((id, link))
}

pub async fn list_calendars(access_token: &str) -> Result<Vec<Value>, ApiError> {
    let url = format!(
        "{CALENDAR_API}/users/me/calendarList?maxResults={MAX_CALENDARS}&minAccessRole=writer"
    );
    let (status, body) = google_get(access_token, &url).await?;
    if !(200..300).contains(&status) {
        return Err(ApiError::BadGateway(google_error_reason(
            status,
            &body.to_string(),
        )));
    }
    let mut out = Vec::new();
    if let Some(arr) = body.get("items").and_then(|v| v.as_array()) {
        for item in arr {
            let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = item
                .get("summaryOverride")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("summary").and_then(|v| v.as_str()))
                .unwrap_or(id);
            let primary = item.get("primary").and_then(|v| v.as_bool()).unwrap_or(false);
            out.push(json!({ "id": id, "name": name, "primary": primary }));
        }
    }
    Ok(out)
}

fn parse_iso_date(raw: Option<&str>) -> Option<NaiveDate> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let head: String = raw.chars().take(10).collect();
    NaiveDate::parse_from_str(&head, "%Y-%m-%d").ok()
}

fn google_event_date(info: Option<&Value>) -> Option<NaiveDate> {
    let info = info?;
    let raw = info
        .get("date")
        .and_then(|v| v.as_str())
        .or_else(|| info.get("dateTime").and_then(|v| v.as_str()));
    parse_iso_date(raw)
}

fn task_event_body(task: &crate::task::Task) -> Value {
    let start = task.start_date.map(|d| d.to_string()).unwrap_or_default();
    let end = task
        .due_date
        .or(task.start_date)
        .map(|d| d.to_string())
        .unwrap_or_else(|| start.clone());
    json!({
        "summary": task.title,
        "description": task.description.clone().unwrap_or_default(),
        "start": { "date": start, "timeZone": "UTC" },
        "end": { "date": end, "timeZone": "UTC" },
    })
}

// ---------------------------------------------------------------------------
// Pull / import / sync
// ---------------------------------------------------------------------------

/// Pulls events for the given calendars and imports unseen ones as tasks.
/// Mirrors Python `pull_and_import_events`. Returns the result envelope as JSON.
pub async fn pull_and_import_events(
    pool: &PgPool,
    enc_key: &str,
    user_id: Uuid,
    access_token: &str,
    calendar_ids: Option<Vec<String>>,
) -> Value {
    let calendars = calendar_ids.unwrap_or_else(|| vec!["primary".to_string()]);
    let time_min = (Utc::now() - chrono::Duration::days(IMPORT_LOOKBACK_DAYS))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();

    let mut collected: Vec<(Value, String)> = Vec::new();
    let mut first_error: Option<String> = None;
    for cal_id in &calendars {
        match list_events_blocking(access_token, GOOGLE_PAGE_SIZE, &time_min, cal_id).await {
            Ok(items) => {
                for item in items {
                    collected.push((item, cal_id.clone()));
                }
            }
            Err(e) => {
                first_error = Some(error_detail(&e));
                break;
            }
        }
    }
    if let Some(err) = first_error {
        return json!({ "imported": 0, "error": err });
    }

    let total_events = collected.len();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return json!({ "imported": 0, "error": "database error" }),
    };
    if db::set_rls_user(&mut *tx, user_id, "").await.is_err() {
        return json!({ "imported": 0, "error": "database error" });
    }
    let _ = enc_key;
    let mut imported = 0i64;
    for (item, cal_id) in &collected {
        let Some(google_event_id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let exists: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM calendar_events WHERE user_id = $1 AND google_event_id = $2 \
             AND calendar_id = $3",
        )
        .bind(user_id)
        .bind(google_event_id)
        .bind(cal_id)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);
        if exists.is_some() {
            continue;
        }
        let title = item
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Event");
        let description = item.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let start_date = google_event_date(item.get("start"));
        let due_date = google_event_date(item.get("end"));
        let task_id: Result<Uuid, _> = sqlx::query_scalar(
            "INSERT INTO tasks (user_id, title, description, status, priority, is_all_day, \
             is_archived, start_date, due_date) \
             VALUES ($1, $2, $3, 'todo'::task_status, 3, false, false, $4, $5) RETURNING id",
        )
        .bind(user_id)
        .bind(title)
        .bind(description)
        .bind(start_date)
        .bind(due_date)
        .fetch_one(&mut *tx)
        .await;
        let Ok(task_id) = task_id else { continue };
        let insert_event = sqlx::query(
            "INSERT INTO calendar_events \
             (user_id, task_id, google_event_id, calendar_id, sync_action) \
             VALUES ($1, $2, $3, $4, 'pull')",
        )
        .bind(user_id)
        .bind(task_id)
        .bind(google_event_id)
        .bind(cal_id)
        .execute(&mut *tx)
        .await;
        if insert_event.is_ok() {
            imported += 1;
        }
    }
    if tx.commit().await.is_err() {
        return json!({ "imported": 0, "error": "database error" });
    }
    json!({
        "imported": imported,
        "total_events": total_events,
        "window_days": IMPORT_LOOKBACK_DAYS,
        "calendars": calendars,
    })
}

/// Progress sample handed to a [`sync_all_tasks_tracked`] callback after each
/// task's push attempt, so a background job can expose live status.
pub struct SyncProgressUpdate {
    /// Tasks attempted so far (pushed + failed).
    pub processed: i64,
    /// Tasks pushed successfully so far.
    pub pushed: i64,
    /// Tasks that failed so far.
    pub failed: i64,
    /// Total tasks selected for this run.
    pub total: i64,
}

/// Push pending local tasks to the primary calendar.
pub async fn sync_all_tasks(
    pool: &PgPool,
    enc_key: &str,
    user_id: Uuid,
    access_token: &str,
) -> Value {
    sync_all_tasks_tracked(pool, enc_key, user_id, access_token, None).await
}

/// Like [`sync_all_tasks`], but reports progress after every task so a caller
/// can drive a background job's status endpoint. The callback runs on the sync
/// task (never across the network calls themselves).
pub async fn sync_all_tasks_tracked(
    pool: &PgPool,
    enc_key: &str,
    user_id: Uuid,
    access_token: &str,
    progress: Option<&(dyn Fn(SyncProgressUpdate) + Send + Sync)>,
) -> Value {
    let _ = enc_key;
    let empty = || json!({ "pushed": 0, "failed": 0, "total": 0, "remaining": 0 });
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => return empty(),
    };
    let _ = crate::db::set_rls_user(&mut conn, user_id, "").await;
    let sql = format!(
        "SELECT {} FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND start_date IS NOT NULL AND status NOT IN ('cancelled'::task_status) \
         AND NOT EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.user_id = tasks.user_id \
             AND ce.task_id = tasks.id AND ce.sync_action = 'push' \
             AND ce.last_synced_at >= tasks.updated_at) \
         ORDER BY updated_at DESC LIMIT $2",
        crate::task::COLUMNS
    );
    let rows = match sqlx::query(&sql)
        .bind(user_id)
        .bind(MAX_SYNC_TASKS)
        .fetch_all(&mut *conn)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return empty(),
    };
    let tasks: Vec<crate::task::Task> = rows
        .iter()
        .filter_map(|row| crate::task::Task::from_row(row).ok())
        .collect();
    let total = tasks.len() as i64;
    let mut pushed = 0i64;
    let mut failed = 0i64;
    let mut first_error: Option<String> = None;
    for task in &tasks {
        let body = task_event_body(task);
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT google_event_id FROM calendar_events \
             WHERE user_id = $1 AND task_id = $2 AND sync_action = 'push' LIMIT 1",
        )
        .bind(user_id)
        .bind(task.id)
        .fetch_optional(&mut *conn)
        .await
        .ok()
        .flatten();
        match upsert_event_blocking(access_token, &body, existing.as_deref()).await {
            Ok((gid, _link)) => {
                let result = if existing.is_some() {
                    sqlx::query(
                        "UPDATE calendar_events SET last_synced_at = now() \
                         WHERE user_id = $1 AND task_id = $2 AND sync_action = 'push'",
                    )
                    .bind(user_id)
                    .bind(task.id)
                    .execute(&mut *conn)
                    .await
                } else {
                    sqlx::query(
                        "INSERT INTO calendar_events \
                         (user_id, task_id, google_event_id, calendar_id, sync_action) \
                         VALUES ($1, $2, $3, 'primary', 'push')",
                    )
                    .bind(user_id)
                    .bind(task.id)
                    .bind(gid)
                    .execute(&mut *conn)
                    .await
                };
                if result.is_ok() {
                    pushed += 1;
                } else {
                    failed += 1;
                }
            }
            Err(err) => {
                failed += 1;
                if first_error.is_none() {
                    first_error = Some(error_detail(&err));
                }
            }
        }
        if let Some(cb) = progress {
            cb(SyncProgressUpdate {
                processed: pushed + failed,
                pushed,
                failed,
                total,
            });
        }
    }
    json!({
        "pushed": pushed,
        "failed": failed,
        "total": total,
        "remaining": (total - (pushed + failed)).max(0),
        "error": first_error,
    })
}

/// Expose the inner message of an [`ApiError`] so the EE router can render the
/// Google error reason in a 502 body the same way the Python handler does.
pub fn error_detail(err: &ApiError) -> String {
    match err {
        ApiError::BadGateway(msg)
        | ApiError::BadRequest(msg)
        | ApiError::Internal(msg)
        | ApiError::Unprocessable(msg)
        | ApiError::Forbidden(msg)
        | ApiError::NotFound(msg)
        | ApiError::Conflict(msg)
        | ApiError::Unauthorized(msg)
        | ApiError::TooManyRequests(msg)
        | ApiError::PaymentRequired(msg)
        | ApiError::PayloadTooLarge(msg)
        | ApiError::ServiceUnavailable(msg) => msg.clone(),
    }
}

// ---------------------------------------------------------------------------
// Background pull loop (leader-gated, mirroring Python gcal_pull_background_loop)
// ---------------------------------------------------------------------------

/// Periodically pull Google Calendar events for every connected user whose
/// per-user interval has elapsed. Listing tokens and evaluating intervals runs
/// in one short transaction (never held across network calls); each user's pull
/// then runs as its own task on its own pooled connection, bounded by
/// `settings.gcal_pull_concurrency()` so external calls overlap at most that
/// many at a time. A per-user failure is swallowed so one user cannot abort the
/// batch.
pub async fn gcal_pull_background_loop(pool: PgPool, settings: Settings, interval: Duration) {
    let concurrency = settings.gcal_pull_concurrency().max(1);
    loop {
        let due = due_for_pull(&pool, &settings).await;
        if !due.is_empty() {
            let semaphore = Arc::new(Semaphore::new(concurrency));
            let mut tasks = JoinSet::new();
            for user_id in due {
                let pool = pool.clone();
                let settings = settings.clone();
                let semaphore = semaphore.clone();
                tasks.spawn(async move {
                    let _permit = semaphore.acquire_owned().await;
                    pull_one(&pool, &settings, user_id).await;
                });
            }
            while tasks.join_next().await.is_some() {}
        }
        tokio::time::sleep(interval).await;
    }
}

async fn due_for_pull(pool: &PgPool, settings: &Settings) -> Vec<Uuid> {
    let mut due = Vec::new();
    let Ok(mut tx) = pool.begin().await else {
        return due;
    };
    let rows =
        match sqlx::query("SELECT user_id, last_pulled_at FROM user_tokens WHERE provider = $1")
            .bind(PROVIDER)
            .fetch_all(&mut *tx)
            .await
        {
            Ok(rows) => rows,
            Err(_) => return due,
        };
    let now = Utc::now();
    for row in rows {
        let Ok(user_id) = row.try_get::<Uuid, _>("user_id") else {
            continue;
        };
        let last: Option<DateTime<Utc>> = row.try_get("last_pulled_at").ok().flatten();
        let _ = db::set_rls_user(&mut tx, user_id, "").await;
        let user_interval =
            get_user_calendar_interval(&mut tx, user_id, settings.gcal_pull_interval()).await;
        let is_due = match last {
            None => true,
            Some(ts) => (now - ts).num_seconds() >= user_interval,
        };
        if is_due {
            due.push(user_id);
        }
    }
    let _ = tx.commit().await;
    due
}

async fn pull_one(pool: &PgPool, settings: &Settings, user_id: Uuid) {
    let key = settings.encryption_key.clone();
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => return,
    };
    let row = match sqlx::query(
        "SELECT access_token FROM user_tokens WHERE user_id = $1 AND provider = $2",
    )
    .bind(user_id)
    .bind(PROVIDER)
    .fetch_optional(&mut *conn)
    .await
    {
        Ok(Some(row)) => row,
        _ => return,
    };
    let Ok(access) = row.try_get::<String, _>("access_token") else {
        return;
    };
    let access = decrypt_token(&key, &access);
    drop(conn);

    let selected = {
        let Ok(mut tx) = pool.begin().await else {
            return;
        };
        let _ = db::set_rls_user(&mut tx, user_id, "").await;
        let ids = get_user_calendar_ids(&mut tx, user_id).await.ok().flatten();
        let _ = tx.commit().await;
        ids
    };

    let _ = pull_and_import_events(pool, &key, user_id, &access, selected).await;

    let _ = sqlx::query(
        "UPDATE user_tokens SET last_pulled_at = now() WHERE user_id = $1 AND provider = $2",
    )
    .bind(user_id)
    .bind(PROVIDER)
    .execute(pool)
    .await;
}

// ---------------------------------------------------------------------------
// Core router: /api/calendar
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/calendar/status", get(status))
        .route("/api/calendar/pull", post(pull))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<auth::AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    let row = sqlx::query(
        "SELECT access_token, last_pulled_at FROM user_tokens \
         WHERE user_id = $1 AND provider = $2",
    )
    .bind(user.user_id)
    .bind(PROVIDER)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db_error)?;
    match row {
        None => Ok(Json(json!({ "connected": false, "last_synced_at": null }))),
        Some(row) => {
            let access: String = row.try_get("access_token").map_err(db_error)?;
            if access.is_empty() {
                return Ok(Json(json!({ "connected": false, "last_synced_at": null })));
            }
            let last: Option<DateTime<Utc>> = row.try_get("last_pulled_at").ok().flatten();
            Ok(Json(json!({
                "connected": true,
                "last_synced_at": last.map(|d| d.to_rfc3339()),
            })))
        }
    }
}

async fn pull(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let key = state.settings.encryption_key.clone();
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    let row = sqlx::query(
        "SELECT access_token, refresh_token, last_pulled_at FROM user_tokens \
         WHERE user_id = $1 AND provider = $2",
    )
    .bind(user.user_id)
    .bind(PROVIDER)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    let Some(row) = row else {
        return Err(ApiError::BadRequest(
            "Google Calendar not connected. Authorize in Settings first.".to_string(),
        ));
    };
    let access: String = row.try_get("access_token").map_err(db_error)?;
    if access.is_empty() {
        return Err(ApiError::BadRequest(
            "Google Calendar not connected. Authorize in Settings first.".to_string(),
        ));
    }
    let refresh: Option<String> = row.try_get("refresh_token").ok().flatten();
    let last_pulled: Option<DateTime<Utc>> = row.try_get("last_pulled_at").ok().flatten();

    let min_interval = state.settings.calendar_manual_sync_min_interval() as i64;
    if let Some(last) = last_pulled {
        let elapsed = (Utc::now() - last).num_seconds();
        if elapsed < min_interval {
            let remaining = (min_interval - elapsed).max(1);
            return Err(ApiError::TooManyRequests(format!(
                "Calendar synced recently. Try again in {remaining}s."
            )));
        }
    }
    tx.commit().await.map_err(db_error)?;

    let access = decrypt_token(&key, &access);
    let refresh = decrypt_token(&key, refresh.as_deref().unwrap_or(""));
    let _ = &refresh;

    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    let _ = db::set_rls_user(&mut conn, user.user_id, "").await;
    let ids = get_user_calendar_ids(&mut conn, user.user_id).await.map_err(db_error)?;
    drop(conn);

    let result =
        pull_and_import_events(&state.pool, &key, user.user_id, &access, ids).await;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    sqlx::query(
        "UPDATE user_tokens SET last_pulled_at = now() WHERE user_id = $1 AND provider = $2",
    )
    .bind(user.user_id)
    .bind(PROVIDER)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_encrypt_decrypt_round_trip() {
        let key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
        let token = encrypt_token(key, "ya29.example").unwrap();
        assert!(token.starts_with("enc:"));
        assert_eq!(decrypt_token(key, &token), "ya29.example");
        assert_eq!(encrypt_token(key, "").unwrap(), "");
        assert_eq!(decrypt_token(key, ""), "");
        // Legacy plaintext passes through untouched.
        assert_eq!(decrypt_token(key, "plain"), "plain");
    }

    #[test]
    fn interval_clamp_matches_python_choices() {
        assert_eq!(clamp_interval(0), 15);
        assert_eq!(clamp_interval(15), 15);
        assert_eq!(clamp_interval(60), 60);
        assert_eq!(clamp_interval(9999), 1440);
    }
}
