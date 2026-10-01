use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::ratelimit::RateLimiter;
use crate::{app_login_codes, blacklist, cookies, jwt, user, AppState};

const STATE_COOKIE: &str = "oauth_state";
const GITHUB_SCOPES: &str = "read:user user:email";
const MOBILE_STATE_PREFIX: &str = "mobile:";
const DESKTOP_STATE_PREFIX: &str = "desktop:";
const MOBILE_EXCHANGE_LIMIT: u32 = 20;
const MOBILE_EXCHANGE_WINDOW: Duration = Duration::from_secs(600);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/oauth/{provider}/start", get(start))
        .route("/api/auth/oauth/{provider}/callback", get(callback))
}

pub fn mobile_router() -> Router<AppState> {
    Router::new().route("/api/auth/mobile/exchange", get(mobile_exchange))
}

#[derive(Deserialize)]
struct StartQuery {
    redirect: Option<String>,
    nonce: Option<String>,
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    #[serde(rename = "return")]
    return_url: Option<String>,
}

#[derive(Deserialize)]
struct ExchangeQuery {
    code: Option<String>,
}

struct Identity {
    email: String,
    name: String,
    email_verified: Option<bool>,
}

fn state_cookie(value: &str, secure: bool) -> String {
    let mut cookie = format!("{STATE_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

fn clear_state_cookie(secure: bool) -> String {
    let mut cookie = format!("{STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    let prefix = format!("{name}=");
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
    }
    None
}

fn redirect(status: StatusCode, location: &str) -> Response {
    Response::builder()
        .status(status)
        .header(LOCATION, location)
        .body(Body::empty())
        .expect("valid redirect response")
}

fn append_cookie(response: &mut Response, cookie: &str) {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().append(SET_COOKIE, value);
    }
}

fn app_url(state: &AppState, path: &str) -> String {
    format!("{}{}", state.settings.app_origin, path)
}

fn is_provider(provider: &str) -> bool {
    matches!(provider, "google" | "github")
}

fn configured(state: &AppState, provider: &str) -> bool {
    let s = &state.settings;
    match provider {
        "google" => !s.google_client_id.is_empty() && !s.google_client_secret.is_empty(),
        "github" => !s.github_client_id.is_empty() && !s.github_client_secret.is_empty(),
        _ => false,
    }
}

fn provider_authorize_url(state: &AppState, provider: &str, oauth_state: &str) -> Option<String> {
    let s = &state.settings;
    let mut url = match provider {
        "google" => "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
        "github" => "https://github.com/login/oauth/authorize".to_string(),
        _ => return None,
    };
    let mut parsed = url::Url::parse(&url).ok()?;
    {
        let mut qp = parsed.query_pairs_mut();
        match provider {
            "google" => {
                qp.append_pair("client_id", &s.google_client_id);
                qp.append_pair("redirect_uri", &s.oauth_redirect_uri);
                qp.append_pair("response_type", "code");
                qp.append_pair("scope", "openid email profile");
                qp.append_pair("state", oauth_state);
                qp.append_pair("prompt", "select_account");
            }
            "github" => {
                qp.append_pair("client_id", &s.github_client_id);
                qp.append_pair("redirect_uri", &s.oauth_redirect_uri);
                qp.append_pair("scope", GITHUB_SCOPES);
                qp.append_pair("state", oauth_state);
                qp.append_pair("allow_signup", "true");
            }
            _ => return None,
        }
    }
    url = parsed.into();
    Some(url)
}

fn looks_like_github_code(code: &str) -> bool {
    code.len() == 20 && code.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn sanitize_return(value: Option<&str>) -> String {
    match value {
        Some(v) if v.starts_with('/') && !v.starts_with("//") => v.to_string(),
        _ => "/".to_string(),
    }
}

fn random_state() -> String {
    format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn parse_state_cookie(raw: &str) -> (Option<&'static str>, String, String) {
    if let Some(rest) = raw.strip_prefix(DESKTOP_STATE_PREFIX) {
        let (nonce, _, expected) = split_partition(rest);
        (Some("desktop"), nonce, expected)
    } else if let Some(rest) = raw.strip_prefix(MOBILE_STATE_PREFIX) {
        if rest.contains(':') {
            let (nonce, _, expected) = split_partition(rest);
            (Some("mobile"), nonce, expected)
        } else {
            (Some("mobile"), String::new(), rest.to_string())
        }
    } else {
        (None, String::new(), raw.to_string())
    }
}

fn split_partition(value: &str) -> (String, bool, String) {
    match value.split_once(':') {
        Some((a, b)) => (a.to_string(), true, b.to_string()),
        None => (value.to_string(), false, String::new()),
    }
}

fn display_name(identity_name: &str, email: &str) -> Option<String> {
    let trimmed: String = identity_name.trim().chars().take(100).collect();
    if !trimmed.is_empty() {
        return Some(trimmed);
    }
    let local: String = email.split('@').next().unwrap_or("").chars().take(100).collect();
    if local.is_empty() {
        None
    } else {
        Some(local)
    }
}

fn bool_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn client_ip(headers: &HeaderMap) -> String {
    if let Some(value) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim())
    {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    if let Some(value) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    "unknown".to_string()
}

fn mobile_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:mobile_oauth"))
}

fn too_many_attempts() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        axum::Json(json!({ "detail": "Too many attempts" })),
    )
        .into_response()
}

