//! Notification preferences, reminder task listing, push subscription
//! management, and the dev-only test sender, mirroring the Python
//! `/api/notifications` router. Unlike Python, the `/test` endpoint is gated OFF
//! in production (it sends real push/email on demand).

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::{db, email, notification_service, AppState};

const REMINDER_TASKS_MAX: i64 = 200;

const ALLOWED_PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notifications/prefs", get(get_prefs).patch(update_prefs))
        .route("/api/notifications/reminder-tasks", get(reminder_tasks))
        .route("/api/notifications/vapid-public-key", get(vapid_public_key))
        .route(
            "/api/notifications/subscribe",
            axum::routing::post(subscribe).delete(unsubscribe),
        )
        .route("/api/notifications/test", axum::routing::post(test_notification))
}

#[derive(Deserialize)]
struct UpdatePrefsRequest {
    inapp_reminders: Option<bool>,
    reminder_time: Option<String>,
    email_reminders: Option<bool>,
    due_alerts: Option<bool>,
    email_digest: Option<bool>,
    push_enabled: Option<bool>,
    sound: Option<bool>,
}

#[derive(Deserialize)]
struct ReminderQuery {
    before: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct SubscribeRequest {
    endpoint: String,
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
struct UnsubscribeQuery {
    endpoint: String,
}

#[derive(Clone)]
pub(crate) struct Prefs {
    pub(crate) inapp_reminders: bool,
    pub(crate) reminder_time: String,
    pub(crate) email_reminders: bool,
    pub(crate) due_alerts: bool,
    pub(crate) email_digest: bool,
    pub(crate) push_enabled: bool,
    pub(crate) sound: bool,
}

impl Prefs {
    fn to_json(&self) -> Value {
        json!({
            "inapp_reminders": self.inapp_reminders,
            "reminder_time": self.reminder_time,
            "email_reminders": self.email_reminders,
            "due_alerts": self.due_alerts,
            "email_digest": self.email_digest,
            "push_enabled": self.push_enabled,
            "sound": self.sound,
        })
    }
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

/// Load a user's notification prefs, creating the default row on first read
/// (Python `get_or_create_prefs`). Reused by the notification background loop.
pub(crate) async fn load_prefs(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
) -> Result<Prefs, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO user_notification_prefs
             (user_id, inapp_reminders, reminder_time, email_reminders, due_alerts, email_digest, push_enabled, sound)
         VALUES ($1, true, '20:00', false, true, false, false, true)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING inapp_reminders, reminder_time, email_reminders, due_alerts, email_digest, push_enabled, sound",
    )
    .bind(user_id)
    .fetch_one(conn)
    .await?;

    Ok(Prefs {
        inapp_reminders: row.try_get("inapp_reminders").unwrap(),
        reminder_time: row.try_get("reminder_time").unwrap(),
        email_reminders: row.try_get("email_reminders").unwrap(),
        due_alerts: row.try_get("due_alerts").unwrap(),
        email_digest: row.try_get("email_digest").unwrap(),
        push_enabled: row.try_get("push_enabled").unwrap(),
        sound: row.try_get("sound").unwrap(),
    })
}

fn valid_reminder_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    if !bytes[0..2].iter().all(|b| b.is_ascii_digit()) || !bytes[3..5].iter().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    let hour: u32 = value[0..2].parse().unwrap_or(99);
    let minute: u32 = value[3..5].parse().unwrap_or(99);
    hour <= 23 && minute <= 59
}

