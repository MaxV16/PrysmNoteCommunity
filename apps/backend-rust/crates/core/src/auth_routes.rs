//! `/api/auth` routes: register, login, logout, and the current user.
//!
//! Phase 1 mirrors the Python handlers' observable behaviour (status codes,
//! `{"detail": ...}` errors, and the `access_token` / `refresh_token` cookies)
//! so the same clients work against either backend. Email verification and the
//! Turnstile / risk hooks are not ported yet.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

use crate::auth;
use crate::blacklist;
use crate::cookies;
use crate::error::ApiError;
use crate::jwt;
use crate::password;
use crate::ratelimit::RateLimiter;
use crate::user;
use crate::AppState;

/// A bcrypt hash of a value nobody knows, used to keep login constant-time when
/// the email does not exist (matches the Python backend's dummy hash).
const DUMMY_PASSWORD_HASH: &str = "$2b$12$npo8ck20FZ0/oeuQ0NZ1WecPA6obLb3XmGosbpNaiNkjIYKf0/KpW";

/// Password floor in bytes (matches the Python backend).
const PASSWORD_MIN: usize = 8;
/// Password ceiling in bytes (bcrypt truncates past 72; matches Python).
const PASSWORD_MAX: usize = 72;

/// Failed-login tracking window; reaching the limit blocks the IP.
const FAILED_LOGIN_WINDOW: Duration = Duration::from_secs(300);
/// Failed logins within the window before the IP is blocked.
const FAILED_LOGIN_LIMIT: u32 = 10;
/// How long an IP stays blocked after too many failed logins.
const IP_BLOCK_DURATION: Duration = Duration::from_secs(15 * 60);

/// Process-wide failed-login limiter (`rl:auth`), matching Python's module-level
/// `_auth_limiter`. Uses Redis when configured, else the in-process fallback.
fn auth_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:auth"))
}

/// Record a failed login and block the IP once the threshold is crossed.
async fn track_failed_login(ip: &str) {
    let count = auth_limiter()
        .count(&format!("authfail:{ip}"), FAILED_LOGIN_WINDOW)
        .await;
    if count >= FAILED_LOGIN_LIMIT {
        auth_limiter()
            .block(&format!("authblock:{ip}"), IP_BLOCK_DURATION)
            .await;
    }
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub turnstile_token: Option<String>,
    /// Collected by the EE risk collector (fingerprint hash + behavioral
    /// counters); ignored in the core build, consumed by an EE hook.
    #[serde(default)]
    pub risk_profile: Option<Value>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize, Default)]
pub struct RefreshRequest {
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Deserialize)]
pub struct VerifyEmailRequest {
    pub token: String,
}

#[derive(Deserialize)]
pub struct ResendVerificationRequest {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ForgotPasswordRequest {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    pub token: String,
    pub new_password: String,
}

/// Process-wide outbound-mail limiter (`rl:mail`), matching Python's
/// module-level `_mail_limiter` (5 emails per hour per address and per IP).
fn mail_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:mail"))
}

/// Process-wide signup throttle (`rl:signup`). Unlike the mail limiter this
/// only engages when Redis is configured: a single-writer VM must never be
/// locked out of its own signup page by the in-memory fallback, and the test
/// suite (no Redis) stays deterministic.
fn signup_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:signup"))
}

/// Flood safety net per IP, never a normal shared-network threshold.
const SIGNUP_IP_LIMIT: u32 = 50;
const SIGNUP_IP_WINDOW: Duration = Duration::from_secs(3600);
/// Per-address daily cap.
const SIGNUP_EMAIL_LIMIT: u32 = 3;
const SIGNUP_EMAIL_WINDOW: Duration = Duration::from_secs(86400);

/// Cloudflare Turnstile siteverify endpoint.
const TURNSTILE_SITEVERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/// Verify a Cloudflare Turnstile response token. Skipped entirely (true) when
/// no secret is configured; fail-closed on a clearly-invalid token, but
/// fail-open on transport errors so a Turnstile outage cannot lock out signups.
async fn verify_turnstile(secret: &str, token: &str, ip: Option<&str>) -> bool {
    if secret.is_empty() {
        return true;
    }
    if token.is_empty() {
        return false;
    }
    let mut form: Vec<(&str, &str)> = vec![("secret", secret), ("response", token)];
    if let Some(ip) = ip {
        form.push(("remoteip", ip));
    }
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
        Ok(client) => client,
        Err(_) => return true,
    };
    match client.post(TURNSTILE_SITEVERIFY_URL).form(&form).send().await {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(data) => data.get("success").and_then(Value::as_bool).unwrap_or(false),
            Err(_) => true,
        },
        Err(_) => true,
    }
}

