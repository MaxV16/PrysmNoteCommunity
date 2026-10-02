//! Edge middleware parity with the Python backend: CSRF double-submit,
//! per-IP API rate limiting, body-size limit, security headers and the
//! automatic SSE change-publish layer.
//!
//! The Python app registers (outermost first) CSRF, rate limit, CSP/security
//! headers, body-size, CORS, then the event-publish middleware innermost. With
//! axum/tower the layer added *last* is the outermost, so they are stacked in
//! reverse below.

use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use uuid::Uuid;

use crate::auth;
use crate::config::Settings;
use crate::events::match_resource;
use crate::AppState;

/// Maximum accepted request body size (10 MiB, matching the Python backend).
pub const MAX_BODY_SIZE: usize = 10 * 1024 * 1024;

/// Paths exempt from CSRF (and from the API rate limiter), the Rust equivalent
/// of Python's `CSRF_SAFE_PATHS` for the surfaces that exist in core.
pub fn safe_paths() -> &'static [&'static str] {
    &[
        "/api/auth/login",
        "/api/auth/register",
        "/api/auth/refresh",
        "/api/auth/logout",
        "/api/auth/passkey/login/options",
        "/api/auth/passkey/login/verify",
        "/api/health",
        "/api/mcp",
        "/api/mcp/",
        "/api/ee/billing/webhook/stripe",
        "/api/ee/mcp-oauth/register",
        "/api/ee/mcp-oauth/token",
        "/api/ee/mcp-oauth/revoke",
    ]
}

/// Best-effort client IP, matching Python's precedence: Cloudflare's
/// `CF-Connecting-IP`, then the first `X-Forwarded-For` entry, else `unknown`.
pub fn client_ip(headers: &HeaderMap) -> String {
    if let Some(v) = headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()) {
        let v = v.trim();
        if v.parse::<std::net::IpAddr>().is_ok() {
            return v.to_string();
        }
    }
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = v.split(',').next() {
            let first = first.trim();
            if first.parse::<std::net::IpAddr>().is_ok() {
                return first.to_string();
            }
        }
    }
    "unknown".to_string()
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE).and_then(|v| v.to_str().ok())?;
    raw.split(';')
        .map(|part| part.trim())
        .find_map(|part| part.strip_prefix(&format!("{name}=")).map(|v| v.to_string()))
}

/// Constant-time-ish comparison (length checked first) for CSRF token equality.
fn tokens_match(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn forbidden(detail: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "detail": detail }))).into_response()
}

fn random_csrf_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn csrf_cookie(token: &str, secure: bool) -> String {
    let mut cookie = format!("csrf_token={token}; Path=/; SameSite=Lax; Max-Age=86400");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

fn origin_allowed(settings: &Settings, headers: &HeaderMap) -> bool {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| {
            headers
                .get(header::REFERER)
                .and_then(|v| v.to_str().ok())
                .and_then(referer_origin)
        });
    let Some(origin) = origin else {
        return true;
    };
    let origin = origin.trim_end_matches('/').to_ascii_lowercase();
    settings
        .csrf_allowed_origins
        .split(',')
        .map(|o| o.trim().to_ascii_lowercase())
        .any(|o| !o.is_empty() && o == origin)
}

fn referer_origin(referer: &str) -> Option<String> {
    let url = url::Url::parse(referer).ok()?;
    Some(url.origin().unicode_serialization())
}

/// CSRF double-submit: safe methods get a `csrf_token` cookie if missing;
/// unsafe methods must send a matching `X-CSRF-Token` header and an allowed
/// Origin. Gated by `settings.csrf_enabled`.
pub async fn csrf(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if !state.settings.csrf_enabled {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();

    if matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
        let had_cookie = cookie_value(&headers, "csrf_token").is_some();
        let mut res = next.run(req).await;
        if !had_cookie {
            let token = random_csrf_token();
            if let Ok(value) =
                HeaderValue::from_str(&csrf_cookie(&token, state.settings.is_production()))
            {
                res.headers_mut().append(header::SET_COOKIE, value);
            }
        }
        return res;
    }

    if !origin_allowed(&state.settings, &headers) {
        return forbidden("Origin not allowed");
    }
    if safe_paths().contains(&path.as_str()) {
        return next.run(req).await;
    }

    let cookie = cookie_value(&headers, "csrf_token");
    let sent = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    match (cookie, sent) {
        (Some(cookie), Some(sent)) if tokens_match(&cookie, &sent) => next.run(req).await,
        (Some(_), Some(_)) => forbidden("CSRF token mismatch"),
        _ => forbidden("CSRF token missing"),
    }
}

fn cors_origin_allowed(settings: &Settings, origin: &str) -> bool {
    let origin = origin.trim_end_matches('/').to_ascii_lowercase();
    settings
        .cors_origins
        .split(',')
        .map(|o| o.trim().to_ascii_lowercase())
        .any(|o| o == "*" || (!o.is_empty() && o == origin))
}

