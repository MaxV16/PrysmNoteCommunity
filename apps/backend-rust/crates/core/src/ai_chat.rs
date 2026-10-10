//! AI chat endpoints (Unit C of the Rust port): `POST /api/ai/chat`,
//! `POST /api/ai/chat/stream`, plus turn status/cancel.
//!
//! Mirrors Python `apps/backend/app/routers/ai.py`: the non-streaming handler
//! runs the tool round loop inline and returns the final reply; the streaming
//! handler registers a background turn (via [`crate::ai_turn_runner`]) and relays
//! its events as an SSE `text/event-stream`.

use std::convert::Infallible;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::error::ApiError;
use crate::llm::LlmClient;
use crate::ratelimit::RateLimiter;
use crate::{
    ai_conversation, ai_entitlement, ai_execute, ai_prompt, ai_prompts, ai_region, ai_text,
    ai_tools, ai_turn_runner, api_key, auth, db, memory_service, AppState,
};

/// Prior turns kept from the client-supplied history.
const MAX_CHAT_HISTORY: usize = 20;
/// Per-message character cap applied to the sanitized history.
const MAX_MESSAGE_LENGTH: usize = 4000;
/// AI requests allowed per user per window.
const AI_RATE_MAX: u32 = 30;
/// AI rate-limit window.
const AI_RATE_WINDOW: Duration = Duration::from_secs(60);

fn ai_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:ai"))
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<auth::AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

/// Same 429 shape and semantics as the Python `_check_ai_rate_limit`.
async fn check_ai_rate_limit(user_id: Uuid) -> Result<(), ApiError> {
    let count = ai_limiter()
        .count(&format!("ai:{user_id}"), AI_RATE_WINDOW)
        .await;
    if count > AI_RATE_MAX {
        return Err(ApiError::TooManyRequests(format!(
            "Rate limit exceeded ({AI_RATE_MAX}/min). Please try again later."
        )));
    }
    Ok(())
}

/// The chat request body, matching the Python `ChatRequest` model.
#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub chat_history: Vec<Value>,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub context: Option<Value>,
}

pub(crate) fn default_provider() -> String {
    "openai".to_string()
}

/// Extend the core ai router with the chat endpoints.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ai/chat", post(chat))
        .route("/api/ai/chat/stream", post(chat_stream))
        .route("/api/ai/turn/status", get(turn_status))
        .route("/api/ai/turn/cancel", post(turn_cancel))
        .route("/api/ai/turn/answer-now", post(turn_answer_now))
}

/// Keep at most the last 20 user/assistant turns, each capped at 4000 chars
/// (mirrors Python `_sanitize_chat_history`).
pub fn sanitize_chat_history(chat_history: &[Value]) -> Vec<Value> {
    let start = chat_history.len().saturating_sub(MAX_CHAT_HISTORY);
    let mut out = Vec::new();
    for message in &chat_history[start..] {
        let Some(obj) = message.as_object() else {
            continue;
        };
        let role = obj.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let content: String = match obj.get("content").and_then(|c| c.as_str()) {
            Some(text) => text.chars().take(MAX_MESSAGE_LENGTH).collect(),
            None => obj
                .get("content")
                .map(|c| c.to_string().chars().take(MAX_MESSAGE_LENGTH).collect())
                .unwrap_or_default(),
        };
        out.push(json!({ "role": role, "content": content }));
    }
    out
}

/// Resolve `(primary, fallbacks)` from the request's `cf-ipcountry`.
pub(crate) fn resolve_chain(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, Vec<String>), ApiError> {
    let country = headers.get("cf-ipcountry").and_then(|v| v.to_str().ok());
    ai_region::resolve_ai_chain(&state.settings, country)
        .map_err(|_| ApiError::Forbidden("PrysmAI is not available in your region.".to_string()))
}