async fn start(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(query): Query<StartQuery>,
    headers: HeaderMap,
) -> Response {
    if !is_provider(&provider) {
        return redirect(StatusCode::FOUND, &app_url(&state, "/login?error=unsupported_provider"));
    }
    if !configured(&state, &provider) {
        return redirect(StatusCode::FOUND, &app_url(&state, "/login?error=sso_not_configured"));
    }

    let oauth_state = random_state();
    let secure = state.settings.is_production();

    let cookie_value = match query.redirect.as_deref() {
        Some("mobile") => {
            let nonce = query
                .nonce
                .as_deref()
                .filter(|n| app_login_codes::is_safe_nonce(n))
                .unwrap_or("");
            format!("{MOBILE_STATE_PREFIX}{nonce}:{oauth_state}")
        }
        Some("desktop") => {
            let nonce = query
                .nonce
                .as_deref()
                .filter(|n| app_login_codes::is_safe_nonce(n))
                .unwrap_or("");
            format!("{DESKTOP_STATE_PREFIX}{nonce}:{oauth_state}")
        }
        _ => oauth_state.clone(),
    };

    let Some(url) = provider_authorize_url(&state, &provider, &oauth_state) else {
        return redirect(StatusCode::FOUND, &app_url(&state, "/login?error=sso_not_configured"));
    };

    let _ = headers;
    let mut response = redirect(StatusCode::FOUND, &url);
    append_cookie(&mut response, &state_cookie(&cookie_value, secure));
    response
}

