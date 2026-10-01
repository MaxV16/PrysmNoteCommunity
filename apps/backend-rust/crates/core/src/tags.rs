//! `/api/tags` routes: user tag CRUD plus task-tag assignment.
//!
//! Mirrors the Python `routers/tags.py` contract (paths, status codes,
//! `{"detail": ...}` errors, tag JSON shape). The tag list is served through
//! the cache-aside store (Redis when configured, otherwise in-process) with a
//! 30 second TTL; every write invalidates it.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::db;
use crate::error::ApiError;
use crate::AppState;

const TAG_NAME_MAX: usize = 50;
const TAGS_CACHE_TTL: u64 = 30;

/// The cache key for a user's tag list.
fn tags_cache_key(user_id: Uuid) -> String {
    crate::cache::user_cache_key("tags", user_id, &[])
}

/// Drop the user's cached tag list.
async fn invalidate_tags(state: &AppState, user_id: Uuid) {
    crate::cache::cache_delete(&state.cache, &[tags_cache_key(user_id)]).await;
}

/// The `/api/tags` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tags", get(list_tags).post(create_tag))
        .route("/api/tags/", get(list_tags).post(create_tag))
        .route(
            "/api/tags/tasks/{task_id}",
            get(get_task_tags).post(assign_tag).delete(remove_tag),
        )
        .route(
            "/api/tags/{tag_id}",
            get(get_tag).patch(update_tag).delete(delete_tag),
        )
}

#[derive(Deserialize)]
struct CreateTagRequest {
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Deserialize, Default)]
struct UpdateTagRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Deserialize)]
struct TagIdQuery {
    tag_id: String,
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

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|e| e.code())
        .map(|c| c == "23505")
        .unwrap_or(false)
}

fn tag_json(id: Uuid, name: &str, color: &Option<String>) -> Value {
    json!({ "id": id.to_string(), "name": name, "color": color })
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::Unprocessable("name must not be empty".to_string()));
    }
    if name.chars().count() > TAG_NAME_MAX {
        return Err(ApiError::Unprocessable(format!(
            "name must be {TAG_NAME_MAX} characters or fewer"
        )));
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

pub(crate) async fn svc_list_tags(
    state: &AppState,
    user_id: Uuid,
) -> Result<Value, ApiError> {
    let key = tags_cache_key(user_id);
    if let Some(cached) = crate::cache::cache_get(&state.cache, &key).await {
        return Ok(cached);
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let rows = sqlx::query("SELECT id, name, color FROM tags WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            tag_json(
                row.try_get("id").unwrap(),
                &row.try_get::<String, _>("name").unwrap(),
                &row.try_get("color").unwrap(),
            )
        })
        .collect();
    tx.commit().await.map_err(db_error)?;
    let value = Value::Array(out);
    crate::cache::cache_set(&state.cache, &key, &value, TAGS_CACHE_TTL).await;
    Ok(value)
}

pub(crate) async fn svc_create_tag(
    state: &AppState,
    user_id: Uuid,
    name: String,
    color: Option<String>,
) -> Result<Value, ApiError> {
    validate_name(&name)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let row = sqlx::query(
        "INSERT INTO tags (user_id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color",
    )
    .bind(user_id)
    .bind(&name)
    .bind(&color)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| {
        if is_unique_violation(&err) {
            ApiError::Conflict("A tag with this name already exists".to_string())
        } else {
            db_error(err)
        }
    })?;
    let out = tag_json(
        row.try_get("id").unwrap(),
        &row.try_get::<String, _>("name").unwrap(),
        &row.try_get("color").unwrap(),
    );
    tx.commit().await.map_err(db_error)?;
    invalidate_tags(state, user_id).await;
    Ok(out)
}