/// Resolve `(provider, api_key, chain)` for a chat request, mirroring Python
/// `resolve_llm_key`. In the community build `prysmai` is always unavailable
/// (no hosted entitlement) and BYOK is always allowed.
pub async fn resolve_llm_key(
    state: &AppState,
    user_id: Uuid,
    provider: &str,
    headers: &HeaderMap,
) -> Result<(String, String, Option<(String, Vec<String>)>), ApiError> {
    if provider == "prysmai" {
        let ent = ai_entitlement::check_allowance(&state.pool, user_id).await;
        if ent.mode != "prysmai" {
            return Err(ApiError::Forbidden(
                "PrysmAI requires an active plan or the 14-day free trial.".to_string(),
            ));
        }
        if ent.blocked {
            return Err(ApiError::PaymentRequired(
                "Your PrysmAI token allowance is used up for this month. \
Upgrade your plan or wait for it to reset."
                    .to_string(),
            ));
        }
        let chain = resolve_chain(state, headers)?;
        let server_key = std::env::var("OPENROUTER_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok().filter(|s| !s.is_empty()));
        let Some(key) = server_key else {
            return Err(ApiError::ServiceUnavailable(
                "PrysmAI is not configured on this server yet.".to_string(),
            ));
        };
        return Ok((provider.to_string(), key, Some(chain)));
    }

    // Community build: BYOK only, unlimited, no premium tier to gate on.
    let stored = api_key::get_active_by_provider(&state.pool, user_id, provider)
        .await
        .map_err(db_error)?;
    let decrypted = stored.and_then(|key| api_key::decrypt(&key, &state.settings.encryption_key).ok());
    match decrypted {
        Some(key) if !key.is_empty() => Ok((provider.to_string(), key, None)),
        _ => Err(ApiError::BadRequest(
            "Please provide an API key in Settings.".to_string(),
        )),
    }
}

/// Build the provider client (feeding the model chain to hosted PrysmAI).
pub fn build_llm_client(
    state: &AppState,
    provider: &str,
    api_key: &str,
    chain: Option<(String, Vec<String>)>,
) -> Result<LlmClient, ApiError> {
    if provider == "prysmai" {
        if let Some((primary, fallbacks)) = chain {
            return Ok(LlmClient::prysm_ai(
                api_key,
                &state.settings.prysm_ai_base_url(),
                &primary,
                fallbacks,
                state.settings.prysm_ai_zdr(),
            ));
        }
    }
    LlmClient::new(provider, api_key)
        .map_err(|_| ApiError::BadRequest("Please provide an API key in Settings.".to_string()))
}

fn build_bumped_client(
    state: &AppState,
    api_key: &str,
    chain_list: &[String],
    index: usize,
) -> Result<LlmClient, ApiError> {
    let primary = chain_list.get(index).cloned().unwrap_or_default();
    let fallbacks = if index + 1 < chain_list.len() {
        chain_list[index + 1..].to_vec()
    } else {
        Vec::new()
    };
    Ok(LlmClient::prysm_ai(
        api_key,
        &state.settings.prysm_ai_base_url(),
        &primary,
        fallbacks,
        state.settings.prysm_ai_zdr(),
    ))
}

async fn load_summary_and_memories(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
    user_message: &str,
) -> Result<(Option<String>, Vec<String>), ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let summary = ai_conversation::get_summary(&mut *tx, user_id, session_id)
        .await
        .map_err(db_error)?;
    let memories = memory_service::retrieve_relevant_memories(&mut *tx, user_id, user_message)
        .await
        .unwrap_or_default();
    tx.commit().await.map_err(db_error)?;
    Ok((summary, memories))
}