async fn callback(
    State(state): State<AppState>,
    Path(provider_path): Path<String>,
    Query(query): Query<CallbackQuery>,
    headers: HeaderMap,
) -> Response {
    let mut provider = provider_path.clone();
    let secure = state.settings.is_production();
    let return_url = sanitize_return(query.return_url.as_deref());

    if let Some(error) = query.error.as_deref() {
        if !error.is_empty() {
            return redirect(
                StatusCode::TEMPORARY_REDIRECT,
                &app_url(&state, &format!("/login?error=sso_{error}")),
            );
        }
    }

    if !is_provider(&provider) {
        return redirect(
            StatusCode::TEMPORARY_REDIRECT,
            &app_url(&state, "/login?error=unsupported_provider"),
        );
    }

    let code = query.code.clone().unwrap_or_default();
    if provider == "google" && looks_like_github_code(&code) {
        provider = "github".to_string();
    }

    let raw_cookie = cookie_value(&headers, STATE_COOKIE).unwrap_or_default();
    let (app_flow, app_nonce, expected_state) = parse_state_cookie(&raw_cookie);

    let provided_state = query.state.clone().unwrap_or_default();
    if expected_state.is_empty() || expected_state != provided_state {
        return redirect(
            StatusCode::TEMPORARY_REDIRECT,
            &app_url(&state, "/login?error=sso_invalid_state"),
        );
    }

    let identity = match fetch_identity(&state, &provider, &code).await {
        Ok(identity) => identity,
        Err(()) => {
            return redirect(
                StatusCode::TEMPORARY_REDIRECT,
                &app_url(&state, "/login?error=sso_failed"),
            );
        }
    };

    let email = identity.email.trim().to_lowercase();
    if email.is_empty() {
        return redirect(
            StatusCode::TEMPORARY_REDIRECT,
            &app_url(&state, "/login?error=sso_no_email"),
        );
    }
    if identity.email_verified == Some(false) {
        return redirect(
            StatusCode::TEMPORARY_REDIRECT,
            &app_url(&state, "/login?error=sso_email_not_verified"),
        );
    }

    let name = display_name(&identity.name, &email);
    let user = match user::get_or_create_oauth_user(&state.pool, &email, name.as_deref(), &provider)
        .await
    {
        Ok(user) => user,
        Err(_) => {
            return redirect(
                StatusCode::TEMPORARY_REDIRECT,
                &app_url(&state, "/login?error=sso_failed"),
            );
        }
    };

    let mut response = match app_flow {
        Some("mobile") | Some("desktop") => {
            let deep_link = if app_flow == Some("mobile") {
                app_login_codes::MOBILE_DEEP_LINK
            } else {
                app_login_codes::DESKTOP_DEEP_LINK
            };
            match app_login_codes::create_app_login_code(
                &state.settings.jwt_secret_key,
                &user.id.to_string(),
            ) {
                Ok(code) => {
                    let location = if app_nonce.is_empty() {
                        format!("{deep_link}?code={code}")
                    } else {
                        format!("{deep_link}?code={code}&nonce={app_nonce}")
                    };
                    redirect(StatusCode::TEMPORARY_REDIRECT, &location)
                }
                Err(_) => redirect(
                    StatusCode::TEMPORARY_REDIRECT,
                    &app_url(&state, "/login?error=sso_failed"),
                ),
            }
        }
        _ => {
            let access = jwt::encode_access(
                &state.settings.jwt_secret_key,
                &user.id.to_string(),
                user.token_version,
            );
            let refresh = jwt::encode_refresh(
                &state.settings.jwt_secret_key,
                &user.id.to_string(),
                user.token_version,
            );
            let location = app_url(&state, &return_url);
            let mut response = redirect(StatusCode::TEMPORARY_REDIRECT, &location);
            if let (Ok(access), Ok(refresh)) = (access, refresh) {
                for cookie in cookies::auth_cookies(&access, &refresh, secure) {
                    append_cookie(&mut response, &cookie);
                }
            }
            response
        }
    };
    append_cookie(&mut response, &clear_state_cookie(secure));
    response
}

async fn mobile_exchange(
    State(state): State<AppState>,
    Query(query): Query<ExchangeQuery>,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(&headers);
    let key = format!("exchange:{ip}");
    if mobile_limiter().count(&key, MOBILE_EXCHANGE_WINDOW).await > MOBILE_EXCHANGE_LIMIT {
        return too_many_attempts();
    }

    let code = query.code.clone().unwrap_or_default();
    let claims = match decode_mobile_code(&state.settings.jwt_secret_key, &code) {
        Some(claims) => claims,
        None => return invalid_code(),
    };
    if claims.token_type.as_deref() != Some("mobile_oauth") {
        return invalid_code();
    }
    let (Some(sub), Some(jti)) = (claims.sub.clone(), claims.jti.clone()) else {
        return invalid_code();
    };
    let user_id = match Uuid::parse_str(&sub) {
        Ok(id) => id,
        Err(_) => return invalid_code(),
    };
    let expires_at = claims.exp.unwrap_or(0);
    match blacklist::add_once(&state.pool, &jti, user_id, expires_at).await {
        Ok(true) => {}
        Ok(false) => return invalid_code(),
        Err(_) => return invalid_code(),
    }

    let user = match user::get_by_id(&state.pool, user_id).await {
        Ok(Some(user)) => user,
        _ => return invalid_code(),
    };

    let secure = state.settings.is_production();
    let access = jwt::encode_access(
        &state.settings.jwt_secret_key,
        &user.id.to_string(),
        user.token_version,
    );
    let refresh = jwt::encode_refresh(
        &state.settings.jwt_secret_key,
        &user.id.to_string(),
        user.token_version,
    );

    let mut response = redirect(StatusCode::TEMPORARY_REDIRECT, &app_url(&state, "/"));
    if let (Ok(access), Ok(refresh)) = (access, refresh) {
        for cookie in cookies::auth_cookies(&access, &refresh, secure) {
            append_cookie(&mut response, &cookie);
        }
    }
    response
}

