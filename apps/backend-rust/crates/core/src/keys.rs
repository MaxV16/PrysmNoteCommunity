//! BYOK API key endpoints (`/api/keys`).
//!
//! Mirrors Python `routers/keys.py`: users store their own provider keys
//! (encrypted at rest), re-read them for the client cache, and can validate a
//! key by asking the provider's models endpoint.

use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api_key::{self, ApiKey};
use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::llm::BYOK_PROVIDERS;
use crate::ratelimit::RateLimiter;
use crate::AppState;

const TEST_KEY_LIMIT: u32 = 10;
const TEST_KEY_WINDOW: Duration = Duration::from_secs(60);

fn test_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:keys"))
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn valid_providers_label() -> String {
    let mut providers = BYOK_PROVIDERS.to_vec();
    providers.sort_unstable();
    providers.join(", ")
}

fn validate_provider(provider: &str) -> Result<(), ApiError> {
    if BYOK_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(ApiError::Unprocessable(format!(
            "Invalid provider. Must be one of: {}",
            valid_providers_label()
        )))
    }
}

fn validate_api_key(api_key: &str) -> Result<(), ApiError> {
    let trimmed = api_key.trim();
    if trimmed.chars().count() < 8 {
        return Err(ApiError::Unprocessable("API key too short".to_string()));
    }
    if trimmed.chars().count() > 256 {
        return Err(ApiError::Unprocessable("API key too long".to_string()));
    }
    Ok(())
}

fn key_json(key: &ApiKey) -> Value {
    json!({
        "id": key.id.to_string(),
        "provider": key.provider,
        "key_prefix": key.key_prefix.clone().unwrap_or_default(),
        "is_active": key.is_active,
    })
}

#[derive(Deserialize)]
struct SaveKeyRequest {
    provider: String,
    api_key: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/keys", get(list_keys).post(save_key))
        .route("/api/keys/", get(list_keys).post(save_key))
        .route("/api/keys/sync", axum::routing::post(sync_key))
        .route("/api/keys/test", axum::routing::post(test_key))
        .route("/api/keys/{provider}/key", get(get_provider_key))
        .route("/api/keys/{key_id}", axum::routing::delete(delete_key))
}

async fn list_keys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let keys = api_key::list_for_user(&state.pool, user.user_id)
        .await
        .map_err(db_error)?;
    let out: Vec<Value> = keys.iter().map(key_json).collect();
    Ok(Json(Value::Array(out)))
}

async fn get_provider_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(provider): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let user = require_user(&state, &headers)?;
    if !BYOK_PROVIDERS.contains(&provider.as_str()) {
        return Err(ApiError::BadRequest("Invalid provider".to_string()));
    }
    let key = api_key::get_active_by_provider(&state.pool, user.user_id, &provider)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("No key stored for this provider".to_string()))?;
    let decrypted = api_key::decrypt(&key, &state.settings.encryption_key)
        .map_err(|_| ApiError::Internal("could not decrypt the stored key".to_string()))?;
    let mut response = Json(json!({ "provider": provider, "api_key": decrypted })).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

async fn save_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SaveKeyRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    validate_provider(&request.provider)?;
    validate_api_key(&request.api_key)?;
    let trimmed = request.api_key.trim();
    api_key::upsert(
        &state.pool,
        user.user_id,
        &request.provider,
        trimmed,
        &state.settings.encryption_key,
    )
    .await
    .map_err(|_| ApiError::Internal("could not encrypt the key".to_string()))?;
    Ok(Json(json!({ "status": "saved", "provider": request.provider })))
}

async fn sync_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SaveKeyRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    validate_provider(&request.provider)?;
    validate_api_key(&request.api_key)?;
    let trimmed = request.api_key.trim();
    api_key::upsert(
        &state.pool,
        user.user_id,
        &request.provider,
        trimmed,
        &state.settings.encryption_key,
    )
    .await
    .map_err(|_| ApiError::Internal("could not encrypt the key".to_string()))?;
    Ok(Json(json!({ "status": "synced", "provider": request.provider })))
}