pub async fn record_response_usage(
    state: &AppState,
    user_id: Uuid,
    provider: &str,
    response: &Value,
) -> Result<(), ApiError> {
    if provider != "prysmai" {
        return Ok(());
    }
    let usage = ai_entitlement::parse_usage(response);
    if usage.input == 0 && usage.output == 0 {
        return Ok(());
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    ai_entitlement::record_usage_conn(
        &mut *tx,
        user_id,
        "prysmai",
        usage.input,
        usage.output,
        usage.cached_input,
    )
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(())
}

/// POST /api/ai/chat - non-streaming tool-loop completion.
async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    check_ai_rate_limit(user.user_id).await?;

    if ai_turn_runner::get_active_turn(user.user_id).is_some() {
        return Err(ApiError::Conflict(
            "Prysm AI is still working on your previous request. Please wait a moment.".to_string(),
        ));
    }

    let (provider, api_key, chain) =
        resolve_llm_key(&state, user.user_id, &req.provider, &headers).await?;
    let session_id = req
        .session_id
        .as_deref()
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_else(Uuid::new_v4);
    let mut client = build_llm_client(&state, &provider, &api_key, chain.clone())?;

    let sanitized = sanitize_chat_history(&req.chat_history);
    let (current_summary, memories) =
        load_summary_and_memories(&state, user.user_id, session_id, &req.message).await?;
    let premium = ai_tools::is_premium_for(&state.pool, user.user_id).await;
    let tools = Value::Array(ai_tools::tools_for_user(premium));
    let mut messages = ai_prompt::build_messages(
        &sanitized,
        &req.message,
        req.context.as_ref(),
        current_summary.as_deref(),
        Some(&memories),
        premium,
    );

    let chain_list: Vec<String> = chain
        .map(|(primary, fallbacks)| {
            let mut list = vec![primary];
            list.extend(fallbacks);
            list
        })
        .unwrap_or_default();
    let mut current_model_index = 0usize;
    let mut content = String::new();
    let mut tool_calls: Option<Value> = None;
    let mut nudged = false;
    // True once a mutating tool call actually committed; used below so a failed
    // (or read-only) tool call cannot be narrated as a completed action.
    let mut action_succeeded = false;

    for round in 0..ai_turn_runner::MAX_TOOL_ROUNDS {
        let model = chain_list.get(current_model_index).cloned();
        let response = ai_turn_runner::chat_with_cache(
            &state,
            user.user_id,
            &provider,
            &client,
            &messages,
            Some(&tools),
            model.as_deref(),
        )
        .await
        .map_err(|err| err.into_api_error(&provider))?;

        let choice = LlmClient::first_choice(&response);
        let assistant = choice.get("message").cloned().unwrap_or_else(|| json!({}));
        content = assistant
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        tool_calls = assistant.get("tool_calls").filter(|v| !v.is_null()).cloned();

        if tool_calls.is_none() {
            if let Some(parsed) = ai_text::parse_text_tool_calls(&content) {
                content = ai_text::normalize_reply_markdown(&ai_text::strip_text_tool_calls(&content));
                tool_calls = Some(Value::Array(parsed));
            }
        }

        if tool_calls.is_none() && ai_tools::needs_tool_retry(&content, &req.message) {
            if ai_turn_runner::should_bump_model(
                premium,
                &provider,
                current_model_index,
                chain_list.len(),
            ) {
                current_model_index += 1;
                client = build_bumped_client(&state, &api_key, &chain_list, current_model_index)?;
                continue;
            }
            if !nudged {
                nudged = true;
                messages.push(json!({"role": "system", "content": ai_prompts::TOOL_NUDGE}));
                continue;
            }
        }

        let Some(calls) = tool_calls.clone() else {
            break;
        };

        messages.push(json!({"role": "assistant", "content": content, "tool_calls": calls}));
        let call_list = calls.as_array().cloned().unwrap_or_default();
        let (tool_results, round_action_succeeded) =
            ai_execute::execute_tool_calls_outcome(&state, user.user_id, &call_list).await;
        if round_action_succeeded {
            action_succeeded = true;
        }
        messages.extend(tool_results);

        if round == ai_turn_runner::MAX_TOOL_ROUNDS - 1 {
            let messages_value = Value::Array(messages.clone());
            let fallback = client
                .chat(&messages_value, None, None, None)
                .await
                .map_err(|err| {
                    ApiError::BadGateway(ai_turn_runner::friendly_llm_error(&err, &provider))
                })?;
            record_response_usage(&state, user.user_id, &provider, &fallback).await?;
            content = LlmClient::first_choice(&fallback)
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            tool_calls = None;
        }
    }

    content = ai_text::normalize_reply_markdown(&ai_text::strip_text_tool_calls(&content));

    // Never persist (or return) a hallucinated success: if the model narrated an
    // action that no mutating tool committed, replace it with the honest reply.
    if ai_turn_runner::unmet_action(&content, &req.message, action_succeeded) {
        content = "I could not make that change, so nothing was saved. \
Tell me the exact item and what you want changed and I will do it."
            .to_string();
    }

    {
        let mut tx = state.pool.begin().await.map_err(db_error)?;
        db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
        ai_conversation::insert_conversation(
            &mut *tx,
            user.user_id,
            session_id,
            "user",
            &req.message,
            None,
        )
        .await
        .map_err(db_error)?;
        ai_conversation::insert_conversation(
            &mut *tx,
            user.user_id,
            session_id,
            "assistant",
            &content,
            tool_calls.as_ref(),
        )
        .await
        .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
    }

    ai_turn_runner::maybe_update_summary(
        &state,
        user.user_id,
        session_id,
        &client,
        &sanitized,
        &req.message,
        &content,
        current_summary.as_deref(),
    )
    .await;
    ai_turn_runner::maybe_extract_memories(
        &state,
        user.user_id,
        session_id,
        &client,
        &sanitized,
        &req.message,
        &content,
    )
    .await;

    let estimated = ai_turn_runner::estimate_tokens(&messages, Some(&content));
    Ok(Json(json!({
        "content": content,
        "tool_calls": tool_calls,
        "session_id": session_id.to_string(),
        "estimated_tokens": estimated,
    })))
}