/// Throttle account creation per IP and per address (Redis only).
async fn enforce_signup_rate_limit(headers: &HeaderMap, email: &str) -> Result<(), ApiError> {
    if !signup_limiter().uses_redis() {
        return Ok(());
    }
    let ip = crate::middleware::client_ip(headers);
    if signup_limiter().count(&format!("ip:{ip}"), SIGNUP_IP_WINDOW).await > SIGNUP_IP_LIMIT {
        return Err(ApiError::TooManyRequests(
            "Too many signups from this address - try again later".into(),
        ));
    }
    if signup_limiter()
        .count(&format!("email:{email}"), SIGNUP_EMAIL_WINDOW)
        .await
        > SIGNUP_EMAIL_LIMIT
    {
        return Err(ApiError::TooManyRequests(
            "Too many signups for this email - try again later".into(),
        ));
    }
    Ok(())
}

/// Mail window in seconds (one hour).
const MAIL_WINDOW: Duration = Duration::from_secs(3600);
/// Mail requests allowed per address and per IP within the window.
const MAIL_LIMIT: u32 = 5;

async fn enforce_mail_rate_limit(headers: &HeaderMap, email: &str) -> Result<(), ApiError> {
    let ip = crate::middleware::client_ip(headers);
    if mail_limiter().count(&format!("email:{email}"), MAIL_WINDOW).await > MAIL_LIMIT {
        return Err(ApiError::TooManyRequests("Too many requests - try again later".into()));
    }
    if mail_limiter().count(&format!("ip:{ip}"), MAIL_WINDOW).await > MAIL_LIMIT {
        return Err(ApiError::TooManyRequests("Too many requests - try again later".into()));
    }
    Ok(())
}

/// Mint a 24h verify link and email it (fire-and-forget); no-op without a mailer.
fn send_verification_email(settings: &crate::config::Settings, user: &user::User) {
    let Ok(token) = jwt::encode_extra(
        &settings.jwt_secret_key,
        &user.id.to_string(),
        "verify",
        24 * 3600,
        Some(&user.email),
        None,
    ) else {
        return;
    };
    let verify_url = format!("{}/verify-email?token={}", settings.app_origin, token);
    let body = format!(
        "Welcome to Prysm Note!\n\nPlease confirm your email address by opening the link below (valid for 24 hours):\n\n{verify_url}\n\nIf you didn't create this account, you can safely ignore this email."
    );
    let settings = settings.clone();
    let to = user.email.clone();
    tokio::spawn(async move {
        let _ = crate::email::send_email(&settings, &to, "[Prysm Note] Verify your email", &body, None)
            .await;
    });
}

/// The `/api/auth` sub-router, mounted into the core router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/auth/verify-email", post(verify_email))
        .route("/api/auth/resend-verification", post(resend_verification))
        .route("/api/auth/forgot-password", post(forgot_password))
        .route("/api/auth/reset-password", post(reset_password))
        .route("/api/auth/me", get(me).delete(delete_account))
}

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// A pragmatic email check: local@domain.tld with no whitespace.
fn valid_email(email: &str) -> bool {
    let mut parts = email.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => {
            !local.is_empty()
                && !local.contains(char::is_whitespace)
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains(char::is_whitespace)
        }
        _ => false,
    }
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn token_error(err: String) -> ApiError {
    ApiError::Internal(err)
}

pub(crate) fn user_json(user: &user::User) -> Value {
    json!({
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "email_verified": user.email_verified,
        "requires_verification": false,
    })
}

/// Build a JSON response carrying both auth cookies. The cookies are appended
/// (not inserted) so the access and refresh Set-Cookie headers both survive.
pub(crate) fn session_response(user: &user::User, access: &str, refresh: &str, secure: bool) -> Response {
    let [access_cookie, refresh_cookie] = cookies::auth_cookies(access, refresh, secure);
    let mut response = Json(user_json(user)).into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&access_cookie) {
        headers.append(SET_COOKIE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&refresh_cookie) {
        headers.append(SET_COOKIE, value);
    }
    response
}

