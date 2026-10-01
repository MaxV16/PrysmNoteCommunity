//! Habits + habit logs, mirroring the Python `/api/habits` router, including
//! the day-by-day streak computation.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::{db, task::require_uuid, AppState};

const STREAK_LOOKBACK_DAYS: i64 = 730;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/habits", get(list_habits).post(create_habit))
        .route("/api/habits/", get(list_habits).post(create_habit))
        .route(
            "/api/habits/{habit_id}",
            axum::routing::patch(update_habit).delete(delete_habit),
        )
        .route("/api/habits/{habit_id}/log", post(toggle_log))
        .route("/api/habits/{habit_id}/logs", get(list_logs))
}

#[derive(Deserialize)]
pub(crate) struct CreateHabitRequest {
    pub(crate) title: String,
    #[serde(default = "default_frequency")]
    pub(crate) frequency: String,
    #[serde(default = "default_target_count")]
    pub(crate) target_count: i32,
    pub(crate) color: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateHabitRequest {
    pub(crate) title: Option<String>,
    pub(crate) frequency: Option<String>,
    pub(crate) target_count: Option<i32>,
    pub(crate) color: Option<String>,
}

#[derive(Deserialize)]
struct LogsQuery {
    #[serde(rename = "from")]
    from_date: Option<NaiveDate>,
    #[serde(rename = "to")]
    to_date: Option<NaiveDate>,
}

fn default_frequency() -> String {
    "daily".to_string()
}
fn default_target_count() -> i32 {
    1
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn compute_streak(completion_dates: &[NaiveDate]) -> i64 {
    if completion_dates.is_empty() {
        return 0;
    }
    let mut dates: Vec<NaiveDate> = completion_dates.to_vec();
    dates.sort();
    dates.dedup();
    dates.reverse();

    let today = Utc::now().date_naive();
    let mut expected = today;
    let mut streak: i64 = 0;
    for d in &dates {
        if *d == expected {
            streak += 1;
            expected -= Duration::days(1);
        } else if *d < expected {
            break;
        }
    }
    if dates[0] < today {
        return 0;
    }
    streak
}

async fn habit_json(
    conn: &mut sqlx::PgConnection,
    id: Uuid,
    title: String,
    frequency: String,
    target_count: i32,
    color: Option<String>,
    created_at: chrono::DateTime<Utc>,
    lookback: bool,
) -> Result<Value, sqlx::Error> {
    let rows = if lookback {
        let cutoff = Utc::now().date_naive() - Duration::days(STREAK_LOOKBACK_DAYS);
        sqlx::query("SELECT completed_at FROM habit_logs WHERE habit_id = $1 AND completed_at >= $2")
            .bind(id)
            .bind(cutoff)
            .fetch_all(&mut *conn)
            .await?
    } else {
        sqlx::query("SELECT completed_at FROM habit_logs WHERE habit_id = $1")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?
    };
    let dates: Vec<NaiveDate> = rows
        .iter()
        .map(|row| row.try_get::<NaiveDate, _>("completed_at").unwrap())
        .collect();
    let streak = compute_streak(&dates);

    Ok(json!({
        "id": id.to_string(),
        "title": title,
        "frequency": frequency,
        "target_count": target_count,
        "color": color,
        "streak": streak,
        "created_at": created_at.to_rfc3339(),
    }))
}

pub(crate) async fn svc_list_habits(
    state: &AppState,
    user_id: Uuid,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;

    let rows = sqlx::query(
        "SELECT id, title, frequency, target_count, color, created_at FROM habits WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;

    let ids: Vec<Uuid> = rows.iter().map(|row| row.try_get("id").unwrap()).collect();
    let cutoff = Utc::now().date_naive() - Duration::days(STREAK_LOOKBACK_DAYS);
    let mut logs: std::collections::HashMap<Uuid, Vec<NaiveDate>> = std::collections::HashMap::new();
    if !ids.is_empty() {
        let log_rows = sqlx::query(
            "SELECT habit_id, completed_at FROM habit_logs WHERE habit_id = ANY($1) AND completed_at >= $2",
        )
        .bind(&ids)
        .bind(cutoff)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
        for row in log_rows {
            let habit_id: Uuid = row.try_get("habit_id").unwrap();
            let completed_at: NaiveDate = row.try_get("completed_at").unwrap();
            logs.entry(habit_id).or_default().push(completed_at);
        }
    }

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let id: Uuid = row.try_get("id").unwrap();
            let created_at: Option<chrono::DateTime<Utc>> = row.try_get("created_at").unwrap();
            let dates = logs.get(&id).cloned().unwrap_or_default();
            json!({
                "id": id.to_string(),
                "title": row.try_get::<String, _>("title").unwrap(),
                "frequency": row.try_get::<String, _>("frequency").unwrap(),
                "target_count": row.try_get::<i32, _>("target_count").unwrap(),
                "color": row.try_get::<Option<String>, _>("color").unwrap(),
                "streak": compute_streak(&dates),
                "created_at": created_at.map(|d| d.to_rfc3339()).unwrap_or_default(),
            })
        })
        .collect();

    tx.commit().await.map_err(db_error)?;
    Ok(Value::Array(items))
}

async fn list_habits(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_list_habits(&state, user.user_id).await?))
}