fn validate_push_endpoint(endpoint: &str) -> Result<(), ApiError> {
    let parsed = url::Url::parse(endpoint)
        .map_err(|_| ApiError::BadRequest("Push endpoint must be an https URL".to_string()))?;
    if parsed.scheme() != "https" {
        return Err(ApiError::BadRequest("Push endpoint must be an https URL".to_string()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::BadRequest("Push endpoint must be an https URL".to_string()))?;
    let allowed = ALLOWED_PUSH_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")));
    if !allowed {
        return Err(ApiError::BadRequest(
            "Push endpoint host is not a supported push service".to_string(),
        ));
    }
    Ok(())
}

async fn get_prefs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let prefs = load_prefs(&mut *tx, user.user_id).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    Ok(Json(prefs.to_json()))
}

async fn update_prefs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdatePrefsRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    if let Some(reminder_time) = &payload.reminder_time {
        if !valid_reminder_time(reminder_time) {
            return Err(ApiError::Unprocessable(
                "reminder_time must be HH:MM (24h)".to_string(),
            ));
        }
    }

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    load_prefs(&mut *tx, user.user_id).await.map_err(db_error)?;

    if let Some(value) = payload.inapp_reminders {
        sqlx::query("UPDATE user_notification_prefs SET inapp_reminders = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(value) = &payload.reminder_time {
        sqlx::query("UPDATE user_notification_prefs SET reminder_time = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(value) = payload.email_reminders {
        sqlx::query("UPDATE user_notification_prefs SET email_reminders = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(value) = payload.due_alerts {
        sqlx::query("UPDATE user_notification_prefs SET due_alerts = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(value) = payload.email_digest {
        sqlx::query("UPDATE user_notification_prefs SET email_digest = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(value) = payload.push_enabled {
        sqlx::query("UPDATE user_notification_prefs SET push_enabled = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(value) = payload.sound {
        sqlx::query("UPDATE user_notification_prefs SET sound = $1, updated_at = now() WHERE user_id = $2")
            .bind(value)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }

    let prefs = load_prefs(&mut *tx, user.user_id).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(prefs.to_json()))
}

async fn reminder_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReminderQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let before = match &query.before {
        None => Utc::now().date_naive() + Duration::days(1),
        Some(raw) => NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map_err(|_| ApiError::Unprocessable("before must be YYYY-MM-DD".to_string()))?,
    };
    let limit = query.limit.unwrap_or(100).clamp(1, REMINDER_TASKS_MAX);

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let rows = sqlx::query(
        "SELECT id, title, due_date, start_date FROM tasks
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND is_archived = false
           AND status::text NOT IN ('done', 'cancelled')
           AND COALESCE(due_date, start_date) IS NOT NULL
           AND COALESCE(due_date, start_date) <= $2
           AND reminder_enabled = true
         ORDER BY COALESCE(due_date, start_date) ASC, title ASC
         LIMIT $3",
    )
    .bind(user.user_id)
    .bind(before)
    .bind(limit)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let id: Uuid = row.try_get("id").unwrap();
            let due: Option<NaiveDate> = row.try_get("due_date").unwrap();
            let start: Option<NaiveDate> = row.try_get("start_date").unwrap();
            json!({
                "id": id.to_string(),
                "title": row.try_get::<String, _>("title").unwrap(),
                "due_date": due.map(|d| d.format("%Y-%m-%d").to_string()),
                "start_date": start.map(|d| d.format("%Y-%m-%d").to_string()),
            })
        })
        .collect();

    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(items)))
}

async fn vapid_public_key(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "public_key": state.settings.vapid_public_key() }))
}

async fn subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SubscribeRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    validate_push_endpoint(&payload.endpoint)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    sqlx::query(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth",
    )
    .bind(user.user_id)
    .bind(&payload.endpoint)
    .bind(&payload.p256dh)
    .bind(&payload.auth)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;

    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "subscribed" })))
}

async fn unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<UnsubscribeQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(&query.endpoint)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "unsubscribed" })))
}

