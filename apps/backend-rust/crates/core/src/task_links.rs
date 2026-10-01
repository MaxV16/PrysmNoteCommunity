//! `/api/task-links` routes: typed links between a user's tasks.
//!
//! Mirrors the Python `routers/task_links.py` contract. Both endpoints of a
//! link must be active tasks owned by the caller; duplicate links are a 409.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::db;
use crate::error::ApiError;
use crate::AppState;

const LINK_TYPES: [&str; 4] = ["depends_on", "related", "blocks", "duplicates"];

/// The `/api/task-links` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/task-links", get(list_links))
        .route("/api/task-links/", get(list_links))
        .route("/api/task-links", post(create_link))
        .route("/api/task-links/", post(create_link))
        .route("/api/task-links/{link_id}", delete(delete_link))
}

#[derive(Deserialize, Default)]
struct ListQuery {
    task_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateTaskLinkRequest {
    source_task_id: String,
    target_task_id: String,
    #[serde(default = "default_link_type")]
    link_type: String,
}

fn default_link_type() -> String {
    "related".to_string()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn require_uuid(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::NotFound("Invalid id".to_string()))
}

fn valid_link_type(link_type: &str) -> bool {
    LINK_TYPES.contains(&link_type)
}

/// Format a timestamp the way Python's `str(datetime)` does.
fn python_datetime(dt: DateTime<Utc>) -> String {
    if dt.timestamp_subsec_micros() == 0 {
        dt.format("%Y-%m-%d %H:%M:%S+00:00").to_string()
    } else {
        dt.format("%Y-%m-%d %H:%M:%S%.6f+00:00").to_string()
    }
}

async fn task_is_owned_active(
    conn: &mut PgConnection,
    task_id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .is_some())
}

fn link_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.try_get::<Uuid, _>("id").unwrap().to_string(),
        "source_task_id": row.try_get::<Uuid, _>("source_task_id").unwrap().to_string(),
        "target_task_id": row.try_get::<Uuid, _>("target_task_id").unwrap().to_string(),
        "link_type": row.try_get::<String, _>("link_type").unwrap(),
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_links(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let rows = match query.task_id.as_deref() {
        Some(raw) => {
            let task_id = require_uuid(raw)?;
            sqlx::query(
                "SELECT id, source_task_id, target_task_id, link_type::text AS link_type, created_at \
                 FROM task_links WHERE user_id = $1 AND (source_task_id = $2 OR target_task_id = $2)",
            )
            .bind(user.user_id)
            .bind(task_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?
        }
        None => sqlx::query(
            "SELECT id, source_task_id, target_task_id, link_type::text AS link_type, created_at \
             FROM task_links WHERE user_id = $1",
        )
        .bind(user.user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?,
    };
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            let created: DateTime<Utc> = row.try_get("created_at").unwrap();
            let mut value = link_json(row);
            value["created_at"] = Value::String(python_datetime(created));
            value
        })
        .collect();
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

async fn create_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateTaskLinkRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let source_id = require_uuid(&req.source_task_id)?;
    let target_id = require_uuid(&req.target_task_id)?;
    if !valid_link_type(&req.link_type) {
        return Err(ApiError::Unprocessable(
            "Invalid link type. Must be one of: blocks, depends_on, duplicates, related".to_string(),
        ));
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    if !task_is_owned_active(&mut *tx, source_id, user.user_id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Source task not found".to_string()));
    }
    if !task_is_owned_active(&mut *tx, target_id, user.user_id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Target task not found".to_string()));
    }
    let existing = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM task_links WHERE user_id = $1 AND source_task_id = $2 AND target_task_id = $3",
    )
    .bind(user.user_id)
    .bind(source_id)
    .bind(target_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    if existing.is_some() {
        return Err(ApiError::Conflict("Link already exists".to_string()));
    }
    let row = sqlx::query(
        "INSERT INTO task_links (user_id, source_task_id, target_task_id, link_type) \
         VALUES ($1, $2, $3, $4::task_link_type) \
         RETURNING id, source_task_id, target_task_id, link_type::text AS link_type",
    )
    .bind(user.user_id)
    .bind(source_id)
    .bind(target_id)
    .bind(&req.link_type)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let out = link_json(&row);
    tx.commit().await.map_err(db_error)?;
    Ok(Json(out))
}

async fn delete_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(link_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let link_id = require_uuid(&link_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let result = sqlx::query("DELETE FROM task_links WHERE id = $1 AND user_id = $2")
        .bind(link_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("Link not found".to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted" })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let settings = config::Settings {
            database_url: url,
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

    async fn call(
        app: Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        let request = builder
            .body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty))
            .unwrap();
        app.oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn create_task(app: &Router, token: &str, title: &str) -> String {
        let res = call(
            app.clone(),
            "POST",
            "/api/tasks",
            token,
            Some(json!({ "title": title })),
        )
        .await;
        body_json(res).await["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn create_list_delete_link_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-links-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let app = router()
            .merge(crate::tasks::router())
            .with_state(state.clone());
        let a = create_task(&app, &token, "A").await;
        let b = create_task(&app, &token, "B").await;

        let res = call(
            app.clone(),
            "POST",
            "/api/task-links",
            &token,
            Some(json!({ "source_task_id": a, "target_task_id": b, "link_type": "blocks" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        assert_eq!(created["link_type"], "blocks");
        let link_id = created["id"].as_str().unwrap().to_string();

        // duplicate -> 409
        let res = call(
            app.clone(),
            "POST",
            "/api/task-links",
            &token,
            Some(json!({ "source_task_id": a, "target_task_id": b })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/task-links?task_id={a}"),
            &token,
            None,
        )
        .await;
        let links = body_json(res).await;
        assert!(links.as_array().unwrap().iter().any(|l| l["id"] == link_id));

        let res = call(app.clone(), "DELETE", &format!("/api/task-links/{link_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