fn invalid_code() -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "detail": "Invalid or expired code" })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct MobileClaims {
    sub: Option<String>,
    exp: Option<i64>,
    #[serde(rename = "type")]
    token_type: Option<String>,
    jti: Option<String>,
}

fn decode_mobile_code(secret: &str, code: &str) -> Option<MobileClaims> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.set_required_spec_claims(&["exp"]);
    let key = jsonwebtoken::DecodingKey::from_secret(secret.as_bytes());
    jsonwebtoken::decode::<MobileClaims>(code, &key, &validation)
        .ok()
        .map(|data| data.claims)
}

async fn fetch_identity(state: &AppState, provider: &str, code: &str) -> Result<Identity, ()> {
    match provider {
        "google" => exchange_google(state, code).await,
        "github" => exchange_github(state, code).await,
        _ => Err(()),
    }
}

async fn exchange_google(state: &AppState, code: &str) -> Result<Identity, ()> {
    let s = &state.settings;
    let client = reqwest::Client::new();
    let token_response = client
        .post("https://oauth2.googleapis.com/token")
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("code", code),
            ("client_id", s.google_client_id.as_str()),
            ("client_secret", s.google_client_secret.as_str()),
            ("redirect_uri", s.oauth_redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|_| ())?;
    let token_json: Value = token_response.json().await.map_err(|_| ())?;
    let id_token = token_json
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or(())?
        .to_string();

    let claims = verify_google_id_token(&client, &id_token, &s.google_client_id).await?;
    let email = claims
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let name = claims
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| {
            email
                .split('@')
                .next()
                .unwrap_or("")
                .to_string()
        });
    let email_verified = claims.get("email_verified").and_then(bool_value);
    Ok(Identity {
        email,
        name,
        email_verified,
    })
}

async fn verify_google_id_token(
    client: &reqwest::Client,
    id_token: &str,
    client_id: &str,
) -> Result<Value, ()> {
    let header = jsonwebtoken::decode_header(id_token).map_err(|_| ())?;
    let kid = header.kid.ok_or(())?;
    let jwks: Value = client
        .get("https://www.googleapis.com/oauth2/v3/certs")
        .send()
        .await
        .map_err(|_| ())?
        .json()
        .await
        .map_err(|_| ())?;
    let keys = jwks.get("keys").and_then(|v| v.as_array()).ok_or(())?;
    let key = keys
        .iter()
        .find(|k| k.get("kid").and_then(|v| v.as_str()) == Some(kid.as_str()))
        .ok_or(())?;
    let n = key.get("n").and_then(|v| v.as_str()).ok_or(())?;
    let e = key.get("e").and_then(|v| v.as_str()).ok_or(())?;
    let decoding = jsonwebtoken::DecodingKey::from_rsa_components(n, e).map_err(|_| ())?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);
    let data = jsonwebtoken::decode::<Value>(id_token, &decoding, &validation).map_err(|_| ())?;
    Ok(data.claims)
}