/// `POST /api/notifications/test` - send a test push (when enabled) and/or a
/// test email (when email reminders are on). Mirrors Python
/// `routers/notifications.py::send_test` but is gated OFF in production: it
/// triggers real outbound messages on demand.
async fn test_notification(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    if state.settings.is_production() {
        return Err(ApiError::NotFound("Not found".to_string()));
    }
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let prefs = load_prefs(&mut *tx, user.user_id).await.map_err(db_error)?;
    let email_address: Option<String> =
        sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;

    let mut attempted = false;
    if prefs.push_enabled {
        notification_service::push_to_user(
            &mut *tx,
            user.user_id,
            "Prysm Note",
            "Test push notification",
            &state.settings,
        )
        .await
        .map_err(db_error)?;
        attempted = true;
    }
    if prefs.email_reminders {
        if let Some(address) = email_address.filter(|value| !value.is_empty()) {
            email::send_email(
                &state.settings,
                &address,
                "Prysm Note test",
                "This is a test notification from Prysm Note.",
                None,
            )
            .await;
            attempted = true;
        }
    }
    tx.commit().await.map_err(db_error)?;

    if !attempted {
        return Err(ApiError::BadRequest(
            "Enable email reminders or push to test".to_string(),
        ));
    }
    Ok(Json(json!({ "status": "sent" })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

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

    async fn call(app: &Router, method: &str, uri: &str, token: &str, body: Option<Value>) -> axum::response::Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", format!("access_token={token}"));
        let request = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                builder.body(Body::from(value.to_string())).unwrap()
            }
            None => builder.body(Body::empty()).unwrap(),
        };
        app.clone().oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[test]
    fn reminder_time_validation() {
        assert!(valid_reminder_time("20:00"));
        assert!(valid_reminder_time("09:05"));
        assert!(valid_reminder_time("23:59"));
        assert!(!valid_reminder_time("24:00"));
        assert!(!valid_reminder_time("20:60"));
        assert!(!valid_reminder_time("8:00"));
        assert!(!valid_reminder_time("nope"));
    }

    #[test]
    fn push_endpoint_validation() {
        assert!(validate_push_endpoint("https://fcm.googleapis.com/fcm/send/abc").is_ok());
        assert!(validate_push_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x").is_ok());
        assert!(validate_push_endpoint("http://fcm.googleapis.com/x").is_err());
        assert!(validate_push_endpoint("https://evil.example.com/x").is_err());
    }

    #[tokio::test]
    async fn prefs_and_subscription_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-notif-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        let res = call(&app, "GET", "/api/notifications/prefs", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let prefs = body_json(res).await;
        assert_eq!(prefs["reminder_time"], json!("20:00"));
        assert_eq!(prefs["inapp_reminders"], json!(true));

        let res = call(
            &app,
            "PATCH",
            "/api/notifications/prefs",
            &token,
            Some(json!({"reminder_time": "07:30", "push_enabled": true})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["reminder_time"], json!("07:30"));

        let res = call(
            &app,
            "PATCH",
            "/api/notifications/prefs",
            &token,
            Some(json!({"reminder_time": "99:99"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let res = call(
            &app,
            "POST",
            "/api/notifications/subscribe",
            &token,
            Some(json!({"endpoint": "https://fcm.googleapis.com/fcm/send/test", "p256dh": "k", "auth": "a"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        let res = call(
            &app,
            "POST",
            "/api/notifications/subscribe",
            &token,
            Some(json!({"endpoint": "https://evil.example.com/x", "p256dh": "k", "auth": "a"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_notification_requires_a_channel_then_reports_sent() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-notif-test-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        // Defaults: push off, email reminders off -> nothing attempted, 400.
        let res = call(&app, "POST", "/api/notifications/test", &token, None).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(res).await["detail"],
            json!("Enable email reminders or push to test")
        );

        // Push enabled with no subscriptions still counts as an attempt.
        let res = call(
            &app,
            "PATCH",
            "/api/notifications/prefs",
            &token,
            Some(json!({"push_enabled": true})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        let res = call(&app, "POST", "/api/notifications/test", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], json!("sent"));

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_notification_is_404_in_production() {
        let Some(state) = live_state().await else {
            return;
        };
        let mut prod_settings = (*state.settings).clone();
        prod_settings.environment = "production".to_string();
        let prod_state = AppState::new(state.pool.clone(), prod_settings);
        let app = router().with_state(prod_state);

        let email = format!("rust-notif-prod-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();

        let res = call(&app, "POST", "/api/notifications/test", &token, None).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