#[allow(dead_code)]
pub(crate) async fn svc_add_tag_to_task(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    tag_name: String,
) -> Result<Value, ApiError> {
    let name = tag_name.trim();
    if name.is_empty() {
        return Err(ApiError::Unprocessable("tag_name is required".to_string()));
    }
    let name: String = name.chars().take(TAG_NAME_MAX).collect();

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    if !task_is_owned_active(&mut *tx, task_id, user_id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }

    let existing_tag = sqlx::query("SELECT id, name, color FROM tags WHERE user_id = $1 AND name = $2")
        .bind(user_id)
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    let tag = match existing_tag {
        Some(row) => tag_json(
            row.try_get("id").unwrap(),
            &row.try_get::<String, _>("name").unwrap(),
            &row.try_get("color").unwrap(),
        ),
        None => {
            let row = sqlx::query(
                "INSERT INTO tags (user_id, name, color) VALUES ($1, $2, NULL) RETURNING id, name, color",
            )
            .bind(user_id)
            .bind(&name)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
            tag_json(
                row.try_get("id").unwrap(),
                &row.try_get::<String, _>("name").unwrap(),
                &row.try_get("color").unwrap(),
            )
        }
    };
    let tag_id = Uuid::parse_str(tag.get("id").and_then(|v| v.as_str()).unwrap_or(""))
        .map_err(|_| ApiError::Internal("invalid tag id".to_string()))?;

    let existing_link =
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM task_tags WHERE task_id = $1 AND tag_id = $2")
            .bind(task_id)
            .bind(tag_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if existing_link.is_none() {
        sqlx::query("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)")
            .bind(task_id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }

    tx.commit().await.map_err(db_error)?;
    invalidate_tags(state, user_id).await;
    Ok(json!({
        "added": true,
        "task_id": task_id.to_string(),
        "tag": { "id": tag_id.to_string(), "name": name },
    }))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_tags(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_list_tags(&state, user.user_id).await?))
}

async fn create_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateTagRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_create_tag(&state, user.user_id, req.name, req.color).await?))
}