/// CORS parity with Python's `CORSMiddleware` (origins from `CORS_ORIGINS`,
/// credentials allowed, any method/header). Answers preflight `OPTIONS`
/// requests directly so cross-origin dev, desktop and embedded clients work;
/// same-origin production traffic (nginx proxies `/api`) is unaffected.
pub async fn cors(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string());
    let allowed = origin
        .as_deref()
        .map(|o| cors_origin_allowed(&state.settings, o))
        .unwrap_or(false);
    let is_preflight = req.method() == Method::OPTIONS
        && req
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);

    if is_preflight {
        if !allowed {
            return next.run(req).await;
        }
        let origin = origin.unwrap_or_else(|| "*".to_string());
        let method = req
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("GET")
            .to_string();
        let requested_headers = req
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let mut res = StatusCode::NO_CONTENT.into_response();
        let headers = res.headers_mut();
        let mut set = |name: header::HeaderName, value: String| {
            if let Ok(value) = HeaderValue::from_str(&value) {
                headers.insert(name, value);
            }
        };
        set(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        set(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            "true".to_string(),
        );
        set(header::ACCESS_CONTROL_ALLOW_METHODS, method);
        set(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            requested_headers.unwrap_or_else(|| "*".to_string()),
        );
        set(header::ACCESS_CONTROL_MAX_AGE, "600".to_string());
        set(header::VARY, "Origin".to_string());
        return res;
    }

    let mut res = next.run(req).await;
    if allowed {
        if let Some(origin) = origin {
            let headers = res.headers_mut();
            let mut set = |name: header::HeaderName, value: String| {
                if let Ok(value) = HeaderValue::from_str(&value) {
                    headers.insert(name, value);
                }
            };
            set(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            set(
                header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                "true".to_string(),
            );
            set(header::VARY, "Origin".to_string());
        }
    }
    res
}

/// Per-IP API rate limit (`rl:api`), 120/min by default; skips non-`/api`
/// paths, safe paths, OAuth callbacks and OPTIONS/HEAD.
pub async fn api_rate_limit(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if !state.settings.api_rate_limit_enabled {
        return next.run(req).await;
    }
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let skip = !path.starts_with("/api/")
        || safe_paths().contains(&path.as_str())
        || path.ends_with("/callback")
        || matches!(method, Method::OPTIONS | Method::HEAD);
    if skip {
        return next.run(req).await;
    }

    let ip = client_ip(req.headers());
    let count = state
        .api_limiter
        .count(&format!("ip:{ip}"), Duration::from_secs(60))
        .await;
    if count > state.settings.api_rate_limit_per_min {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "detail": "Too many requests" })),
        )
            .into_response();
    }
    next.run(req).await
}

/// Sets the same security headers the Python `CSPSecurityMiddleware` adds on
/// every response.
pub async fn security_headers(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let production = state.settings.is_production();
    let mut res = next.run(req).await;
    let connect_src = if production {
        "'self'".to_string()
    } else {
        "'self' http://localhost:* ws://localhost:*".to_string()
    };
    let script_src = if production {
        "script-src 'self'; "
    } else {
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
    };
    let csp = format!(
        "default-src 'self'; {script_src}style-src 'self' 'unsafe-inline'; \
img-src 'self' data: https://image.tmdb.org https://www.themoviedb.org; \
connect-src {connect_src}; frame-ancestors 'none'; base-uri 'self'; form-action 'self';{}",
        if production {
            " upgrade-insecure-requests;"
        } else {
            " "
        }
    );

    let headers = res.headers_mut();
    let mut set = |name: &'static str, value: String| {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    };
    set("content-security-policy", csp);
    set("x-content-type-options", "nosniff".to_string());
    set("x-frame-options", "DENY".to_string());
    set("referrer-policy", "no-referrer".to_string());
    set(
        "permissions-policy",
        "camera=(), microphone=(self), geolocation=()".to_string(),
    );
    set(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains".to_string(),
    );
    res
}