async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Response, ApiError> {
    let email = normalize_email(&req.email);

    // Human check first (fail-open without a secret), then the signup throttle.
    let ip = crate::middleware::client_ip(&headers);
    if !verify_turnstile(
        &state.settings.turnstile_secret_key(),
        req.turnstile_token.as_deref().unwrap_or(""),
        Some(&ip),
    )
    .await
    {
        return Err(ApiError::BadRequest(
            "Unable to verify you're human. Please try again.".into(),
        ));
    }
    enforce_signup_rate_limit(&headers, &email).await?;

    // Note: the legacy login brute-force IP block is deliberately NOT applied
    // to register; a blocked IP must not lock out legit signups from the same
    // network. The EE risk engine (absent in core) handles signup abuse.

    if !valid_email(&email) {
        return Err(ApiError::Unprocessable("Enter a valid email address".into()));
    }
    if !(PASSWORD_MIN..=PASSWORD_MAX).contains(&req.password.len()) {
        return Err(ApiError::Unprocessable(
            "Password must be between 8 and 72 characters".into(),
        ));
    }

    // EE risk hook (absent in the community build): score the signup before any
    // user row is created. A block rejects with an object detail + reference
    // header; a challenge forces email verification below; any error fails open.
    let mut must_verify_override = false;
    let empty_profile = Value::Null;
    let risk_profile = req.risk_profile.as_ref().unwrap_or(&empty_profile);
    match crate::risk::assess_signup(&email, &ip, risk_profile).await {
        crate::risk::RiskOutcome::Block(response) => return Ok(response),
        crate::risk::RiskOutcome::Challenge => must_verify_override = true,
        crate::risk::RiskOutcome::Allow => {}
    }

    if user::get_by_email(&state.pool, &email)
        .await
        .map_err(db_error)?
        .is_some()
    {
        return Err(ApiError::Conflict("Email already registered".into()));
    }

    let hash = password::hash_password(&req.password)
        .map_err(|_| ApiError::Internal("failed to hash password".into()))?;
    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());

    let created = user::create_email_user(&state.pool, &email, &hash, display_name)
        .await
        .map_err(db_error)?;

    // One-time welcome note, off the request path, no-op without a mailer.
    {
        let settings = state.settings.clone();
        let to = created.email.clone();
        let name = created.display_name.clone();
        tokio::spawn(async move {
            let _ = crate::email::send_welcome_email(&settings, &to, name.as_deref()).await;
        });
    }

    // When the deployment requires verification - or the risk engine
    // challenged this signup - do not log the user in; they must click the link
    // in the verification email first.
    if state.settings.require_email_verification() || must_verify_override {
        send_verification_email(&state.settings, &created);
        return Ok(Json(json!({
            "id": created.id,
            "email": created.email,
            "display_name": created.display_name,
            "email_verified": false,
            "requires_verification": true,
        }))
        .into_response());
    }

    let user_id = created.id.to_string();
    crate::lifecycle::touch_activity(&state, created.id);
    let access =
        jwt::encode_access(&state.settings.jwt_secret_key, &user_id, created.token_version)
            .map_err(token_error)?;
    let refresh =
        jwt::encode_refresh(&state.settings.jwt_secret_key, &user_id, created.token_version)
            .map_err(token_error)?;
    Ok(session_response(
        &created,
        &access,
        &refresh,
        state.settings.is_production(),
    ))
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let ip = crate::middleware::client_ip(&headers);
    if auth_limiter()
        .is_blocked(&format!("authblock:{ip}"))
        .await
    {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "detail": "IP blocked" })),
        )
            .into_response());
    }

    let email = normalize_email(&req.email);
    let found = user::get_by_email(&state.pool, &email)
        .await
        .map_err(db_error)?;

    // Always run bcrypt so a missing email and a wrong password take the same time.
    let hash = found
        .as_ref()
        .and_then(|row| row.password_hash.clone())
        .unwrap_or_else(|| DUMMY_PASSWORD_HASH.to_string());
    let ok = password::verify_password(&req.password, &hash);
    let user = match (found, ok) {
        (Some(row), true) => row,
        _ => {
            track_failed_login(&ip).await;
            return Err(ApiError::Unauthorized("Invalid credentials".into()));
        }
    };

    let user_id = user.id.to_string();
    crate::lifecycle::touch_activity(&state, user.id);
    let access = jwt::encode_access(&state.settings.jwt_secret_key, &user_id, user.token_version)
        .map_err(token_error)?;
    let refresh = jwt::encode_refresh(&state.settings.jwt_secret_key, &user_id, user.token_version)
        .map_err(token_error)?;
    Ok(session_response(
        &user,
        &access,
        &refresh,
        state.settings.is_production(),
    ))
}