async fn get_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(tag_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let tag_id = crate::task::require_uuid(&tag_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let row = sqlx::query("SELECT id, name, color FROM tags WHERE id = $1 AND user_id = $2")
        .bind(tag_id)
        .bind(user.user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    let Some(row) = row else {
        return Err(ApiError::NotFound("Tag not found".to_string()));
    };
    let out = tag_json(
        row.try_get("id").unwrap(),
        &row.try_get::<String, _>("name").unwrap(),
        &row.try_get("color").unwrap(),
    );
    tx.commit().await.map_err(db_error)?;
    Ok(Json(out))
}

async fn update_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(tag_id): Path<String>,
    Json(req): Json<UpdateTagRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let tag_id = crate::task::require_uuid(&tag_id)?;
    if let Some(name) = &req.name {
        validate_name(name)?;
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let exists = sqlx::query_scalar::<_, i32>("SELECT 1 FROM tags WHERE id = $1 AND user_id = $2")
        .bind(tag_id)
        .bind(user.user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Tag not found".to_string()));
    }
    if let Some(name) = &req.name {
        sqlx::query("UPDATE tags SET name = $1 WHERE id = $2")
            .bind(name)
            .bind(tag_id)
            .execute(&mut *tx)
            .await
            .map_err(|err| {
                if is_unique_violation(&err) {
                    ApiError::Conflict("A tag with this name already exists".to_string())
                } else {
                    db_error(err)
                }
            })?;
    }
    if let Some(color) = &req.color {
        sqlx::query("UPDATE tags SET color = $1 WHERE id = $2")
            .bind(color)
            .bind(tag_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    let row = sqlx::query("SELECT id, name, color FROM tags WHERE id = $1")
        .bind(tag_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    let out = tag_json(
        row.try_get("id").unwrap(),
        &row.try_get::<String, _>("name").unwrap(),
        &row.try_get("color").unwrap(),
    );
    tx.commit().await.map_err(db_error)?;
    invalidate_tags(&state, user.user_id).await;
    Ok(Json(out))
}

async fn delete_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(tag_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let tag_id = crate::task::require_uuid(&tag_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let result = sqlx::query("DELETE FROM tags WHERE id = $1 AND user_id = $2")
        .bind(tag_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("Tag not found".to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    invalidate_tags(&state, user.user_id).await;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn assign_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Query(q): Query<TagIdQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let task_id = crate::task::require_uuid(&task_id)?;
    let tag_id = crate::task::require_uuid(&q.tag_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    if !task_is_owned_active(&mut *tx, task_id, user.user_id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    let tag_exists = sqlx::query_scalar::<_, i32>("SELECT 1 FROM tags WHERE id = $1 AND user_id = $2")
        .bind(tag_id)
        .bind(user.user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    if tag_exists.is_none() {
        return Err(ApiError::NotFound("Tag not found".to_string()));
    }
    let existing =
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM task_tags WHERE task_id = $1 AND tag_id = $2")
            .bind(task_id)
            .bind(tag_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if existing.is_some() {
        tx.commit().await.map_err(db_error)?;
        invalidate_tags(&state, user.user_id).await;
        return Ok(Json(json!({ "status": "already_assigned" })));
    }
    sqlx::query("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)")
        .bind(task_id)
        .bind(tag_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    invalidate_tags(&state, user.user_id).await;
    Ok(Json(json!({ "status": "assigned" })))
}

async fn remove_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Query(q): Query<TagIdQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let task_id = crate::task::require_uuid(&task_id)?;
    let tag_id = crate::task::require_uuid(&q.tag_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let result = sqlx::query("DELETE FROM task_tags WHERE task_id = $1 AND tag_id = $2")
        .bind(task_id)
        .bind(tag_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("Tag not assigned to task".to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    invalidate_tags(&state, user.user_id).await;
    Ok(Json(json!({ "status": "removed" })))
}

async fn get_task_tags(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let task_id = crate::task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    if !task_is_owned_active(&mut *tx, task_id, user.user_id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    let rows = sqlx::query(
        "SELECT t.id, t.name, t.color FROM tags t JOIN task_tags tt ON tt.tag_id = t.id \
         WHERE tt.task_id = $1",
    )
    .bind(task_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            tag_json(
                row.try_get("id").unwrap(),
                &row.try_get::<String, _>("name").unwrap(),
                &row.try_get("color").unwrap(),
            )
        })
        .collect();
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
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

    #[tokio::test]
    async fn tag_crud_and_assignment_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-tags-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let app = router()
            .merge(crate::tasks::router())
            .with_state(state.clone());

        // create
        let res = call(
            app.clone(),
            "POST",
            "/api/tags",
            &token,
            Some(json!({ "name": "Urgent", "color": "#FF0000" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        assert_eq!(created["name"], "Urgent");
        let tag_id = created["id"].as_str().unwrap().to_string();

        // duplicate -> 409
        let res = call(
            app.clone(),
            "POST",
            "/api/tags",
            &token,
            Some(json!({ "name": "Urgent" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);

        // create task (a parent task row for the assignment checks)
        let res = call(
            app.clone(),
            "POST",
            "/api/tasks",
            &token,
            Some(json!({ "title": "Tagged" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let task_id = body_json(res).await["id"].as_str().unwrap().to_string();

        // assign + list + remove
        let res = call(
            app.clone(),
            "POST",
            &format!("/api/tags/tasks/{task_id}?tag_id={tag_id}"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "assigned");

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/tags/tasks/{task_id}"),
            &token,
            None,
        )
        .await;
        let tags = body_json(res).await;
        assert!(tags.as_array().unwrap().iter().any(|t| t["id"] == tag_id));

        let res = call(
            app.clone(),
            "DELETE",
            &format!("/api/tags/tasks/{task_id}?tag_id={tag_id}"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        // rename + delete
        let res = call(
            app.clone(),
            "PATCH",
            &format!("/api/tags/{tag_id}"),
            &token,
            Some(json!({ "name": "Critical" })),
        )
        .await;
        assert_eq!(body_json(res).await["name"], "Critical");
        let res = call(app.clone(), "DELETE", &format!("/api/tags/{tag_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