pub(crate) async fn svc_create_habit(
    state: &AppState,
    user_id: Uuid,
    payload: CreateHabitRequest,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;

    let row = sqlx::query(
        "INSERT INTO habits (user_id, title, frequency, target_count, color)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
    )
    .bind(user_id)
    .bind(&payload.title)
    .bind(&payload.frequency)
    .bind(payload.target_count)
    .bind(&payload.color)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;

    let id: Uuid = row.try_get("id").unwrap();
    let created_at: Option<chrono::DateTime<Utc>> = row.try_get("created_at").unwrap();
    tx.commit().await.map_err(db_error)?;

    Ok(json!({
        "id": id.to_string(),
        "title": payload.title,
        "frequency": payload.frequency,
        "target_count": payload.target_count,
        "color": payload.color,
        "streak": 0,
        "created_at": created_at.map(|d| d.to_rfc3339()).unwrap_or_default(),
    }))
}

async fn create_habit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateHabitRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_create_habit(&state, user.user_id, payload).await?))
}

pub(crate) async fn svc_update_habit(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    payload: UpdateHabitRequest,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;

    let existing = sqlx::query("SELECT id FROM habits WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    if existing.is_none() {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Habit not found".to_string()));
    }

    if let Some(title) = &payload.title {
        sqlx::query("UPDATE habits SET title = $1 WHERE id = $2")
            .bind(title)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(frequency) = &payload.frequency {
        sqlx::query("UPDATE habits SET frequency = $1 WHERE id = $2")
            .bind(frequency)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(target_count) = payload.target_count {
        sqlx::query("UPDATE habits SET target_count = $1 WHERE id = $2")
            .bind(target_count)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(color) = &payload.color {
        sqlx::query("UPDATE habits SET color = $1 WHERE id = $2")
            .bind(color)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }

    let row = sqlx::query(
        "SELECT title, frequency, target_count, color, created_at FROM habits WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;

    let value = habit_json(
        &mut *tx,
        id,
        row.try_get("title").unwrap(),
        row.try_get("frequency").unwrap(),
        row.try_get("target_count").unwrap(),
        row.try_get("color").unwrap(),
        row.try_get::<Option<chrono::DateTime<Utc>>, _>("created_at").unwrap().unwrap_or_default(),
        false,
    )
    .await
    .map_err(db_error)?;

    tx.commit().await.map_err(db_error)?;
    Ok(value)
}

async fn update_habit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(habit_id): Path<String>,
    Json(payload): Json<UpdateHabitRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&habit_id)?;
    Ok(Json(svc_update_habit(&state, user.user_id, id, payload).await?))
}

pub(crate) async fn svc_delete_habit(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;

    let result = sqlx::query("DELETE FROM habits WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    if result.rows_affected() == 0 {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Habit not found".to_string()));
    }

    tx.commit().await.map_err(db_error)?;
    Ok(())
}

