//! First-party, cookieless product analytics (core).
//!
//! Mirrors `app/routers/analytics.py` and `app/services/analytics.py`. The track
//! endpoint validates a client event and appends it to a bounded in-process
//! queue, so the request path never waits on the database. A background loop
//! drains the queue into `analytics_events`, and an hourly rollup aggregates the
//! previous UTC day into `analytics_daily` and prunes raw rows past the
//! retention window.
//!
//! The queue is process-local: on a multi-worker deployment each worker flushes
//! its own buffered events. The production stack runs a single worker, so this
//! matches the Python service.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::ratelimit::RateLimiter;
use crate::AppState;

const MAX_EVENT_LENGTH: usize = 64;
const MAX_PROPERTIES_BYTES: usize = 4096;
const MAX_SESSION_LENGTH: usize = 64;
const MAX_QUEUE_SIZE: usize = 10_000;
const FLUSH_BATCH: usize = 500;
const TRACK_LIMIT: u32 = 60;
const TRACK_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
struct PendingEvent {
    user_id: Option<Uuid>,
    event: String,
    properties: Value,
    session_id: Option<String>,
}

struct Analytics {
    queue: Mutex<VecDeque<PendingEvent>>,
    notify: tokio::sync::Notify,
}

impl Analytics {
    fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            notify: tokio::sync::Notify::new(),
        }
    }
}

fn analytics() -> &'static Analytics {
    static ANALYTICS: OnceLock<Analytics> = OnceLock::new();
    ANALYTICS.get_or_init(Analytics::new)
}

fn track_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:analytics"))
}

/// Append an event to the in-memory queue. Never blocks or raises on the request
/// path: a full queue or an invalid payload is dropped and returns `false`.
pub fn enqueue_event(
    user_id: Option<&str>,
    event: &str,
    properties: Option<&Value>,
    session_id: Option<&str>,
) -> bool {
    let name = event.trim();
    if name.is_empty() || name.chars().count() > MAX_EVENT_LENGTH {
        return false;
    }
    let props = match properties {
        Some(v) if v.is_object() => v.clone(),
        Some(_) => return false,
        None => Value::Object(Default::default()),
    };
    let encoded = serde_json::to_vec(&props).unwrap_or_default();
    if encoded.len() > MAX_PROPERTIES_BYTES {
        return false;
    }
    let sid = session_id
        .map(|s| s.chars().take(MAX_SESSION_LENGTH).collect::<String>())
        .filter(|s| !s.is_empty());
    let uid = user_id.and_then(|s| Uuid::parse_str(s).ok());

    let a = analytics();
    let mut queue = a.queue.lock().unwrap_or_else(|e| e.into_inner());
    if queue.len() >= MAX_QUEUE_SIZE {
        return false;
    }
    queue.push_back(PendingEvent {
        user_id: uid,
        event: name.to_string(),
        properties: props,
        session_id: sid,
    });
    drop(queue);
    a.notify.notify_one();
    true
}

/// Drain the in-memory queue into `analytics_events`, returning how many events
/// were written. Each row is attempted independently so one failure cannot abort
/// the batch.
pub async fn flush_pending(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let batch: Vec<PendingEvent> = {
        let a = analytics();
        let mut queue = a.queue.lock().unwrap_or_else(|e| e.into_inner());
        let take = queue.len().min(FLUSH_BATCH);
        queue.drain(..take).collect()
    };
    if batch.is_empty() {
        return Ok(0);
    }
    let mut count = 0usize;
    for item in batch {
        let result = sqlx::query(
            "INSERT INTO analytics_events (user_id, event, properties, session_id) \
             VALUES ($1, $2, $3::jsonb, $4)",
        )
        .bind(item.user_id)
        .bind(&item.event)
        .bind(&item.properties)
        .bind(&item.session_id)
        .execute(pool)
        .await;
        match result {
            Ok(_) => count += 1,
            Err(err) => tracing::warn!("analytics flush skipped an event: {err}"),
        }
    }
    Ok(count)
}