/// Tokens presented on this request: the access/refresh cookies plus any
/// `Authorization: Bearer` access token.
fn presented_tokens(headers: &HeaderMap) -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(token) = cookie_value(headers, "access_token") {
        tokens.push(token);
    }
    if let Some(token) = cookie_value(headers, "refresh_token") {
        tokens.push(token);
    }
    if let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(token) = value.strip_prefix("Bearer ") {
            tokens.push(token.to_string());
        }
    }
    tokens
}

fn append_cookies(response: &mut Response, cookies: &[String]) {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(cookie) {
            response.headers_mut().append(SET_COOKIE, value);
        }
    }
}

/// Blacklist every token presented on the request (best effort).
async fn blacklist_presented(state: &AppState, headers: &HeaderMap) {
    for token in presented_tokens(headers) {
        if let Ok(claims) = jwt::decode(&state.settings.jwt_secret_key, &token) {
            if let Ok(user_id) = uuid::Uuid::parse_str(&claims.sub) {
                let _ = blacklist::add(&state.pool, &claims.jti, user_id, claims.exp).await;
            }
        }
    }
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    blacklist_presented(&state, &headers).await;
    let [access_cookie, refresh_cookie] = cookies::clear_cookies(state.settings.is_production());
    let mut response = Json(json!({ "status": "logged_out" })).into_response();
    append_cookies(&mut response, &[access_cookie, refresh_cookie]);
    response
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Response, ApiError> {
    let token = auth::token_from_headers(&headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".into()))?;
    let auth_user = auth::authenticate(&state.settings.jwt_secret_key, &token)?;

    let bytes = req.new_password.len();
    if bytes < PASSWORD_MIN || bytes > PASSWORD_MAX {
        return Err(ApiError::Unprocessable(
            "Password must be between 8 and 72 characters".into(),
        ));
    }

    let user = user::get_by_id(&state.pool, auth_user.user_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::Unauthorized("Could not validate credentials".into()))?;
    let current_ok = user
        .password_hash
        .as_deref()
        .map(|hash| password::verify_password(&req.current_password, hash))
        .unwrap_or(false);
    if !current_ok {
        return Err(ApiError::Unauthorized("Current password is incorrect".into()));
    }

    let new_hash = password::hash_password(&req.new_password)
        .map_err(|_| ApiError::Internal("failed to hash password".into()))?;
    let updated = user::update_password(&state.pool, auth_user.user_id, &new_hash)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::Unauthorized("Could not validate credentials".into()))?;

    // Invalidate every token minted before the change, then re-mint this
    // device's cookies so the caller stays signed in.
    blacklist_presented(&state, &headers).await;
    let sub = updated.id.to_string();
    let access = jwt::encode_access(&state.settings.jwt_secret_key, &sub, updated.token_version)
        .map_err(token_error)?;
    let refresh = jwt::encode_refresh(&state.settings.jwt_secret_key, &sub, updated.token_version)
        .map_err(token_error)?;
    Ok(session_response(
        &updated,
        &access,
        &refresh,
        state.settings.is_production(),
    ))
}

async fn verify_email(
    State(state): State<AppState>,
    Json(req): Json<VerifyEmailRequest>,
) -> Result<Response, ApiError> {
    let claims = jwt::decode_extra(&state.settings.jwt_secret_key, &req.token).map_err(|_| {
        ApiError::BadRequest("Invalid or expired link".into())
    })?;
    if claims.token_type != "verify" {
        return Err(ApiError::BadRequest("Invalid or expired link".into()));
    }
    let Some(expected_email) = claims.email.clone() else {
        return Err(ApiError::BadRequest("Invalid or expired link".into()));
    };
    let user_id = uuid::Uuid::parse_str(&claims.sub)
        .map_err(|_| ApiError::BadRequest("Invalid or expired link".into()))?;

    let user = user::get_by_id(&state.pool, user_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::BadRequest("Invalid or expired link".into()))?;
    // The token is bound to the email it was issued for, so a stale token can
    // not confirm an address the user changed since (idempotent on re-click).
    if user.email != expected_email {
        return Err(ApiError::BadRequest("Invalid or expired link".into()));
    }

    sqlx::query("UPDATE users SET email_verified = true WHERE id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(db_error)?;

    let sub = user.id.to_string();
    let access = jwt::encode_access(&state.settings.jwt_secret_key, &sub, user.token_version)
        .map_err(token_error)?;
    let refresh = jwt::encode_refresh(&state.settings.jwt_secret_key, &sub, user.token_version)
        .map_err(token_error)?;
    let [access_cookie, refresh_cookie] =
        cookies::auth_cookies(&access, &refresh, state.settings.is_production());
    let mut response = Json(json!({
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "email_verified": true,
    }))
    .into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&access_cookie) {
        headers.append(SET_COOKIE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&refresh_cookie) {
        headers.append(SET_COOKIE, value);
    }
    Ok(response)
}

async fn resend_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ResendVerificationRequest>,
) -> Result<Json<Value>, ApiError> {
    let email = normalize_email(&req.email);
    // Always the same response so the endpoint cannot enumerate accounts.
    if enforce_mail_rate_limit(&headers, &email).await.is_err() {
        return Err(ApiError::TooManyRequests("Too many requests - try again later".into()));
    }
    if let Some(account) = user::get_by_email(&state.pool, &email).await.map_err(db_error)? {
        if account.password_hash.is_some() && !account.email_verified {
            send_verification_email(&state.settings, &account);
        }
    }
    Ok(Json(json!({"status": "sent"})))
}

async fn forgot_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ForgotPasswordRequest>,
) -> Result<Json<Value>, ApiError> {
    let email = normalize_email(&req.email);
    if enforce_mail_rate_limit(&headers, &email).await.is_err() {
        return Err(ApiError::TooManyRequests("Too many requests - try again later".into()));
    }

    // Always the same response so the endpoint cannot enumerate accounts.
    let Some(account) = user::get_by_email(&state.pool, &email).await.map_err(db_error)? else {
        return Ok(Json(json!({"status": "sent"})));
    };
    if account.password_hash.is_none() {
        return Ok(Json(json!({"status": "sent"})));
    }

    let jti = uuid::Uuid::new_v4().to_string();
    let Ok(token) = jwt::encode_extra(
        &state.settings.jwt_secret_key,
        &account.id.to_string(),
        "reset",
        30 * 60,
        None,
        Some(&jti),
    ) else {
        return Ok(Json(json!({"status": "sent"})));
    };
    let reset_url = format!("{}/reset-password?token={}", state.settings.app_origin, token);
    let body = format!(
        "We received a request to reset the password for your Prysm Note account.\n\nOpen the link below to choose a new password (valid for 30 minutes):\n\n{reset_url}\n\nIf you didn't request this, you can safely ignore this email - your password won't change."
    );
    let settings = state.settings.clone();
    let to = account.email.clone();
    tokio::spawn(async move {
        let _ =
            crate::email::send_email(&settings, &to, "[Prysm Note] Reset your password", &body, None)
                .await;
    });
    Ok(Json(json!({"status": "sent"})))
}

