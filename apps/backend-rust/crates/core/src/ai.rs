//! AI conversation, session and memory read/delete endpoints, mirroring the
//! storage-facing parts of Python `routers/ai.py` (prefix `/api/ai`). The chat
//! conversation endpoints and the tool-loop runner are ported separately.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::{ai_conversation, ai_entitlement, ai_memory, db, error::ApiError, AppState};

const SESSIONS_LIMIT: i64 = 50;
const MEMORIES_LIMIT: i64 = 100;

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

/// The AI routes for the core (community) build.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ai/entitlement", get(entitlement))
        .route("/api/ai/sessions", get(list_sessions))
        .route("/api/ai/sessions/{session_id}", delete(delete_session))
        .route("/api/ai/conversations/{session_id}", get(get_conversation))
        .route("/api/ai/memories", get(list_memories))
        .route("/api/ai/memories/{memory_id}", delete(delete_memory))
}

/// GET /api/ai/entitlement
async fn entitlement(headers: HeaderMap, State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let ent = ai_entitlement::check_allowance(&state.pool, user.user_id).await;
    Ok(Json(json!({
        "mode": ent.mode,
        "allowance": ent.allowance,
        "used": ent.used,
        "remaining": ent.remaining,
        "blocked": ent.blocked,
    })))
}

/// GET /api/ai/sessions
async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let sessions = ai_conversation::list_sessions(&mut *tx, user.user_id, SESSIONS_LIMIT)
        .await
        .map_err(db_error)?;
    let ids: Vec<Uuid> = sessions.iter().map(|s| s.session_id).collect();
    let firsts = ai_conversation::first_user_contents(&mut *tx, user.user_id, &ids)
        .await
        .map_err(db_error)?;
    let summaries = ai_conversation::session_summaries(&mut *tx, user.user_id, &ids)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let first_map: HashMap<Uuid, String> = firsts.into_iter().collect();
    let summary_map: HashMap<Uuid, Option<String>> = summaries.into_iter().collect();

    let out: Vec<Value> = sessions
        .iter()
        .map(|session| {
            let title = first_map
                .get(&session.session_id)
                .map(|content| content.trim().chars().take(60).collect::<String>())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| "New Chat".to_string());
            json!({
                "session_id": session.session_id.to_string(),
                "title": title,
                "message_count": session.message_count,
                "last_message_at": session.last_message_at.map(|d| d.to_rfc3339()),
                "summary": summary_map
                    .get(&session.session_id)
                    .cloned()
                    .flatten(),
            })
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

/// GET /api/ai/conversations/{session_id}
async fn get_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let Ok(session_uuid) = Uuid::parse_str(&session_id) else {
        return Ok(Json(json!([])));
    };
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let rows = ai_conversation::list_conversation(&mut *tx, user.user_id, session_uuid)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "role": row.role,
                "content": row.content,
                "tool_calls": row.tool_calls,
                "created_at": row.created_at.map(|d| d.to_rfc3339()),
            })
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

/// DELETE /api/ai/sessions/{session_id}
async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    if let Ok(session_uuid) = Uuid::parse_str(&session_id) {
        let mut tx = state.pool.begin().await.map_err(db_error)?;
        db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
        ai_conversation::delete_session(&mut *tx, user.user_id, session_uuid)
            .await
            .map_err(db_error)?;
        ai_memory::purge_for_session(&mut *tx, user.user_id, session_uuid)
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
    }
    Ok(Json(json!({"deleted": true, "session_id": session_id})))
}

/// GET /api/ai/memories
async fn list_memories(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let memories = ai_memory::list_active(&mut *tx, user.user_id, MEMORIES_LIMIT)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(memories)))
}

/// DELETE /api/ai/memories/{memory_id}
async fn delete_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(memory_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let deleted = if let Ok(memory_uuid) = Uuid::parse_str(&memory_id) {
        let mut tx = state.pool.begin().await.map_err(db_error)?;
        db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
        let deleted = ai_memory::delete(&mut *tx, user.user_id, memory_uuid)
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        deleted
    } else {
        false
    };
    Ok(Json(json!({"deleted": deleted, "memory_id": memory_id})))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use sqlx::Row;
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;
    use crate::config::Settings;
    use crate::AppState;

    async fn live_state() -> Option<AppState> {
        let database_url = std::env::var("DATABASE_URL").ok()?;
        let settings = Settings {
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

    fn app(state: &AppState) -> axum::Router {
        super::router().with_state(state.clone())
    }

    async fn call(app: &axum::Router, method: &str, uri: &str, token: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", format!("access_token={token}"))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn ai_history_and_memories_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-ai-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let session = Uuid::new_v4();

        let mut conn = state.pool.acquire().await.unwrap();
        ai_conversation::insert_conversation(
            &mut *conn,
            user.id,
            session,
            "user",
            "Plan my week",
            None,
        )
        .await
        .unwrap();
        ai_conversation::insert_conversation(
            &mut *conn,
            user.id,
            session,
            "assistant",
            "Sure, here is a plan",
            None,
        )
        .await
        .unwrap();
        ai_conversation::create_summary_if_missing(&mut *conn, user.id, session)
            .await
            .unwrap();
        let memory_id: Uuid = sqlx::query(
            "INSERT INTO ai_memories (user_id, content, category, source_session_id, is_active) \
             VALUES ($1, 'Likes mornings', 'preference', $2, true) RETURNING id",
        )
        .bind(user.id)
        .bind(session)
        .fetch_one(&mut *conn)
        .await
        .unwrap()
        .get("id");
        drop(conn);

        let app = app(&state);

        let (status, sessions) = call(&app, "GET", "/api/ai/sessions", &token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sessions[0]["title"], "Plan my week");
        assert_eq!(sessions[0]["message_count"], 2);

        let (status, conv) = call(
            &app,
            "GET",
            &format!("/api/ai/conversations/{session}"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(conv.as_array().unwrap().len(), 2);

        let (status, memories) = call(&app, "GET", "/api/ai/memories", &token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(memories.as_array().unwrap().len(), 1);

        let (status, _) = call(
            &app,
            "DELETE",
            &format!("/api/ai/sessions/{session}"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (_, memories_after) = call(&app, "GET", "/api/ai/memories", &token).await;
        assert_eq!(memories_after.as_array().unwrap().len(), 0);

        let (_, remaining) = call(&app, "GET", "/api/ai/sessions", &token).await;
        assert_eq!(remaining.as_array().unwrap().len(), 0);

        let _ = memory_id;
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn entitlement_reports_community_byok() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-ai-ent-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let (status, body) = call(&app(&state), "GET", "/api/ai/entitlement", &token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "byok");
        assert_eq!(body["remaining"], Value::Null);
        assert_eq!(body["blocked"], false);
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
