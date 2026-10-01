//! Sticky notes, mirroring the Python `/api/notes` router. Note ids are
//! client-generated strings (<= 64 chars), not uuids.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::{db, AppState};

const NOTE_ID_MAX: usize = 64;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/", get(list_notes).post(create_note))
        .route("/api/notes/{note_id}", axum::routing::patch(update_note).delete(delete_note))
}

#[derive(Deserialize)]
struct NotePayload {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default = "default_color")]
    color: String,
    #[serde(default = "default_x")]
    x: f64,
    #[serde(default = "default_y")]
    y: f64,
    #[serde(default = "default_width")]
    width: f64,
    #[serde(default = "default_height")]
    height: f64,
    #[serde(default)]
    minimized: bool,
    #[serde(default)]
    open: bool,
    #[serde(default)]
    sort: i32,
}

#[derive(Deserialize)]
struct NoteUpdate {
    title: Option<String>,
    content: Option<String>,
    color: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    minimized: Option<bool>,
    open: Option<bool>,
    sort: Option<i32>,
}

fn default_color() -> String {
    "#fbbf24".to_string()
}
fn default_x() -> f64 {
    300.0
}
fn default_y() -> f64 {
    200.0
}
fn default_width() -> f64 {
    320.0
}
fn default_height() -> f64 {
    240.0
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

type NoteRow = (
    String,
    String,
    String,
    String,
    f64,
    f64,
    f64,
    f64,
    bool,
    bool,
    i32,
    Option<chrono::DateTime<chrono::Utc>>,
);

fn note_json(row: &NoteRow) -> Value {
    json!({
        "id": row.0,
        "title": row.1,
        "content": row.2,
        "color": row.3,
        "x": row.4,
        "y": row.5,
        "width": row.6,
        "height": row.7,
        "minimized": row.8,
        "open": row.9,
        "sort": row.10,
        "updated_at": row.11.map(|d| d.to_rfc3339()),
    })
}

async fn fetch_note(conn: &mut sqlx::PgConnection, note_id: &str, user_id: uuid::Uuid) -> Result<Option<NoteRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, title, content, color, x, y, width, height, minimized, open, sort, updated_at
         FROM notes WHERE id = $1 AND user_id = $2",
    )
    .bind(note_id)
    .bind(user_id)
    .fetch_optional(conn)
    .await?;

    Ok(row.map(|row| {
        (
            row.try_get("id").unwrap(),
            row.try_get("title").unwrap(),
            row.try_get("content").unwrap(),
            row.try_get("color").unwrap(),
            row.try_get("x").unwrap(),
            row.try_get("y").unwrap(),
            row.try_get("width").unwrap(),
            row.try_get("height").unwrap(),
            row.try_get("minimized").unwrap(),
            row.try_get("open").unwrap(),
            row.try_get("sort").unwrap(),
            row.try_get("updated_at").unwrap(),
        )
    }))
}

async fn list_notes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let rows = sqlx::query(
        "SELECT id, title, content, color, x, y, width, height, minimized, open, sort, updated_at
         FROM notes WHERE user_id = $1 ORDER BY sort ASC, updated_at DESC",
    )
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            note_json(&(
                row.try_get("id").unwrap(),
                row.try_get("title").unwrap(),
                row.try_get("content").unwrap(),
                row.try_get("color").unwrap(),
                row.try_get("x").unwrap(),
                row.try_get("y").unwrap(),
                row.try_get("width").unwrap(),
                row.try_get("height").unwrap(),
                row.try_get("minimized").unwrap(),
                row.try_get("open").unwrap(),
                row.try_get("sort").unwrap(),
                row.try_get("updated_at").unwrap(),
            ))
        })
        .collect();

    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(items)))
}

async fn create_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<NotePayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    if payload.id.is_empty() || payload.id.chars().count() > NOTE_ID_MAX {
        return Err(ApiError::Unprocessable("id must be at most 64 characters".to_string()));
    }

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let existing = fetch_note(&mut *tx, &payload.id, user.user_id)
        .await
        .map_err(db_error)?;
    if existing.is_some() {
        tx.rollback().await.ok();
        return Err(ApiError::Conflict("Note already exists".to_string()));
    }

    sqlx::query(
        "INSERT INTO notes (id, user_id, title, content, color, x, y, width, height, minimized, open, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    .bind(&payload.id)
    .bind(user.user_id)
    .bind(&payload.title)
    .bind(&payload.content)
    .bind(&payload.color)
    .bind(payload.x)
    .bind(payload.y)
    .bind(payload.width)
    .bind(payload.height)
    .bind(payload.minimized)
    .bind(payload.open)
    .bind(payload.sort)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;

    let note = fetch_note(&mut *tx, &payload.id, user.user_id)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let note = note.ok_or_else(|| ApiError::Internal("note vanished".to_string()))?;
    Ok(Json(note_json(&note)))
}

async fn update_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
    Json(payload): Json<NoteUpdate>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    if fetch_note(&mut *tx, &note_id, user.user_id)
        .await
        .map_err(db_error)?
        .is_none()
    {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Note not found".to_string()));
    }

    if let Some(title) = &payload.title {
        sqlx::query("UPDATE notes SET title = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(title)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(content) = &payload.content {
        sqlx::query("UPDATE notes SET content = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(content)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(color) = &payload.color {
        sqlx::query("UPDATE notes SET color = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(color)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(x) = payload.x {
        sqlx::query("UPDATE notes SET x = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(x)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(y) = payload.y {
        sqlx::query("UPDATE notes SET y = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(y)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(width) = payload.width {
        sqlx::query("UPDATE notes SET width = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(width)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(height) = payload.height {
        sqlx::query("UPDATE notes SET height = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(height)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(minimized) = payload.minimized {
        sqlx::query("UPDATE notes SET minimized = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(minimized)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(open) = payload.open {
        sqlx::query("UPDATE notes SET open = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(open)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(sort) = payload.sort {
        sqlx::query("UPDATE notes SET sort = $1, updated_at = now() WHERE id = $2 AND user_id = $3")
            .bind(sort)
            .bind(&note_id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }

    let note = fetch_note(&mut *tx, &note_id, user.user_id)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let note = note.ok_or_else(|| ApiError::Internal("note vanished".to_string()))?;
    Ok(Json(note_json(&note)))
}

async fn delete_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let result = sqlx::query("DELETE FROM notes WHERE id = $1 AND user_id = $2")
        .bind(&note_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    if result.rows_affected() == 0 {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Note not found".to_string()));
    }

    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted" })))
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
    async fn note_crud_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-notes-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());
        let note_id = format!("note-{}", uuid::Uuid::new_v4());

        let res = call(
            &app,
            "POST",
            "/api/notes",
            &token,
            Some(json!({"id": note_id, "title": "Hello", "content": "World"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        let res = call(
            &app,
            "POST",
            "/api/notes",
            &token,
            Some(json!({"id": note_id})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);

        let res = call(&app, "PATCH", &format!("/api/notes/{note_id}"), &token, Some(json!({"title": "Updated", "x": 12.5}))).await;
        assert_eq!(res.status(), StatusCode::OK);
        let updated = body_json(res).await;
        assert_eq!(updated["title"], json!("Updated"));
        assert_eq!(updated["x"], json!(12.5));

        let res = call(&app, "GET", "/api/notes", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let listed = body_json(res).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let res = call(&app, "DELETE", &format!("/api/notes/{note_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let res = call(&app, "DELETE", &format!("/api/notes/{note_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