async fn reset_password(
    State(state): State<AppState>,
    Json(req): Json<ResetPasswordRequest>,
) -> Result<Json<Value>, ApiError> {
    let invalid = || ApiError::BadRequest("Invalid or expired token".into());

    let bytes = req.new_password.as_bytes().len();
    if bytes < PASSWORD_MIN || bytes > PASSWORD_MAX {
        return Err(ApiError::Unprocessable(
            "Password must be between 8 and 72 characters".into(),
        ));
    }

    let claims = jwt::decode_extra(&state.settings.jwt_secret_key, &req.token).map_err(|_| invalid())?;
    if claims.token_type != "reset" {
        return Err(invalid());
    }
    let user_id = uuid::Uuid::parse_str(&claims.sub).map_err(|_| invalid())?;

    let account = user::get_by_id(&state.pool, user_id)
        .await
        .map_err(db_error)?
        .filter(|u| u.password_hash.is_some())
        .ok_or_else(invalid)?;

    // One-time use: blacklist the reset token's jti (race-safe).
    if let Some(jti) = claims.jti.as_deref() {
        let consumed = blacklist::add_once(&state.pool, jti, user_id, claims.exp)
            .await
            .map_err(db_error)?;
        if !consumed {
            return Err(invalid());
        }
    }

    let new_hash = password::hash_password(&req.new_password)
        .map_err(|_| ApiError::Internal("failed to hash password".into()))?;
    user::update_password(&state.pool, account.id, &new_hash)
        .await
        .map_err(db_error)?
        .ok_or_else(invalid)?;
    Ok(Json(json!({"status": "password_reset"})))
}