/// Rejects bodies whose declared `Content-Length` exceeds [`MAX_BODY_SIZE`].
pub async fn body_limit(req: Request, next: Next) -> Response {
    if let Some(value) = req.headers().get(header::CONTENT_LENGTH) {
        let size = match value.to_str().ok().and_then(|s| s.trim().parse::<usize>().ok()) {
            Some(size) => size,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "detail": "Invalid Content-Length" })),
                )
                    .into_response()
            }
        };
        if size > MAX_BODY_SIZE {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({ "detail": "Request body too large" })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

/// Publishes a per-user change signal after a successful (2xx/3xx) mutation on
/// a watched resource prefix, mirroring Python's `EventPublishMiddleware`.
pub async fn publish_events(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();
    let resource = if matches!(method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE) {
        match_resource(&path)
    } else {
        None
    };

    let res = next.run(req).await;

    if let Some(resource) = resource {
        let status = res.status();
        if status.is_success() || status.is_redirection() {
            if let Some(token) = auth::token_from_headers(&headers) {
                if let Ok(user) = auth::authenticate(&state.settings.jwt_secret_key, &token) {
                    state.events.publish(user.user_id, resource);
                }
            }
        }
    }
    res
}

/// Record `last_active_at` for any successful authenticated request. Kept
/// separate from the event publisher so plain reads (which do not publish) still
/// count as activity. The write is throttled and fire-and-forget, so it never
/// adds latency to the request.
pub async fn touch_activity(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let headers = req.headers().clone();
    let res = next.run(req).await;
    if res.status().is_success() {
        if let Some(token) = auth::token_from_headers(&headers) {
            if let Ok(user) = auth::authenticate(&state.settings.jwt_secret_key, &token) {
                crate::lifecycle::touch_activity(&state, user.user_id);
            }
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn settings() -> Settings {
        Settings {
            database_url: "postgres://localhost:5432/prysm_note".to_string(),
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
            csrf_enabled: true,
            csrf_allowed_origins: "http://localhost:3000".to_string(),
            api_rate_limit_enabled: true,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".to_string(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: "mailto:support@prysmnote.com".to_string(),
            notify_email: String::new(),
            notification_loop_interval: 1800,
            digest_hour: 7,
        }
    }

    async fn call(app: Router, req: Request<Body>) -> Response {
        app.oneshot(req).await.unwrap()
    }

    #[tokio::test]
    async fn safe_request_without_csrf_cookie_receives_one() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/health", get(|| async { Json(json!({ "status": "ok" })) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, csrf));
        let res = call(
            app,
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(cookie.contains("csrf_token="));
    }

    #[tokio::test]
    async fn unsafe_request_without_token_is_forbidden() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/tasks", axum::routing::post(|| async { Json(json!({})) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, csrf));
        let res = call(
            app,
            Request::builder()
                .method(Method::POST)
                .uri("/api/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn unsafe_request_with_mismatched_token_is_forbidden() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/tasks", axum::routing::post(|| async { Json(json!({})) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, csrf));
        let res = call(
            app,
            Request::builder()
                .method(Method::POST)
                .uri("/api/tasks")
                .header(header::COOKIE, "csrf_token=abc")
                .header("x-csrf-token", "different")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn unsafe_request_with_matching_token_passes() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/tasks", axum::routing::post(|| async { Json(json!({})) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, csrf));
        let res = call(
            app,
            Request::builder()
                .method(Method::POST)
                .uri("/api/tasks")
                .header(header::COOKIE, "csrf_token=abc")
                .header("x-csrf-token", "abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn disallowed_origin_is_forbidden() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/tasks", axum::routing::post(|| async { Json(json!({})) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, csrf));
        let res = call(
            app,
            Request::builder()
                .method(Method::POST)
                .uri("/api/tasks")
                .header(header::ORIGIN, "https://evil.example")
                .header(header::COOKIE, "csrf_token=abc")
                .header("x-csrf-token", "abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn cors_preflight_is_answered_for_allowed_origin() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/auth/register", axum::routing::post(|| async { Json(json!({})) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, cors));
        let res = call(
            app,
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/auth/register")
                .header(header::ORIGIN, "http://localhost:3000")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://localhost:3000")
        );
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                .and_then(|v| v.to_str().ok()),
            Some("true")
        );
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .and_then(|v| v.to_str().ok()),
            Some("content-type")
        );
    }

    #[tokio::test]
    async fn cors_headers_are_added_to_simple_requests() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/health", get(|| async { Json(json!({ "status": "ok" })) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, cors));
        let res = call(
            app,
            Request::builder()
                .uri("/api/health")
                .header(header::ORIGIN, "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://localhost:3000")
        );
    }

    #[tokio::test]
    async fn cors_omits_headers_for_disallowed_origin() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/health", get(|| async { Json(json!({ "status": "ok" })) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, cors));
        let res = call(
            app,
            Request::builder()
                .uri("/api/health")
                .header(header::ORIGIN, "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert!(res
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn api_rate_limit_returns_429_after_the_cap() {
        let mut settings = settings();
        settings.api_rate_limit_per_min = 1;
        let state = AppState::lazy(settings);
        let app = Router::new()
            .route("/api/tasks", get(|| async { Json(json!({})) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, api_rate_limit));

        let first = call(
            app.clone(),
            Request::builder().uri("/api/tasks").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        let second = call(
            app,
            Request::builder().uri("/api/tasks").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn oversized_body_is_rejected() {
        let app = Router::new()
            .route("/api/tasks", axum::routing::post(|| async { Json(json!({})) }))
            .layer(axum::middleware::from_fn(body_limit));
        let res = call(
            app,
            Request::builder()
                .method(Method::POST)
                .uri("/api/tasks")
                .header(header::CONTENT_LENGTH, (MAX_BODY_SIZE + 1).to_string())
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn security_headers_are_present() {
        let state = AppState::lazy(settings());
        let app = Router::new()
            .route("/api/health", get(|| async { Json(json!({ "status": "ok" })) }))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, security_headers));
        let res = call(
            app,
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("x-frame-options").unwrap(),
            &HeaderValue::from_static("DENY")
        );
        assert_eq!(
            res.headers().get("x-content-type-options").unwrap(),
            &HeaderValue::from_static("nosniff")
        );
        assert!(res.headers().contains_key(header::CONTENT_SECURITY_POLICY));
    }
}