async fn delete_habit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(habit_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&habit_id)?;
    svc_delete_habit(&state, user.user_id, id).await?;
    Ok(Json(json!({ "status": "deleted" })))
}

pub(crate) async fn svc_toggle_habit_log(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;

    let existing = sqlx::query("SELECT id FROM habits WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    if existing.is_none() {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Habit not found".to_string()));
    }

    let today = Utc::now().date_naive();
    let existing_log = sqlx::query("SELECT id FROM habit_logs WHERE habit_id = $1 AND completed_at = $2")
        .bind(id)
        .bind(today)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;

    let logged = if existing_log.is_some() {
        sqlx::query("DELETE FROM habit_logs WHERE habit_id = $1 AND completed_at = $2")
            .bind(id)
            .bind(today)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        false
    } else {
        sqlx::query("INSERT INTO habit_logs (habit_id, user_id, completed_at) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(user_id)
            .bind(today)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        true
    };

    let rows = sqlx::query("SELECT completed_at FROM habit_logs WHERE habit_id = $1")
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let dates: Vec<NaiveDate> = rows
        .iter()
        .map(|row| row.try_get("completed_at").unwrap())
        .collect();
    let streak = compute_streak(&dates);

    tx.commit().await.map_err(db_error)?;
    Ok(json!({
        "logged": logged,
        "streak": streak,
        "date": today.format("%Y-%m-%d").to_string(),
    }))
}

async fn toggle_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(habit_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&habit_id)?;
    Ok(Json(svc_toggle_habit_log(&state, user.user_id, id).await?))
}

pub(crate) async fn svc_get_habit_logs(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    from_date: Option<NaiveDate>,
    to_date: Option<NaiveDate>,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;

    let existing = sqlx::query("SELECT id FROM habits WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    if existing.is_none() {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Habit not found".to_string()));
    }

    let rows = sqlx::query(
        "SELECT id, completed_at, created_at FROM habit_logs
         WHERE habit_id = $1
           AND ($2::date IS NULL OR completed_at >= $2)
           AND ($3::date IS NULL OR completed_at <= $3)
         ORDER BY completed_at ASC",
    )
    .bind(id)
    .bind(from_date)
    .bind(to_date)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let log_id: Uuid = row.try_get("id").unwrap();
            let completed_at: NaiveDate = row.try_get("completed_at").unwrap();
            let created_at: Option<chrono::DateTime<Utc>> = row.try_get("created_at").unwrap();
            json!({
                "id": log_id.to_string(),
                "completed_at": completed_at.format("%Y-%m-%d").to_string(),
                "created_at": created_at.map(|d| d.to_rfc3339()).unwrap_or_default(),
            })
        })
        .collect();

    tx.commit().await.map_err(db_error)?;
    Ok(Value::Array(items))
}

async fn list_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(habit_id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&habit_id)?;
    Ok(Json(
        svc_get_habit_logs(&state, user.user_id, id, query.from_date, query.to_date).await?,
    ))
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

    #[tokio::test]
    async fn habit_log_toggle_and_streak() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-habits-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        let res = call(&app, "POST", "/api/habits", &token, Some(json!({"title": "Read"}))).await;
        assert_eq!(res.status(), StatusCode::OK);
        let habit = body_json(res).await;
        let habit_id = habit["id"].as_str().unwrap().to_string();
        assert_eq!(habit["streak"], json!(0));

        let res = call(&app, "POST", &format!("/api/habits/{habit_id}/log"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let toggled = body_json(res).await;
        assert_eq!(toggled["logged"], json!(true));
        assert_eq!(toggled["streak"], json!(1));

        let res = call(&app, "GET", &format!("/api/habits/{habit_id}/logs"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await.as_array().unwrap().len(), 1);

        let res = call(&app, "POST", &format!("/api/habits/{habit_id}/log"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["logged"], json!(false));

        let res = call(&app, "DELETE", &format!("/api/habits/{habit_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