async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token = auth::token_from_headers(&headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".into()))?;
    let auth_user = auth::authenticate(&state.settings.jwt_secret_key, &token)?;

    // Shared routine: audit tombstone (account_deletions + the EE billing
    // tombstone) then cascade-delete the user's personal data.
    crate::lifecycle::delete_user_account(
        &state.pool,
        auth_user.user_id,
        crate::lifecycle::REASON_USER_REQUEST,
    )
    .await
    .map_err(db_error)?;

    let [access_cookie, refresh_cookie] = cookies::clear_cookies(state.settings.is_production());
    let mut response = Json(json!({ "status": "deleted" })).into_response();
    append_cookies(&mut response, &[access_cookie, refresh_cookie]);
    Ok(response)
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let token = auth::token_from_headers(&headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".into()))?;
    let auth_user = auth::authenticate(&state.settings.jwt_secret_key, &token)?;
    let claims = jwt::decode(&state.settings.jwt_secret_key, &token)
        .map_err(|_| ApiError::Unauthorized("Could not validate credentials".into()))?;
    if blacklist::contains(&state.pool, &claims.jti)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::Unauthorized("Could not validate credentials".into()));
    }
    let user = user::get_by_id(&state.pool, auth_user.user_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::Unauthorized("Could not validate credentials".into()))?;
    if user.token_version != auth_user.token_version {
        return Err(ApiError::Unauthorized("Could not validate credentials".into()));
    }
    Ok(Json(user_json(&user)))
}

/// Read a cookie value from the request headers.
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

