//! `/api/tokens` routes: Personal Access Token management for the MCP server.
//!
//! Core and ungated: creating a token is a normal user action. The MCP server
//! itself enforces the subscription gate (via `is_premium`) when a token is
//! actually used, so token management stays available to every signed-in user.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

use crate::api_token;
use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::ratelimit::RateLimiter;
use crate::AppState;

/// Token creation window (one hour) and cap, matching Python's `rl:pat_create`.
const CREATE_WINDOW: Duration = Duration::from_secs(3600);
const CREATE_LIMIT: u32 = 10;

fn create_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:pat_create"))
}

#[derive(Deserialize, Default)]
pub struct TokenCreateRequest {
    #[serde(default)]
    pub name: Option<String>,
}

/// The `/api/tokens` sub-router, mounted into the core router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tokens", get(list_tokens).post(create_token))
        .route("/api/tokens/", get(list_tokens).post(create_token))
        .route("/api/tokens/{token_id}", axum::routing::delete(revoke_token))
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

async fn create_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TokenCreateRequest>,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers)?;

    let ip = crate::middleware::client_ip(&headers);
    let key = format!("user:{}:ip:{}", user.user_id, ip);
    if create_limiter().count(&key, CREATE_WINDOW).await > CREATE_LIMIT {
        return Err(ApiError::TooManyRequests(
            "Too many tokens created. Try again later.".into(),
        ));
    }

    let name = req.name.as_deref().map(str::trim).filter(|n| !n.is_empty());

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    crate::db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let (raw, row) = api_token::create_token(&mut *tx, user.user_id, name)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let body = json!({
        "id": row.id,
        "name": row.name,
        "prefix": row.prefix,
        "created_at": row.created_at.map(|t| t.to_rfc3339()),
        "plaintext": raw,
    });
    Ok((StatusCode::CREATED, Json(body)).into_response())
}

async fn list_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    crate::db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let rows = api_token::list_tokens(&mut *tx, user.user_id)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let tokens: Vec<Value> = rows.iter().map(api_token::token_public).collect();
    Ok(Json(json!({ "tokens": tokens })))
}

async fn revoke_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = crate::task::require_uuid(&token_id)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    crate::db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    api_token::revoke_token(&mut *tx, id, user.user_id).await?;
    tx.commit().await.map_err(db_error)?;

    Ok(Json(json!({ "revoked": true, "id": token_id })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use crate::config;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let mut settings = config::tests::sample("test");
        settings.database_url = url;
        Some(AppState::lazy(settings))
    }

    async fn call(app: &Router, method: &str, uri: &str, token: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", format!("access_token={token}"));
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        let request = builder
            .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
        let res = app.clone().oneshot(request).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn create_list_and_revoke_a_token() {
        let Some(state) = live_state() else {
            return;
        };
        let email = format!("rust-tokens-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let app = router().with_state(state.clone());

        let (status, created) = call(
            &app,
            "POST",
            "/api/tokens",
            &token,
            Some(json!({ "name": "My MCP token" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["name"], "My MCP token");
        let plaintext = created["plaintext"].as_str().unwrap().to_string();
        assert!(plaintext.starts_with(api_token::TOKEN_PREFIX));
        let id = created["id"].as_str().unwrap().to_string();

        let (status, listed) = call(&app, "GET", "/api/tokens", &token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["tokens"].as_array().unwrap().len(), 1);

        let (status, revoked) =
            call(&app, "DELETE", &format!("/api/tokens/{id}"), &token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["revoked"], true);

        // Revoking again is a no-op that still succeeds (row exists, owned).
        let (status, _) =
            call(&app, "DELETE", &format!("/api/tokens/{id}"), &token, None).await;
        assert_eq!(status, StatusCode::OK);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .expect("cleanup");
    }
}