async fn exchange_github(state: &AppState, code: &str) -> Result<Identity, ()> {
    let s = &state.settings;
    let client = reqwest::Client::new();
    let token_json: Value = client
        .post("https://github.com/login/oauth/access_token")
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("client_id", s.github_client_id.as_str()),
            ("client_secret", s.github_client_secret.as_str()),
            ("code", code),
            ("redirect_uri", s.oauth_redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|_| ())?
        .json()
        .await
        .map_err(|_| ())?;
    let token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or(())?
        .to_string();

    let me: Value = client
        .get("https://api.github.com/user")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(reqwest::header::USER_AGENT, "PrysmNote-SSO")
        .send()
        .await
        .map_err(|_| ())?
        .json()
        .await
        .map_err(|_| ())?;

    let mut email = me
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if email.is_empty() {
        let emails: Value = client
            .get("https://api.github.com/user/emails")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::USER_AGENT, "PrysmNote-SSO")
            .send()
            .await
            .map_err(|_| ())?
            .json()
            .await
            .map_err(|_| ())?;
        if let Some(list) = emails.as_array() {
            for entry in list {
                let primary = entry.get("primary").and_then(|v| v.as_bool()).unwrap_or(false);
                let verified = entry.get("verified").and_then(|v| v.as_bool()).unwrap_or(false);
                if primary && verified {
                    if let Some(found) = entry.get("email").and_then(|v| v.as_str()) {
                        email = found.to_string();
                        break;
                    }
                }
            }
        }
    }

    let name = me
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .or_else(|| me.get("login").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    Ok(Identity {
        email,
        name,
        email_verified: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const SECRET: &str = "test-secret-key-that-is-at-least-32-chars!";
    const ORIGIN: &str = "http://localhost:3000";

    fn test_settings() -> crate::config::Settings {
        crate::config::Settings {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://localhost:5432/prysm_note".to_string()),
            jwt_secret_key: SECRET.to_string(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".to_string(),
            app_origin: ORIGIN.to_string(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".to_string(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: format!("{ORIGIN}/api/auth/oauth/google/callback"),
            google_client_id: "google-client".to_string(),
            google_client_secret: "google-secret".to_string(),
            github_client_id: "github-client".to_string(),
            github_client_secret: "github-secret".to_string(),
            redis_url: String::new(),
            csrf_enabled: false,
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

    fn app(state: AppState) -> Router {
        router().merge(mobile_router()).with_state(state)
    }

    async fn get(state: AppState, uri: &str) -> Response {
        app(state)
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    fn location(response: &Response) -> String {
        response
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    }

    fn set_cookies(response: &Response) -> Vec<String> {
        response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(|v| v.to_string())
            .collect()
    }

    #[tokio::test]
    async fn start_redirects_to_provider_and_sets_state() {
        let state = AppState::lazy(test_settings());
        let response = get(state, "/api/auth/oauth/google/start").await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(location(&response).starts_with("https://accounts.google.com/o/oauth2/v2/auth"));
        assert!(set_cookies(&response)
            .iter()
            .any(|c| c.starts_with("oauth_state=")));
    }

    #[tokio::test]
    async fn start_reports_unconfigured() {
        let mut settings = test_settings();
        settings.google_client_id = String::new();
        settings.google_client_secret = String::new();
        let state = AppState::lazy(settings);
        let response = get(state, "/api/auth/oauth/google/start").await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(location(&response).contains("/login?error=sso_not_configured"));
    }

    #[tokio::test]
    async fn start_reports_unsupported_provider() {
        let state = AppState::lazy(test_settings());
        let response = get(state, "/api/auth/oauth/facebook/start").await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(location(&response).contains("/login?error=unsupported_provider"));
    }

    #[tokio::test]
    async fn callback_rejects_state_mismatch() {
        let state = AppState::lazy(test_settings());
        let response = get(state, "/api/auth/oauth/google/callback?code=abc&state=wrong").await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert!(location(&response).contains("/login?error=sso_invalid_state"));
    }

    #[tokio::test]
    async fn callback_propagates_provider_error() {
        let state = AppState::lazy(test_settings());
        let response = get(state, "/api/auth/oauth/google/callback?error=access_denied").await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert!(location(&response).contains("/login?error=sso_access_denied"));
    }

    #[tokio::test]
    async fn oauth_get_or_create_links_provider() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = crate::db::connect(&url).await.expect("connect test db");
        let email = format!("rust-oauth-{}@test.local", Uuid::new_v4());

        let first = user::get_or_create_oauth_user(&pool, &email, Some("Ada"), "google")
            .await
            .expect("first get_or_create");
        assert_eq!(first.provider.as_deref(), Some("google"));
        assert!(first.email_verified);
        assert_eq!(first.display_name.as_deref(), Some("Ada"));

        let second = user::get_or_create_oauth_user(&pool, &email, Some("Grace"), "github")
            .await
            .expect("second get_or_create");
        assert_eq!(second.id, first.id);
        assert_eq!(second.provider.as_deref(), Some("google"));
        assert!(second.email_verified);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(first.id)
            .execute(&pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn mobile_exchange_rejects_a_bad_code() {
        let state = AppState::lazy(test_settings());
        let response = get(state, "/api/auth/mobile/exchange?code=not-a-token").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