/// `POST /api/auth/refresh` - exchange a refresh token for a fresh cookie pair.
/// The token may arrive as the `refresh_token` cookie or in the JSON body.
///
/// The body is read as raw bytes and parsed leniently: some clients send
/// `Content-Type: application/json` with an empty body (the token lives in the
/// cookie), and a strict `Json` extractor would reject that with a 400 before
/// the cookie is ever considered. An empty or malformed body simply means "no
/// body token".
async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body_token = serde_json::from_slice::<RefreshRequest>(&body)
        .ok()
        .and_then(|payload| payload.refresh_token);
    let token = cookie_value(&headers, "refresh_token")
        .or(body_token)
        .ok_or_else(|| ApiError::Unauthorized("Refresh token required".into()))?;

    let unauthorized = || ApiError::Unauthorized("Could not validate credentials".into());
    let claims = jwt::decode(&state.settings.jwt_secret_key, &token).map_err(|_| unauthorized())?;
    if claims.token_type != jwt::REFRESH {
        return Err(unauthorized());
    }
    let user_id = uuid::Uuid::parse_str(&claims.sub).map_err(|_| unauthorized())?;
    let user = user::get_by_id(&state.pool, user_id)
        .await
        .map_err(db_error)?
        .ok_or_else(unauthorized)?;
    if user.token_version != claims.tv {
        return Err(unauthorized());
    }

    let sub = user.id.to_string();
    let access = jwt::encode_access(&state.settings.jwt_secret_key, &sub, user.token_version)
        .map_err(token_error)?;
    let new_refresh =
        jwt::encode_refresh(&state.settings.jwt_secret_key, &sub, user.token_version)
            .map_err(token_error)?;
    Ok(session_response(
        &user,
        &access,
        &new_refresh,
        state.settings.is_production(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use uuid::Uuid;
    use crate::config::Settings;
    use crate::{build_router, AppState};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let pool = crate::db::connect(&url).await.ok()?;
        let settings = Settings {
            database_url: url,
            jwt_secret_key: "test-secret-key-that-is-at-least-32-chars!".into(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".into(),
            app_origin: "http://localhost:3000".into(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".into(),
            webauthn_origins: String::new(),
            oauth_redirect_uri:
                "http://localhost:3000/api/auth/oauth/google/callback".into(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: false,
            csrf_allowed_origins: "http://localhost:3000".into(),
            api_rate_limit_enabled: true,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".into(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: "mailto:support@prysmnote.com".to_string(),
            notify_email: String::new(),
            notification_loop_interval: 1800,
            digest_hour: 7,
        };
        let state = AppState::new(pool, settings);
        // Apply the additive migrations (account_deletions / user activity
        // columns) so the delete-account route has its audit table.
        let _ = crate::schema::ensure_schema(&state.pool, &state.system_pool).await;
        Some(state)
    }

    async fn post_json(app: &Router, uri: &str, body: Value) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn post_json_from_ip(app: &Router, uri: &str, body: Value, ip: &str) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .header("x-forwarded-for", ip)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    fn access_cookie(res: &Response) -> Option<String> {
        res.headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find(|cookie| cookie.starts_with("access_token="))
            .map(|cookie| cookie.split(';').next().unwrap().to_string())
    }

    fn refresh_cookie(res: &Response) -> Option<String> {
        res.headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find(|cookie| cookie.starts_with("refresh_token="))
            .map(|cookie| cookie.split(';').next().unwrap().to_string())
    }

    #[tokio::test]
    async fn repeated_failed_logins_block_the_ip() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let ip = format!("203.0.113.{}", (Uuid::new_v4().as_bytes()[0] % 250) + 1);
        for _ in 0..FAILED_LOGIN_LIMIT {
            let res = post_json_from_ip(
                &app,
                "/api/auth/login",
                json!({ "email": "nobody@test.local", "password": "wrongwrong" }),
                &ip,
            )
            .await;
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        }
        let blocked = post_json_from_ip(
            &app,
            "/api/auth/login",
            json!({ "email": "nobody@test.local", "password": "wrongwrong" }),
            &ip,
        )
        .await;
        assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn change_password_bumps_the_version_and_invalidates_the_old_token() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-pw-{}@test.local", Uuid::new_v4());

        let registered = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": email, "password": "password123" }),
        )
        .await;
        assert_eq!(registered.status(), StatusCode::OK);
        let access = access_cookie(&registered).expect("access cookie");

        let changed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/change-password")
                    .header("content-type", "application/json")
                    .header("cookie", access.clone())
                    .body(Body::from(
                        json!({
                            "current_password": "password123",
                            "new_password": "password456",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(changed.status(), StatusCode::OK);

        // The access token presented before the change is now rejected.
        let me = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/auth/me")
                    .header("cookie", access)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(me.status(), StatusCode::UNAUTHORIZED);

        sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&email)
            .execute(&state.pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn delete_account_removes_the_user() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-del-{}@test.local", Uuid::new_v4());

        let registered = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": email, "password": "password123" }),
        )
        .await;
        assert_eq!(registered.status(), StatusCode::OK);
        let access = access_cookie(&registered).expect("access cookie");

        let deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/auth/me")
                    .header("cookie", access.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::OK);

        let me = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/auth/me")
                    .header("cookie", access)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(me.status(), StatusCode::UNAUTHORIZED);

        // The deletion leaves a non-personal audit tombstone; clear it so the
        // shared smoke database does not accumulate test rows.
        let _ = sqlx::query("DELETE FROM account_deletions WHERE email_hash = $1")
            .bind(crate::lifecycle::email_hash(&email))
            .execute(&state.pool)
            .await;
    }

    #[tokio::test]
    async fn refresh_issues_new_cookies() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-refresh-{}@test.local", Uuid::new_v4());

        let registered = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": email, "password": "password123" }),
        )
        .await;
        assert_eq!(registered.status(), StatusCode::OK);
        let refresh = refresh_cookie(&registered).expect("refresh cookie");

        let refreshed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/refresh")
                    .header("cookie", refresh)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(refreshed.status(), StatusCode::OK);
        assert!(access_cookie(&refreshed).is_some());

        let _ = sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&email)
            .execute(&state.pool)
            .await;
    }

    #[tokio::test]
    async fn refresh_accepts_a_json_content_type_with_an_empty_body() {
        // Regression: the web client sent `Content-Type: application/json` with
        // no body. A strict `Json` extractor rejected that with a 400 before the
        // refresh cookie was read, so every request after the 15-minute access
        // token expired failed to refresh and nothing saved.
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-refresh-empty-{}@test.local", Uuid::new_v4());

        let registered = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": email, "password": "password123" }),
        )
        .await;
        assert_eq!(registered.status(), StatusCode::OK);
        let refresh = refresh_cookie(&registered).expect("refresh cookie");

        let refreshed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/refresh")
                    .header("content-type", "application/json")
                    .header("cookie", refresh)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(refreshed.status(), StatusCode::OK);
        assert!(access_cookie(&refreshed).is_some());

        // Missing cookie + empty JSON body is a genuine 401, not a 400.
        let unauth = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/refresh")
                    .header("content-type", "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        let _ = sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&email)
            .execute(&state.pool)
            .await;
    }

    #[tokio::test]
    async fn register_login_and_me_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-auth-{}@test.local", Uuid::new_v4());

        let registered = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": email, "password": "password123" }),
        )
        .await;
        assert_eq!(registered.status(), StatusCode::OK);

        let logged_in = post_json(
            &app,
            "/api/auth/login",
            json!({ "email": email, "password": "password123" }),
        )
        .await;
        assert_eq!(logged_in.status(), StatusCode::OK);
        let cookie = access_cookie(&logged_in).expect("access cookie");

        let me = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/auth/me")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(me.status(), StatusCode::OK);

        sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&email)
            .execute(&state.pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn login_rejects_a_wrong_password() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-auth-{}@test.local", Uuid::new_v4());
        let _ = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": email, "password": "password123" }),
        )
        .await;

        let logged_in = post_json(
            &app,
            "/api/auth/login",
            json!({ "email": email, "password": "wrong-password" }),
        )
        .await;
        assert_eq!(logged_in.status(), StatusCode::UNAUTHORIZED);

        sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&email)
            .execute(&state.pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn register_rejects_an_invalid_email() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state, None);
        let registered = post_json(
            &app,
            "/api/auth/register",
            json!({ "email": "not-an-email", "password": "password123" }),
        )
        .await;
        assert_eq!(registered.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn verify_email_and_reset_password_flows() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-sidepath-{}@test.local", Uuid::new_v4());
        let created = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");

        // Verification link signs the user in and flips email_verified.
        let verify = jwt::encode_extra(
            &state.settings.jwt_secret_key,
            &created.id.to_string(),
            "verify",
            24 * 3600,
            Some(&email),
            None,
        )
        .unwrap();
        let verified = post_json(&app, "/api/auth/verify-email", json!({ "token": verify })).await;
        assert_eq!(verified.status(), StatusCode::OK);
        assert!(access_cookie(&verified).is_some());

        let is_verified: bool =
            sqlx::query_scalar("SELECT email_verified FROM users WHERE id = $1")
                .bind(created.id)
                .fetch_one(&state.pool)
                .await
                .expect("read verified");
        assert!(is_verified);

        // Forgot password always answers sent, for unknown and known addresses.
        let unknown = format!("rust-unknown-{}@test.local", Uuid::new_v4());
        let res = post_json(&app, "/api/auth/forgot-password", json!({ "email": unknown })).await;
        assert_eq!(res.status(), StatusCode::OK);
        let res = post_json(&app, "/api/auth/forgot-password", json!({ "email": email })).await;
        assert_eq!(res.status(), StatusCode::OK);

        // A reset token works once and is rejected on replay.
        let jti = Uuid::new_v4().to_string();
        let reset = jwt::encode_extra(
            &state.settings.jwt_secret_key,
            &created.id.to_string(),
            "reset",
            1800,
            None,
            Some(&jti),
        )
        .unwrap();
        let res = post_json(
            &app,
            "/api/auth/reset-password",
            json!({ "token": reset, "new_password": "a-new-password-123" }),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let replay = post_json(
            &app,
            "/api/auth/reset-password",
            json!({ "token": reset, "new_password": "another-password-456" }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(created.id)
            .execute(&state.pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn turnstile_is_skipped_without_a_secret() {
        // No TURNSTILE_SECRET_KEY configured: the check always passes, even
        // with an empty token (dev/tests/community stay simple).
        assert!(verify_turnstile("", "", None).await);
        assert!(verify_turnstile("", "any-token", Some("1.2.3.4")).await);
        // With a secret an empty token is rejected before any network call.
        assert!(!verify_turnstile("a-secret", "", None).await);
    }
}