/// POST /api/ai/chat/stream - SSE relay of a background turn.
async fn chat_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let user = require_user(&state, &headers)?;
    check_ai_rate_limit(user.user_id).await?;

    if ai_turn_runner::get_active_turn(user.user_id).is_some() {
        return Err(ApiError::Conflict(
            "Prysm AI is still working on your previous request. Please wait a moment.".to_string(),
        ));
    }

    let (provider, api_key, chain) =
        resolve_llm_key(&state, user.user_id, &req.provider, &headers).await?;
    let session_id = req
        .session_id
        .as_deref()
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_else(Uuid::new_v4);
    let sanitized = sanitize_chat_history(&req.chat_history);
    let chain_list: Vec<String> = chain
        .map(|(primary, fallbacks)| {
            let mut list = vec![primary];
            list.extend(fallbacks);
            list
        })
        .unwrap_or_default();

    let job = ai_turn_runner::start_turn(
        state.clone(),
        ai_turn_runner::TurnParams {
            user_id: user.user_id,
            session_id,
            provider,
            api_key,
            chain: chain_list,
            sanitized_history: sanitized,
            user_message: req.message,
            context: req.context,
        },
    );
    let Some(job) = job else {
        return Err(ApiError::Conflict(
            "Prysm AI is still working on your previous request. Please wait a moment.".to_string(),
        ));
    };
    let Some(rx) = job.take_events() else {
        return Err(ApiError::Internal("turn already consumed".to_string()));
    };
    // Drop our handle so the channel closes when the runner finishes; keep only
    // the receiver in the returned stream.
    drop(job);

    let stream = UnboundedReceiverStream::new(rx).map(|event| {
        let frame = match event {
            ai_turn_runner::TurnEvent::Token(text) => Event::default().event("token").data(text),
            ai_turn_runner::TurnEvent::ToolStart(value) => {
                Event::default().event("tool_start").data(value.to_string())
            }
            ai_turn_runner::TurnEvent::ToolResults(items) => {
                let data = Value::Array(items.into_iter().map(Value::String).collect()).to_string();
                Event::default().event("tool_results").data(data)
            }
            ai_turn_runner::TurnEvent::Usage(value) => {
                Event::default().event("usage").data(value.to_string())
            }
            ai_turn_runner::TurnEvent::Error(text) => {
                Event::default().event("error").data(text)
            }
            ai_turn_runner::TurnEvent::Done => Event::default().event("done").data(""),
        };
        Ok::<_, Infallible>(frame)
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}

/// GET /api/ai/turn/status
async fn turn_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    match ai_turn_runner::get_active_turn(user.user_id) {
        None => Ok(Json(json!({
            "running": false,
            "session_id": Value::Null,
            "phase": Value::Null,
        }))),
        Some(job) => Ok(Json(json!({
            "running": true,
            "session_id": job.session_id.to_string(),
            "phase": job.phase(),
        }))),
    }
}

