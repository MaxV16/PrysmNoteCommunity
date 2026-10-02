//! Prysm Note core server (community / open-core).
//!
//! This crate is the open-core Rust backend. It must never reference the private
//! `prysm-ee` crate directly: proprietary routes, background loops and premium
//! hooks are injected through the [`EeExtension`] trait, which the private build
//! implements and the community build leaves absent.

#![allow(
    clippy::explicit_auto_deref,
    clippy::manual_range_contains,
    clippy::too_many_arguments,
    clippy::unnecessary_map_or,
    clippy::while_let_on_iterator,
    clippy::needless_as_bytes,
    clippy::collapsible_if,
    clippy::large_enum_variant,
    clippy::redundant_closure,
    clippy::redundant_guards,
    clippy::cloned_ref_to_slice_refs,
    clippy::needless_lifetimes,
    clippy::map_entry,
    clippy::result_large_err,
    clippy::unnecessary_sort_by,
    clippy::while_let_loop,
    clippy::field_reassign_with_default,
    clippy::await_holding_lock,
    clippy::len_zero,
    clippy::manual_flatten,
    clippy::type_complexity,
    clippy::manual_is_multiple_of,
    clippy::useless_format,
    clippy::unnecessary_lazy_evaluations,
    clippy::if_same_then_else
)]

use std::sync::Arc;

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use sqlx::PgPool;

pub mod ai;
pub mod ai_cache;
pub mod ai_chat;
pub mod ai_conversation;
pub mod ai_entitlement;
pub mod ai_execute;
pub mod ai_memory;
pub mod ai_prompt;
pub mod ai_prompts;
pub mod ai_region;
pub mod ai_text;
pub mod ai_tools;
pub mod ai_turn_runner;
pub mod analytics;
pub mod api_key;
pub mod api_token;
pub mod app_login_codes;
pub mod auth;
pub mod auth_routes;
pub mod blacklist;
pub mod board_sections;
pub mod cache;
pub mod calendar;
pub mod common_words;
pub mod config;
pub mod cookies;
pub mod db;
pub mod email;
pub mod embedding;
pub mod error;
pub mod events;
pub mod feature_guide;
pub mod fernet;
pub mod finance;
pub mod habits;
pub mod imports;
pub mod jwt;
pub mod keys;
pub mod lifecycle;
pub mod lists;
pub mod llm;
pub mod loop_leader;
pub mod maintenance;
pub mod mcp;
pub mod memory_service;
pub mod middleware;
pub mod notes;
pub mod notification_service;
pub mod notifications;
pub mod oauth;
pub mod passkey;
pub mod passkeys;
pub mod password;
pub mod preferences;
pub mod push_service;
pub mod ratelimit;
pub mod recurring;
pub mod risk;
pub mod schema;
pub mod search;
pub mod tags;
pub mod tokens;
pub mod task;
pub mod task_links;
pub mod tasks;
pub mod teams;
pub mod user;
pub mod watchlist;

/// Extension point the optional extension crate fills with additional
/// routers, background loops and gating. The community build passes
/// `None`, so the open-core crate stays free of any extension reference.
pub trait EeExtension: Send + Sync {
    /// Wrap the core router, mounting EE routes and (later) background loops.
    fn register(&self, router: Router) -> Router;
}

/// Shared application state: the Postgres pool plus parsed settings.
#[derive(Clone)]
pub struct AppState {
    /// Bounded Postgres connection pool (RLS-enforced app role).
    pub pool: PgPool,
    /// BYPASSRLS pool for the cross-user background loops, built lazily from
    /// `SYSTEM_DATABASE_URL` (falling back to `database_url`). A role cannot be
    /// changed per connection, so this must be a distinct pool.
    pub system_pool: PgPool,
    /// Parsed environment settings.
    pub settings: Arc<config::Settings>,
    /// In-process per-user change bus backing `GET /api/events`.
    pub events: events::EventBus,
    /// Per-IP API rate limiter (`rl:api`), shared across requests.
    pub api_limiter: Arc<ratelimit::RateLimiter>,
    /// Cache-aside store (Redis when configured, otherwise in-process).
    pub cache: cache::RedisPool,
}

impl AppState {
    /// Build state around an already-connected pool.
    pub fn new(pool: PgPool, settings: config::Settings) -> Self {
        let cache = cache::RedisPool::from_url(&settings.redis_url);
        let api_limiter = Arc::new(ratelimit::RateLimiter::with_redis("rl:api", cache.clone()));
        let system_pool = db::connect_lazy(&settings.system_database_url());
        Self {
            pool,
            system_pool,
            settings: Arc::new(settings),
            events: events::EventBus::new(),
            api_limiter,
            cache,
        }
    }

    /// Build state without connecting; the pool connects lazily on first use.
    pub fn lazy(settings: config::Settings) -> Self {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(6)
            .connect_lazy(&settings.database_url)
            .expect("invalid DATABASE_URL");
        Self::new(pool, settings)
    }
}

/// Build the core router with the given state; `ee` registers any enterprise
/// routes through the [`EeExtension`] hook (absent in the community build).
pub fn build_router(state: AppState, ee: Option<&dyn EeExtension>) -> Router {
    let router = Router::new()
        .route("/api/health", get(health))
        .merge(auth_routes::router())
        .merge(passkeys::router())
        .merge(oauth::router())
        .merge(oauth::mobile_router())
        .merge(events::router())
        .merge(tasks::router())
        .merge(teams::router())
        .merge(tags::router())
        .merge(lists::router())
        .merge(calendar::router())
        .merge(finance::router())
        .merge(board_sections::router())
        .merge(task_links::router())
        .merge(preferences::router())
        .merge(notes::router())
        .merge(habits::router())
        .merge(notifications::router())
        .merge(watchlist::router())
        .merge(analytics::router())
        .merge(search::router())
        .merge(imports::router())
        .merge(keys::router())
        .merge(tokens::router())
        .merge(ai::router())
        .merge(ai_chat::router())
        .merge(mcp::router())
        .with_state(state.clone());

    let router = match ee {
        Some(extension) => extension.register(router),
        None => router,
    };

    // Layer order: the layer added last is the outermost, so requests flow
    // CORS -> CSRF -> rate limit -> security headers -> body limit -> event
    // publish, matching the Python middleware registration order (CORS
    // outermost so it can answer preflight requests before the CSRF gate).
    router
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::publish_events,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::touch_activity,
        ))
        .layer(axum::middleware::from_fn(middleware::body_limit))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::security_headers,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::api_rate_limit,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::csrf,
        ))
        .layer(axum::middleware::from_fn_with_state(state, middleware::cors))
}

/// `GET /api/health` - liveness/version probe, byte-compatible with the Python
/// backend: `{"status":"ok","version":<git sha or null>}`.
async fn health() -> Json<Value> {
    let version = std::env::var("GIT_SHA").ok();
    Json(json!({ "status": "ok", "version": version }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_reports_ok() {
        let response = build_router(AppState::lazy(config::Settings::from_env()), None)
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert!(body.get("version").is_some());
    }

    #[tokio::test]
    async fn unknown_route_is_404() {
        let response = build_router(AppState::lazy(config::Settings::from_env()), None)
            .oneshot(
                Request::builder()
                    .uri("/api/nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
