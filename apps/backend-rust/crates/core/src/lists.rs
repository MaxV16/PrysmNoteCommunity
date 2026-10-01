//! `/api/lists` routes: per-user task lists with the protected default list.
//!
//! Mirrors the Python `routers/lists.py` contract: GET ensures the user's
//! default "My Tasks" list exists, the default list cannot be renamed or
//! deleted, and deleting any other list moves its tasks back to the default.
//! The list is served through the cache-aside store (Redis when configured,
//! otherwise in-process) with a 30 second TTL; every write invalidates it.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::db;
use crate::error::ApiError;
use crate::task::DEFAULT_LIST_NAME;
use crate::AppState;

const LIST_NAME_MAX: usize = 200;
const LIST_LIMIT: i64 = 200;
const LISTS_CACHE_TTL: u64 = 30;

/// The cache key for a user's list collection.
fn lists_cache_key(user_id: Uuid) -> String {
    crate::cache::user_cache_key("lists", user_id, &[])
}

/// Drop the user's cached list collection.
async fn invalidate_lists(state: &AppState, user_id: Uuid) {
    crate::cache::cache_delete(&state.cache, &[lists_cache_key(user_id)]).await;
}

/// The `/api/lists` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/lists", get(list_lists).post(create_list))
        .route("/api/lists/", get(list_lists).post(create_list))
        .route("/api/lists/{list_id}", axum::routing::patch(update_list).delete(delete_list))
}

#[derive(Deserialize)]
struct CreateListRequest {
    name: String,
}

#[derive(Deserialize, Default)]
struct UpdateListRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    position: Option<i32>,
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

fn list_json(row: &sqlx::postgres::PgRow) -> Value {
    let created: Option<chrono::DateTime<chrono::Utc>> = row.try_get("created_at").unwrap();
    let updated: Option<chrono::DateTime<chrono::Utc>> = row.try_get("updated_at").unwrap();
    json!({
        "id": row.try_get::<Uuid, _>("id").unwrap().to_string(),
        "name": row.try_get::<String, _>("name").unwrap(),
        "position": row.try_get::<i32, _>("position").unwrap(),
        "created_at": created.map(|d| d.to_rfc3339()),
        "updated_at": updated.map(|d| d.to_rfc3339()),
    })
}

fn default_list_name(name: &str) -> bool {
    name == DEFAULT_LIST_NAME
}

async fn get_owned_list(
    conn: &mut sqlx::PgConnection,
    list_id: Uuid,
    user_id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT id, name, position, created_at, updated_at FROM lists WHERE id = $1 AND user_id = $2")
        .bind(list_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_lists(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let key = lists_cache_key(user.user_id);
    if let Some(cached) = crate::cache::cache_get(&state.cache, &key).await {
        return Ok(Json(cached));
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    crate::task::default_list_id(&mut *tx, user.user_id).await.map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT id, name, position, created_at, updated_at FROM lists WHERE user_id = $1 \
         ORDER BY position, created_at",
    )
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let out: Vec<Value> = rows.iter().map(list_json).collect();
    tx.commit().await.map_err(db_error)?;
    let value = Value::Array(out);
    crate::cache::cache_set(&state.cache, &key, &value, LISTS_CACHE_TTL).await;
    Ok(Json(value))
}

async fn create_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateListRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::Unprocessable("Name is required".to_string()));
    }
    if name.chars().count() > LIST_NAME_MAX {
        return Err(ApiError::Unprocessable(
            "Name must be at most 200 characters".to_string(),
        ));
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lists WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    if count >= LIST_LIMIT {
        return Err(ApiError::BadRequest("List limit reached (200)".to_string()));
    }
    let max_pos: Option<i32> =
        sqlx::query_scalar("SELECT MAX(position) FROM lists WHERE user_id = $1")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
    let row = sqlx::query(
        "INSERT INTO lists (user_id, name, position) VALUES ($1, $2, $3) \
         RETURNING id, name, position, created_at, updated_at",
    )
    .bind(user.user_id)
    .bind(&name)
    .bind(max_pos.unwrap_or(0) + 1)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let out = list_json(&row);
    tx.commit().await.map_err(db_error)?;
    invalidate_lists(&state, user.user_id).await;
    Ok(Json(out))
}

async fn update_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(list_id): Path<String>,
    Json(req): Json<UpdateListRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let list_id = require_uuid(&list_id)?;
    if let Some(name) = &req.name {
        if name.trim().is_empty() {
            return Err(ApiError::Unprocessable("Name must not be empty".to_string()));
        }
        if name.chars().count() > LIST_NAME_MAX {
            return Err(ApiError::Unprocessable(
                "Name must be at most 200 characters".to_string(),
            ));
        }
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let Some(row) = get_owned_list(&mut *tx, list_id, user.user_id)
        .await
        .map_err(db_error)?
    else {
        return Err(ApiError::NotFound("List not found".to_string()));
    };
    let current_name: String = row.try_get("name").unwrap();
    if req.name.is_some() && default_list_name(&current_name) {
        return Err(ApiError::Forbidden(
            "The default \"My Tasks\" list cannot be renamed".to_string(),
        ));
    }
    if let Some(name) = &req.name {
        sqlx::query("UPDATE lists SET name = $1 WHERE id = $2")
            .bind(name)
            .bind(list_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(position) = req.position {
        sqlx::query("UPDATE lists SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(list_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    let row = get_owned_list(&mut *tx, list_id, user.user_id)
        .await
        .map_err(db_error)?
        .expect("list row still present");
    let out = list_json(&row);
    tx.commit().await.map_err(db_error)?;
    invalidate_lists(&state, user.user_id).await;
    Ok(Json(out))
}

async fn delete_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(list_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let list_id = require_uuid(&list_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let Some(row) = get_owned_list(&mut *tx, list_id, user.user_id)
        .await
        .map_err(db_error)?
    else {
        return Err(ApiError::NotFound("List not found".to_string()));
    };
    let current_name: String = row.try_get("name").unwrap();
    if default_list_name(&current_name) {
        return Err(ApiError::Forbidden(
            "The default \"My Tasks\" list cannot be deleted".to_string(),
        ));
    }
    let default_id = crate::task::default_list_id(&mut *tx, user.user_id)
        .await
        .map_err(db_error)?;
    sqlx::query("UPDATE tasks SET list_id = $1 WHERE list_id = $2 AND user_id = $3")
        .bind(default_id)
        .bind(list_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("DELETE FROM lists WHERE id = $1")
        .bind(list_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    invalidate_lists(&state, user.user_id).await;
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

    #[tokio::test]
    async fn default_list_is_protected_and_creation_works() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-lists-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let app = router().with_state(state.clone());

        // GET ensures the default list exists
        let res = call(app.clone(), "GET", "/api/lists", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let lists = body_json(res).await;
        let default = lists
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["name"] == "My Tasks")
            .unwrap()
            .clone();
        let default_id = default["id"].as_str().unwrap().to_string();

        // default list cannot be renamed or deleted
        let res = call(
            app.clone(),
            "PATCH",
            &format!("/api/lists/{default_id}"),
            &token,
            Some(json!({ "name": "Renamed" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = call(app.clone(), "DELETE", &format!("/api/lists/{default_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // create + delete a normal list
        let res = call(
            app.clone(),
            "POST",
            "/api/lists",
            &token,
            Some(json!({ "name": "Work" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let work_id = body_json(res).await["id"].as_str().unwrap().to_string();
        let res = call(app.clone(), "DELETE", &format!("/api/lists/{work_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