/// POST /api/ai/turn/cancel
async fn turn_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(json!({
        "cancelled": ai_turn_runner::cancel_turn(user.user_id),
    })))
}

/// POST /api/ai/turn/answer-now
/// Ask the in-flight turn to stop gathering tools and stream its final answer
/// with whatever it already has.
async fn turn_answer_now(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(json!({
        "finalizing": ai_turn_runner::answer_now_turn(user.user_id),
    })))
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

    async fn call(
        app: &axum::Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let cookie = format!("access_token={token}");
        let request = match body {
            Some(value) => Request::builder()
                .method(method)
                .uri(uri)
                .header("cookie", cookie)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => Request::builder()
                .method(method)
                .uri(uri)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        };
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn test_user(state: &AppState) -> (Uuid, String) {
        let email = format!("rust-ai-chat-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(
            &state.settings.jwt_secret_key,
            &user.id.to_string(),
            0,
        )
        .unwrap();
        (user.id, token)
    }

    #[tokio::test]
    async fn chat_without_a_key_is_400() {
        let Some(state) = live_state().await else {
            return;
        };
        let (user_id, token) = test_user(&state).await;
        let app = router().with_state(state.clone());
        let (status, body) = call(
            &app,
            "POST",
            "/api/ai/chat",
            &token,
            Some(json!({ "message": "hello", "provider": "openai" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["detail"], "Please provide an API key in Settings.");
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn hosted_prysmai_is_unavailable_in_community() {
        let Some(state) = live_state().await else {
            return;
        };
        let (user_id, token) = test_user(&state).await;
        let app = router().with_state(state.clone());
        let (status, body) = call(
            &app,
            "POST",
            "/api/ai/chat",
            &token,
            Some(json!({ "message": "hello", "provider": "prysmai" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body["detail"],
            "PrysmAI requires an active plan or the 14-day free trial."
        );
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn turn_status_and_cancel_report_no_active_turn() {
        let Some(state) = live_state().await else {
            return;
        };
        let (user_id, token) = test_user(&state).await;
        let app = router().with_state(state.clone());
        let (status, body) = call(&app, "GET", "/api/ai/turn/status", &token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["running"], false);
        let (status, body) = call(&app, "POST", "/api/ai/turn/cancel", &token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["cancelled"], false);
        let (status, body) =
            call(&app, "POST", "/api/ai/turn/answer-now", &token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["finalizing"], false);
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[test]
    fn sanitize_keeps_only_recent_user_and_assistant_turns() {
        let mut history: Vec<Value> = Vec::new();
        history.push(json!({"role": "system", "content": "nope"}));
        for i in 0..25 {
            history.push(json!({"role": "user", "content": format!("m{i}")}));
        }
        let sanitized = sanitize_chat_history(&history);
        assert_eq!(sanitized.len(), MAX_CHAT_HISTORY);
        assert_eq!(sanitized.last().unwrap()["content"], "m24");
        assert!(sanitized.iter().all(|m| m["role"] == "user"));
    }

    #[test]
    fn sanitize_caps_message_length() {
        let long = "x".repeat(MAX_MESSAGE_LENGTH + 100);
        let sanitized = sanitize_chat_history(&[json!({"role": "user", "content": long})]);
        assert_eq!(
            sanitized[0]["content"].as_str().unwrap().chars().count(),
            MAX_MESSAGE_LENGTH
        );
    }
}