/// Background loop: drain the queue whenever it is non-empty, otherwise wait up
/// to `flush_interval` for a new event. One failure never stops the loop.
pub async fn analytics_flush_loop(pool: PgPool, flush_interval: Duration) {
    loop {
        if let Err(err) = flush_pending(&pool).await {
            tracing::warn!("analytics flush loop pass failed: {err}");
        }
        let _ = tokio::time::timeout(flush_interval, analytics().notify.notified()).await;
    }
}

/// Aggregate the previous UTC day into `analytics_daily` and prune raw rows past
/// the retention window (identified and anonymous separately). Exposed so tests
/// can drive it directly.
pub async fn run_rollup(
    pool: &PgPool,
    retention_days: i64,
    anon_retention_days: i64,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let day = (now - ChronoDuration::days(1)).date_naive();
    let start = day.and_hms_opt(0, 0, 0).expect("midnight").and_utc();
    let next = start + ChronoDuration::days(1);

    let rows = sqlx::query(
        "SELECT event, COUNT(*)::bigint AS cnt, COUNT(DISTINCT user_id)::bigint AS users \
         FROM analytics_events WHERE created_at >= $1 AND created_at < $2 GROUP BY event",
    )
    .bind(start)
    .bind(next)
    .fetch_all(pool)
    .await?;

    for row in rows {
        let event: String = row.try_get("event").unwrap_or_default();
        let cnt: i64 = row.try_get("cnt").unwrap_or(0);
        let users: i64 = row.try_get("users").unwrap_or(0);
        sqlx::query(
            "INSERT INTO analytics_daily (day, event, count, unique_users) VALUES ($1, $2, $3::int, $4::int) \
             ON CONFLICT (day, event) DO UPDATE SET count = EXCLUDED.count, unique_users = EXCLUDED.unique_users",
        )
        .bind(day)
        .bind(&event)
        .bind(cnt)
        .bind(users)
        .execute(pool)
        .await?;
    }

    sqlx::query("DELETE FROM analytics_events WHERE created_at < now() - make_interval(days => $1::int)")
        .bind(retention_days as i32)
        .execute(pool)
        .await?;
    sqlx::query(
        "DELETE FROM analytics_events WHERE user_id IS NULL AND created_at < now() - make_interval(days => $1::int)",
    )
    .bind(anon_retention_days as i32)
    .execute(pool)
    .await?;
    Ok(())
}

/// Background loop: aggregate the previous UTC day and prune, then sleep.
pub async fn analytics_rollup_loop(
    pool: PgPool,
    rollup_interval: Duration,
    retention_days: i64,
    anon_retention_days: i64,
) {
    loop {
        if let Err(err) = run_rollup(&pool, retention_days, anon_retention_days).await {
            tracing::warn!("analytics rollup loop pass failed: {err}");
        }
        tokio::time::sleep(rollup_interval).await;
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/analytics/track", post(track))
}

#[derive(Deserialize)]
struct TrackRequest {
    #[serde(default)]
    event: String,
    #[serde(default)]
    properties: Value,
    #[serde(default)]
    session_id: Option<String>,
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn too_many_events() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "detail": "Too many analytics events - slow down" })),
    )
        .into_response()
}