async fn test_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SaveKeyRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    validate_provider(&request.provider)?;
    validate_api_key(&request.api_key)?;
    if test_limiter()
        .count(&user.user_id.to_string(), TEST_KEY_WINDOW)
        .await
        > TEST_KEY_LIMIT
    {
        return Err(ApiError::TooManyRequests(
            "Too many key tests - try again shortly".to_string(),
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let key = request.api_key.trim();
    let result = match request.provider.as_str() {
        "openai" => probe(&client, "https://api.openai.com/v1/models", Some(key)).await,
        "deepseek" => probe(&client, "https://api.deepseek.com/v1/models", Some(key)).await,
        "openrouter" => probe(&client, "https://openrouter.ai/api/v1/models", Some(key)).await,
        "gemini" => {
            let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={key}");
            probe(&client, &url, None).await
        }
        other => Ok(json!({ "valid": false, "error": format!("Unknown provider: {other}") })),
    };
    let value = match result {
        Ok(value) => value,
        Err(err) => return Ok(Json(err)),
    };
    Ok(Json(value))
}

/// Probe a models endpoint. Returns `{valid, error}` or a timeout/network error
/// object (never a 5xx), mirroring the Python handler.
async fn probe(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
) -> Result<Value, Value> {
    let mut request = client.get(url).header("accept", "application/json");
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if status == StatusCode::OK {
                Ok(json!({ "valid": true, "error": Value::Null }))
            } else {
                Ok(json!({ "valid": false, "error": format!("HTTP {}", status.as_u16()) }))
            }
        }
        Err(err) => {
            if err.is_timeout() {
                Ok(json!({ "valid": false, "error": "Request timed out - check network connectivity" }))
            } else {
                tracing::warn!(error = %err, "key test failed");
                Ok(json!({ "valid": false, "error": "Could not validate the key - please try again" }))
            }
        }
    }
}

async fn delete_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = Uuid::parse_str(&key_id)
        .map_err(|_| ApiError::NotFound("Key not found".to_string()))?;
    if !api_key::delete(&state.pool, user.user_id, id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Key not found".to_string()));
    }
    Ok(Json(json!({ "status": "deleted" })))
}

use axum::response::IntoResponse;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let mut settings = crate::config::Settings::from_env();
        settings.database_url = url;
        settings.jwt_secret_key = "test-secret-key-that-is-at-least-32-chars!".to_string();
        settings.encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=".to_string();
        settings.csrf_enabled = false;
        settings.api_rate_limit_enabled = false;
        Some(AppState::lazy(settings))
    }

    async fn call(app: axum::Router, method: &str, uri: &str, token: Option<&str>, body: Option<Value>) -> axum::response::Response {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(value) => builder
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        app.oneshot(request).await.unwrap()
    }

    async fn body_json(response: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn token_for(state: &AppState, user_id: Uuid) -> String {
        crate::jwt::encode_access(&state.settings.jwt_secret_key, &user_id.to_string(), 0).unwrap()
    }

    #[tokio::test]
    async fn saves_lists_reads_and_deletes_a_key() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-keys-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = token_for(&state, user.id);
        let app = router().with_state(state.clone());

        let saved = call(
            app.clone(),
            "POST",
            "/api/keys/",
            Some(&token),
            Some(json!({ "provider": "openai", "api_key": "sk-test-1234567890" })),
        )
        .await;
        assert_eq!(saved.status(), StatusCode::OK);
        let saved = body_json(saved).await;
        assert_eq!(saved["status"], "saved");

        let listed = body_json(call(app.clone(), "GET", "/api/keys", Some(&token), None).await).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["provider"], "openai");
        assert_eq!(listed[0]["key_prefix"], "sk-test-");

        let fetched = call(app.clone(), "GET", "/api/keys/openai/key", Some(&token), None).await;
        assert_eq!(fetched.status(), StatusCode::OK);
        assert_eq!(fetched.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let fetched = body_json(fetched).await;
        assert_eq!(fetched["api_key"], "sk-test-1234567890");

        let key_id = listed[0]["id"].as_str().unwrap().to_string();
        let deleted = call(
            app.clone(),
            "DELETE",
            &format!("/api/keys/{key_id}"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::OK);

        let missing = call(app.clone(), "GET", "/api/keys/openai/key", Some(&token), None).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .ok();
    }

    #[tokio::test]
    async fn rejects_bad_provider_and_short_key() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-keys-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = token_for(&state, user.id);
        let app = router().with_state(state.clone());

        let bad_provider = call(
            app.clone(),
            "POST",
            "/api/keys/",
            Some(&token),
            Some(json!({ "provider": "anthropic", "api_key": "sk-test-1234567890" })),
        )
        .await;
        assert_eq!(bad_provider.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let short = call(
            app.clone(),
            "POST",
            "/api/keys/",
            Some(&token),
            Some(json!({ "provider": "openai", "api_key": "short" })),
        )
        .await;
        assert_eq!(short.status(), StatusCode::UNPROCESSABLE_ENTITY);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .ok();
    }
}