async fn track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TrackRequest>,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers)?;

    let event = body.event.trim().to_string();
    if event.is_empty() {
        return Err(ApiError::Unprocessable(
            "event must be a non-empty string".to_string(),
        ));
    }
    if event.chars().count() > MAX_EVENT_LENGTH {
        return Err(ApiError::Unprocessable(format!(
            "event must be at most {MAX_EVENT_LENGTH} characters"
        )));
    }
    let properties = if body.properties.is_null() {
        json!({})
    } else {
        body.properties
    };
    if !properties.is_object()
        || serde_json::to_vec(&properties).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_PROPERTIES_BYTES
    {
        return Err(ApiError::Unprocessable(format!(
            "properties must be a JSON object of at most {MAX_PROPERTIES_BYTES} bytes"
        )));
    }

    if track_limiter().count(&user.user_id.to_string(), TRACK_WINDOW).await > TRACK_LIMIT {
        return Ok(too_many_events());
    }

    enqueue_event(
        Some(&user.user_id.to_string()),
        &event,
        Some(&properties),
        body.session_id.as_deref(),
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_rejects_invalid_payloads() {
        assert!(!enqueue_event(None, "", None, None));
        assert!(!enqueue_event(None, "   ", None, None));
        let long = "a".repeat(MAX_EVENT_LENGTH + 1);
        assert!(!enqueue_event(None, &long, None, None));
        assert!(!enqueue_event(None, "valid_name", Some(&json!("not-an-object")), None));
        let big = json!({ "payload": "x".repeat(MAX_PROPERTIES_BYTES + 1) });
        assert!(!enqueue_event(None, "valid_name", Some(&big), None));
        assert!(enqueue_event(None, "valid_name", Some(&json!({ "a": 1 })), Some("sess")));
    }

    async fn live_state() -> Option<AppState> {
        let database_url = std::env::var("DATABASE_URL").ok()?;
        let settings = crate::config::Settings {
            database_url,
            jwt_secret_key: "test-secret-key-that-is-at-least-32-chars!".to_string(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".to_string(),
            app_origin: "http://localhost:3000".to_string(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".to_string(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: "http://localhost:3000/api/auth/oauth/google/callback".to_string(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: false,
            csrf_allowed_origins: "http://localhost:3000".to_string(),
            api_rate_limit_enabled: false,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".to_string(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: "mailto:support@prysmnote.com".to_string(),
            notify_email: String::new(),
            notification_loop_interval: 1800,
            digest_hour: 7,
        };
        Some(AppState::lazy(settings))
    }

    #[tokio::test]
    async fn flush_writes_queued_events() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-analytics-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");
        let event = format!("rust_flush_{}", Uuid::new_v4().simple());

        assert!(enqueue_event(Some(&user.id.to_string()), &event, Some(&json!({ "n": 1 })), None));
        let mut flushed = 0usize;
        for _ in 0..3 {
            flushed += flush_pending(&state.pool).await.expect("flush");
        }
        assert!(flushed >= 1);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM analytics_events WHERE event = $1")
            .bind(&event)
            .fetch_one(&state.pool)
            .await
            .expect("count");
        assert_eq!(count, 1);

        sqlx::query("DELETE FROM analytics_events WHERE event = $1")
            .bind(&event)
            .execute(&state.pool)
            .await
            .expect("cleanup events");
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .expect("cleanup user");
    }

    #[tokio::test]
    async fn rollup_aggregates_the_previous_day() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-rollup-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");
        let event = format!("rust_rollup_{}", Uuid::new_v4().simple());
        let start = (Utc::now() - ChronoDuration::days(1))
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .expect("midnight")
            .and_utc();
        let seed_at = start + ChronoDuration::hours(12);

        sqlx::query(
            "INSERT INTO analytics_events (user_id, event, properties, created_at) \
             VALUES ($1, $2, '{}'::jsonb, $3)",
        )
        .bind(user.id)
        .bind(&event)
        .bind(seed_at)
        .execute(&state.pool)
        .await
        .expect("seed event");

        run_rollup(&state.pool, 30, 7).await.expect("rollup");

        let count: i64 = sqlx::query_scalar(
            "SELECT count::bigint FROM analytics_daily WHERE day = $1 AND event = $2",
        )
        .bind(start.date_naive())
        .bind(&event)
        .fetch_one(&state.pool)
        .await
        .expect("daily row");
        assert_eq!(count, 1);

        sqlx::query("DELETE FROM analytics_daily WHERE day = $1 AND event = $2")
            .bind(start.date_naive())
            .bind(&event)
            .execute(&state.pool)
            .await
            .expect("cleanup daily");
        sqlx::query("DELETE FROM analytics_events WHERE event = $1")
            .bind(&event)
            .execute(&state.pool)
            .await
            .expect("cleanup events");
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .expect("cleanup user");
    }
}
