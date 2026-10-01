//! `/api/auth/passkey` routes: WebAuthn registration and usernameless login.
//!
//! Mirrors the Python `routers/passkeys.py` handler contract (paths, status
//! codes, `{"detail": ...}` errors, the `webauthn_challenge` cookie and the
//! stored credential encoding) so a browser works against either backend. The
//! challenge cookie carries the webauthn-rs server state (base64url JSON) for
//! the 300s handshake window; stored credentials stay byte-compatible (base64url
//! credential id + raw COSE public-key bytes).

use std::collections::BTreeMap;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;
use uuid::Uuid;
use webauthn_rs_core::proto::{
    AttestationFormat, AuthenticationState, COSEAlgorithm, COSEKey, COSEKeyType, Credential,
    CredentialID, ParsedAttestation, PublicKeyCredential, RegisterPublicKeyCredential,
    RegisteredExtensions, RegistrationState, UserVerificationPolicy,
};
use webauthn_rs_core::WebauthnCore;

use crate::app_login_codes;
use crate::auth::{self, AuthUser};
use crate::cookies;
use crate::error::ApiError;
use crate::passkey;
use crate::user;
use crate::AppState;

/// Name of the short-lived handshake cookie.
const CHALLENGE_COOKIE: &str = "webauthn_challenge";
/// Handshake lifetime in seconds (matches the Python backend).
const CHALLENGE_TTL: i64 = 300;
/// Maximum passkeys per account (matches the Python backend).
const MAX_PASSKEYS_PER_USER: usize = 20;
/// WebAuthn ceremony timeout, 300s (matches the Python backend default).
const WEBAUTHN_TIMEOUT: Duration = Duration::from_secs(300);

const CHALLENGE_EXPIRED: &str = "Challenge expired. Please try again.";
const COULD_NOT_REGISTER: &str = "Could not register this passkey.";
const SIGN_IN_FAILED: &str = "Passkey sign-in failed";

#[derive(Deserialize)]
pub struct RegisterVerifyRequest {
    pub credential: Value,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub struct RenamePasskeyRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct LoginVerifyRequest {
    pub credential: Value,
    #[serde(default)]
    pub desktop_nonce: Option<String>,
}

/// The `/api/auth/passkey` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/passkey/register/options", post(register_options))
        .route("/api/auth/passkey/register/verify", post(register_verify))
        .route("/api/auth/passkey/login/options", post(login_options))
        .route("/api/auth/passkey/login/verify", post(login_verify))
        .route("/api/auth/passkey", get(list_passkeys))
        .route(
            "/api/auth/passkey/{passkey_id}",
            axum::routing::patch(rename_passkey).delete(delete_passkey),
        )
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".into()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64url_decode(value: &str) -> Result<Vec<u8>, ApiError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::BadRequest(CHALLENGE_EXPIRED.into()))
}

/// Build the webauthn relying party for this request from settings.
fn webauthn(state: &AppState) -> Result<WebauthnCore, ApiError> {
    let origins: Vec<Url> = state
        .settings
        .resolved_webauthn_origins()
        .iter()
        .filter_map(|origin| Url::parse(origin).ok())
        .collect();
    if origins.is_empty() {
        return Err(ApiError::Internal(
            "no valid WebAuthn origins configured".into(),
        ));
    }
    Ok(WebauthnCore::new_unsafe_experts_only(
        &state.settings.webauthn_rp_name,
        &state.settings.resolved_webauthn_rp_id(),
        origins,
        WEBAUTHN_TIMEOUT,
        None,
        None,
    ))
}

/// Store a `webauthn_challenge` cookie of the form `flow:payload:user_id`.
fn set_challenge_cookie(response: &mut Response, flow: &str, payload: &str, user_id: &str, secure: bool) {
    let value = format!("{flow}:{payload}:{user_id}");
    let cookie = cookies::build_cookie(CHALLENGE_COOKIE, &value, CHALLENGE_TTL, secure);
    if let Ok(header) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(SET_COOKIE, header);
    }
}

fn clear_challenge_cookie(response: &mut Response, secure: bool) {
    let cookie = cookies::clear_cookie(CHALLENGE_COOKIE, secure);
    if let Ok(header) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(SET_COOKIE, header);
    }
}

/// Read and validate the challenge cookie, returning `(payload, user_id)`.
fn read_challenge(headers: &HeaderMap, expected_flow: &str) -> Result<(String, String), ApiError> {
    let raw = cookie_value(headers, CHALLENGE_COOKIE)
        .ok_or_else(|| ApiError::BadRequest(CHALLENGE_EXPIRED.into()))?;
    let mut parts = raw.splitn(3, ':');
    let flow = parts.next().unwrap_or("");
    let payload = parts.next().unwrap_or("");
    let user_id = parts.next().unwrap_or("");
    if flow != expected_flow || payload.is_empty() {
        return Err(ApiError::BadRequest(CHALLENGE_EXPIRED.into()));
    }
    Ok((payload.to_string(), user_id.to_string()))
}

fn iso(value: Option<chrono::DateTime<Utc>>) -> Value {
    match value {
        Some(dt) => Value::String(dt.to_rfc3339()),
        None => Value::Null,
    }
}

fn passkey_json(pk: &passkey::Passkey) -> Value {
    json!({
        "id": pk.id.to_string(),
        "name": pk.name,
        "created_at": iso(pk.created_at),
        "last_used_at": iso(pk.last_used_at),
        "aaguid": pk.aaguid,
        "transports": pk.transports,
    })
}

fn cose_alg_value(alg: COSEAlgorithm) -> i128 {
    match alg {
        COSEAlgorithm::ES256 => -7,
        COSEAlgorithm::ES384 => -35,
        COSEAlgorithm::ES512 => -36,
        COSEAlgorithm::RS256 => -257,
        COSEAlgorithm::RS384 => -258,
        COSEAlgorithm::RS512 => -259,
        COSEAlgorithm::PS256 => -37,
        COSEAlgorithm::PS384 => -38,
        COSEAlgorithm::PS512 => -39,
        COSEAlgorithm::EDDSA => -8,
        COSEAlgorithm::INSECURE_RS1 => -65535,
        _ => -7,
    }
}

/// Serialise a parsed COSE key back to raw COSE CBOR (integer-keyed map) so the
/// bytes stored in `passkeys.public_key` match what Python's py_webauthn wrote.
fn cose_key_to_cbor(key: &COSEKey) -> Result<Vec<u8>, ApiError> {
    let mut map: BTreeMap<serde_cbor::Value, serde_cbor::Value> = BTreeMap::new();
    let alg = cose_alg_value(key.type_);
    match &key.key {
        COSEKeyType::EC_EC2(ec) => {
            map.insert(serde_cbor::Value::Integer(1), serde_cbor::Value::Integer(2));
            map.insert(serde_cbor::Value::Integer(3), serde_cbor::Value::Integer(alg));
            let crv = match ec.curve {
                webauthn_rs_core::proto::ECDSACurve::SECP256R1 => 1,
                webauthn_rs_core::proto::ECDSACurve::SECP384R1 => 2,
                webauthn_rs_core::proto::ECDSACurve::SECP521R1 => 3,
            };
            map.insert(serde_cbor::Value::Integer(-1), serde_cbor::Value::Integer(crv));
            map.insert(
                serde_cbor::Value::Integer(-2),
                serde_cbor::Value::Bytes(ec.x.as_ref().to_vec()),
            );
            map.insert(
                serde_cbor::Value::Integer(-3),
                serde_cbor::Value::Bytes(ec.y.as_ref().to_vec()),
            );
        }
        COSEKeyType::RSA(rsa) => {
            map.insert(serde_cbor::Value::Integer(1), serde_cbor::Value::Integer(3));
            map.insert(serde_cbor::Value::Integer(3), serde_cbor::Value::Integer(alg));
            map.insert(
                serde_cbor::Value::Integer(-1),
                serde_cbor::Value::Bytes(rsa.n.as_ref().to_vec()),
            );
            map.insert(
                serde_cbor::Value::Integer(-2),
                serde_cbor::Value::Bytes(rsa.e.to_vec()),
            );
        }
        COSEKeyType::EC_OKP(okp) => {
            map.insert(serde_cbor::Value::Integer(1), serde_cbor::Value::Integer(1));
            map.insert(serde_cbor::Value::Integer(3), serde_cbor::Value::Integer(alg));
            let crv = match okp.curve {
                webauthn_rs_core::proto::EDDSACurve::ED25519 => 6,
                _ => 6,
            };
            map.insert(serde_cbor::Value::Integer(-1), serde_cbor::Value::Integer(crv));
            map.insert(
                serde_cbor::Value::Integer(-2),
                serde_cbor::Value::Bytes(okp.x.as_ref().to_vec()),
            );
        }
    }
    serde_cbor::to_vec(&map).map_err(|_| ApiError::Internal("failed to encode COSE key".into()))
}

fn cose_key_from_cbor(bytes: &[u8]) -> Result<COSEKey, ApiError> {
    let value: serde_cbor::Value =
        serde_cbor::from_slice(bytes).map_err(|_| ApiError::Unauthorized(SIGN_IN_FAILED.into()))?;
    COSEKey::try_from(&value).map_err(|_| ApiError::Unauthorized(SIGN_IN_FAILED.into()))
}

fn transports_from_str(value: Option<&str>) -> Option<Vec<webauthn_rs_core::proto::AuthenticatorTransport>> {
    let raw = value?;
    let items: Vec<_> = raw
        .split(',')
        .filter_map(|name| name.parse().ok())
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

/// Rebuild a webauthn-rs `Credential` from the stored database row.
fn credential_from_stored(stored: &passkey::Passkey) -> Result<Credential, ApiError> {
    let cred_id = CredentialID::from(b64url_decode(&stored.credential_id)?);
    let cred = cose_key_from_cbor(&stored.public_key)?;
    Ok(Credential {
        cred_id,
        cred,
        counter: stored.sign_count.max(0) as u32,
        transports: transports_from_str(stored.transports.as_deref()),
        user_verified: true,
        backup_eligible: false,
        backup_state: false,
        registration_policy: UserVerificationPolicy::Required,
        extensions: RegisteredExtensions::default(),
        attestation: ParsedAttestation::default(),
        attestation_format: AttestationFormat::None,
    })
}

/// Pull the 16-byte AAGUID out of an attestation object's authData.
fn aaguid_from_attestation(attestation_object: &[u8]) -> Option<String> {
    let value: serde_cbor::Value = serde_cbor::from_slice(attestation_object).ok()?;
    let serde_cbor::Value::Map(map) = value else {
        return None;
    };
    let auth_data = map
        .iter()
        .find_map(|(k, v)| match (k, v) {
            (serde_cbor::Value::Text(key), serde_cbor::Value::Bytes(bytes)) if key == "authData" => {
                Some(bytes.clone())
            }
            _ => None,
        })?;
    if auth_data.len() < 53 {
        return None;
    }
    let aaguid = &auth_data[37..53];
    if aaguid.iter().all(|b| *b == 0) {
        return Some("00000000-0000-0000-0000-000000000000".to_string());
    }
    Some(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        aaguid[0], aaguid[1], aaguid[2], aaguid[3], aaguid[4], aaguid[5], aaguid[6], aaguid[7],
        aaguid[8], aaguid[9], aaguid[10], aaguid[11], aaguid[12], aaguid[13], aaguid[14], aaguid[15]
    ))
}

async fn register_options(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let auth_user = require_user(&state, &headers)?;
    let core = webauthn(&state)?;

    let existing = passkey::list_for_user(&state.pool, auth_user.user_id)
        .await
        .map_err(db_error)?;
    let exclude: Vec<CredentialID> = existing
        .iter()
        .filter_map(|pk| b64url_decode(&pk.credential_id).ok().map(CredentialID::from))
        .collect();

    let user = user::get_by_id(&state.pool, auth_user.user_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".into()))?;

    let user_handle = user.id.to_string();
    let display_name = user.display_name.clone().unwrap_or_else(|| user.email.clone());
    let builder = core
        .new_challenge_register_builder(user_handle.as_bytes(), &user.email, &display_name)
        .map_err(|_| ApiError::Internal("failed to start registration".into()))?
        .exclude_credentials(Some(exclude))
        .require_resident_key(true)
        .user_verification_policy(UserVerificationPolicy::Required);

    let (challenge, reg_state) = core
        .generate_challenge_register(builder)
        .map_err(|_| ApiError::Internal("failed to generate challenge".into()))?;

    let payload = b64url_encode(
        &serde_json::to_vec(&reg_state)
            .map_err(|_| ApiError::Internal("failed to encode state".into()))?,
    );
    let mut response = Json(serde_json::to_value(&challenge).unwrap_or(Value::Null)).into_response();
    set_challenge_cookie(
        &mut response,
        "register",
        &payload,
        &user.id.to_string(),
        state.settings.is_production(),
    );
    Ok(response)
}

async fn register_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RegisterVerifyRequest>,
) -> Result<Response, ApiError> {
    let auth_user = require_user(&state, &headers)?;
    let core = webauthn(&state)?;
    let secure = state.settings.is_production();

    let (payload, cookie_user) = match read_challenge(&headers, "register") {
        Ok(parts) => parts,
        Err(err) => {
            let mut response = err.into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };
    if !cookie_user.is_empty() && cookie_user != auth_user.user_id.to_string() {
        let mut response = ApiError::BadRequest(CHALLENGE_EXPIRED.into()).into_response();
        clear_challenge_cookie(&mut response, secure);
        return Ok(response);
    }

    let state_bytes = b64url_decode(&payload).map_err(|_| ApiError::BadRequest(CHALLENGE_EXPIRED.into()))?;
    let reg_state: RegistrationState = match serde_json::from_slice(&state_bytes) {
        Ok(value) => value,
        Err(_) => {
            let mut response = ApiError::BadRequest(CHALLENGE_EXPIRED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let credential: RegisterPublicKeyCredential = match serde_json::from_value(req.credential) {
        Ok(value) => value,
        Err(_) => {
            let mut response = ApiError::BadRequest(COULD_NOT_REGISTER.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let raw_attestation = credential.response.attestation_object.as_ref().to_vec();
    let transports: Option<String> = credential
        .response
        .transports
        .as_ref()
        .map(|list| {
            list.iter()
                .map(|t| t.as_ref())
                .collect::<Vec<&str>>()
                .join(",")
        })
        .filter(|joined| !joined.is_empty())
        .map(|joined| joined.chars().take(64).collect());

    let verified = match core.register_credential(&credential, &reg_state, None) {
        Ok(verified) => verified,
        Err(_) => {
            let mut response = ApiError::BadRequest(COULD_NOT_REGISTER.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let credential_id = b64url_encode(verified.cred_id.as_ref());
    if passkey::get_by_credential_id(&state.pool, &credential_id)
        .await
        .map_err(db_error)?
        .is_some()
    {
        let mut response =
            ApiError::Conflict("This passkey is already registered.".into()).into_response();
        clear_challenge_cookie(&mut response, secure);
        return Ok(response);
    }

    let count = passkey::count_for_user(&state.pool, auth_user.user_id)
        .await
        .map_err(db_error)?;
    if count as usize >= MAX_PASSKEYS_PER_USER {
        let mut response =
            ApiError::BadRequest("You can register up to 20 passkeys.".into()).into_response();
        clear_challenge_cookie(&mut response, secure);
        return Ok(response);
    }

    let public_key = cose_key_to_cbor(&verified.cred).map_err(|_| {
        ApiError::Internal("failed to encode credential public key".into())
    })?;
    let aaguid = aaguid_from_attestation(&raw_attestation);
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(100).collect::<String>());

    let stored = passkey::insert(
        &state.pool,
        auth_user.user_id,
        &credential_id,
        &public_key,
        verified.counter as i32,
        transports.as_deref(),
        aaguid.as_deref(),
        name.as_deref(),
    )
    .await;

    let stored = match stored {
        Ok(value) => value,
        Err(_) => {
            let mut response =
                ApiError::Conflict("This passkey is already registered.".into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let body = json!({
        "id": stored.id.to_string(),
        "name": stored.name,
        "created_at": iso(stored.created_at),
    });
    let mut response = Json(body).into_response();
    clear_challenge_cookie(&mut response, secure);
    Ok(response)
}

async fn list_passkeys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let auth_user = require_user(&state, &headers)?;
    let keys = passkey::list_for_user(&state.pool, auth_user.user_id)
        .await
        .map_err(db_error)?;
    Ok(Json(Value::Array(keys.iter().map(passkey_json).collect())))
}

async fn rename_passkey(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(passkey_id): Path<String>,
    Json(req): Json<RenamePasskeyRequest>,
) -> Result<Response, ApiError> {
    let auth_user = require_user(&state, &headers)?;
    let id = Uuid::parse_str(&passkey_id).map_err(|_| ApiError::NotFound("Passkey not found".into()))?;
    passkey::get_for_user(&state.pool, id, auth_user.user_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Passkey not found".into()))?;

    let name: String = req.name.trim().chars().take(100).collect();
    if name.is_empty() {
        return Err(ApiError::Unprocessable("Name is required".into()));
    }
    let updated = passkey::rename(&state.pool, id, auth_user.user_id, &name)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Passkey not found".into()))?;
    Ok(Json(json!({
        "id": updated.id.to_string(),
        "name": updated.name,
    }))
    .into_response())
}

async fn delete_passkey(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(passkey_id): Path<String>,
) -> Result<Response, ApiError> {
    let auth_user = require_user(&state, &headers)?;
    let id = Uuid::parse_str(&passkey_id).map_err(|_| ApiError::NotFound("Passkey not found".into()))?;
    if !passkey::delete(&state.pool, id, auth_user.user_id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::NotFound("Passkey not found".into()));
    }
    Ok(axum::http::StatusCode::NO_CONTENT.into_response())
}

async fn login_options(State(state): State<AppState>) -> Result<Response, ApiError> {
    let core = webauthn(&state)?;
    let builder = core
        .new_challenge_authenticate_builder(vec![], Some(UserVerificationPolicy::Required))
        .map_err(|_| ApiError::Internal("failed to start authentication".into()))?;
    let (challenge, auth_state) = core
        .generate_challenge_authenticate(builder)
        .map_err(|_| ApiError::Internal("failed to generate challenge".into()))?;

    let payload = b64url_encode(
        &serde_json::to_vec(&auth_state)
            .map_err(|_| ApiError::Internal("failed to encode state".into()))?,
    );
    let mut response = Json(serde_json::to_value(&challenge).unwrap_or(Value::Null)).into_response();
    set_challenge_cookie(
        &mut response,
        "login",
        &payload,
        "",
        state.settings.is_production(),
    );
    Ok(response)
}

async fn login_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginVerifyRequest>,
) -> Result<Response, ApiError> {
    let core = webauthn(&state)?;
    let secure = state.settings.is_production();

    let (payload, _) = match read_challenge(&headers, "login") {
        Ok(parts) => parts,
        Err(err) => {
            let mut response = err.into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let state_bytes = match b64url_decode(&payload) {
        Ok(bytes) => bytes,
        Err(_) => {
            let mut response = ApiError::BadRequest(CHALLENGE_EXPIRED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };
    let mut auth_state: AuthenticationState = match serde_json::from_slice(&state_bytes) {
        Ok(value) => value,
        Err(_) => {
            let mut response = ApiError::BadRequest(CHALLENGE_EXPIRED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let credential: PublicKeyCredential = match serde_json::from_value(req.credential) {
        Ok(value) => value,
        Err(_) => {
            let mut response = ApiError::Unauthorized(SIGN_IN_FAILED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let credential_id = b64url_encode(credential.raw_id.as_ref());
    let stored = passkey::get_by_credential_id(&state.pool, &credential_id)
        .await
        .map_err(db_error)?;
    let stored = match stored {
        Some(value) => value,
        None => {
            let mut response = ApiError::Unauthorized(SIGN_IN_FAILED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let reconstructed = match credential_from_stored(&stored) {
        Ok(value) => value,
        Err(_) => {
            let mut response = ApiError::Unauthorized(SIGN_IN_FAILED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };
    auth_state.set_allowed_credentials(vec![reconstructed]);

    let result = match core.authenticate_credential(&credential, &auth_state) {
        Ok(value) => value,
        Err(_) => {
            let mut response = ApiError::Unauthorized(SIGN_IN_FAILED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    let user = match user::get_by_id(&state.pool, stored.user_id)
        .await
        .map_err(db_error)?
    {
        Some(value) => value,
        None => {
            let mut response = ApiError::Unauthorized(SIGN_IN_FAILED.into()).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    };

    passkey::touch_after_auth(&state.pool, stored.id, result.counter() as i32, Utc::now())
        .await
        .map_err(db_error)?;

    // Desktop deep-link handoff: mint a single-use code instead of cookies.
    if let Some(nonce) = req.desktop_nonce.as_deref() {
        if app_login_codes::is_safe_nonce(nonce) {
            let code = app_login_codes::create_app_login_code(
                &state.settings.jwt_secret_key,
                &user.id.to_string(),
            )
            .map_err(|err| ApiError::Internal(err))?;
            let redirect = format!(
                "{}?code={}&nonce={}",
                app_login_codes::DESKTOP_DEEP_LINK,
                code,
                nonce
            );
            let mut response = Json(json!({ "redirect": redirect })).into_response();
            clear_challenge_cookie(&mut response, secure);
            return Ok(response);
        }
    }

    let sub = user.id.to_string();
    let access = crate::jwt::encode_access(&state.settings.jwt_secret_key, &sub, user.token_version)
        .map_err(|err| ApiError::Internal(err))?;
    let refresh =
        crate::jwt::encode_refresh(&state.settings.jwt_secret_key, &sub, user.token_version)
            .map_err(|err| ApiError::Internal(err))?;
    let [access_cookie, refresh_cookie] = cookies::auth_cookies(&access, &refresh, secure);
    let mut response = Json(json!({
        "id": user.id.to_string(),
        "email": user.email,
        "display_name": user.display_name,
        "email_verified": user.email_verified,
    }))
    .into_response();
    clear_challenge_cookie(&mut response, secure);
    for cookie in [access_cookie, refresh_cookie] {
        if let Ok(header) = HeaderValue::from_str(&cookie) {
            response.headers_mut().append(SET_COOKIE, header);
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_router;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use openssl::bn::BigNumContext;
    use openssl::ec::{EcGroup, EcKey, EcPoint, PointConversionForm};
    use openssl::hash::MessageDigest;
    use openssl::nid::Nid;
    use openssl::pkey::{PKey, Private};
    use openssl::sign::Signer;
    use tower::ServiceExt;

    const ORIGIN: &str = "http://localhost:3000";
    const RP_ID: &str = "localhost";
    const SECRET: &str = "test-secret-key-that-is-at-least-32-chars!";

    /// A minimal in-memory ES256 (P-256) WebAuthn authenticator, used to drive
    /// the full register + usernameless-login ceremony with real signatures.
    struct SoftAuthenticator {
        key: PKey<Private>,
        cred_id: Vec<u8>,
        cose: Vec<u8>,
    }

    fn cose_ec2_bytes(x: &[u8], y: &[u8]) -> Vec<u8> {
        let mut map: BTreeMap<serde_cbor::Value, serde_cbor::Value> = BTreeMap::new();
        map.insert(serde_cbor::Value::Integer(1), serde_cbor::Value::Integer(2));
        map.insert(serde_cbor::Value::Integer(3), serde_cbor::Value::Integer(-7));
        map.insert(serde_cbor::Value::Integer(-1), serde_cbor::Value::Integer(1));
        map.insert(
            serde_cbor::Value::Integer(-2),
            serde_cbor::Value::Bytes(x.to_vec()),
        );
        map.insert(
            serde_cbor::Value::Integer(-3),
            serde_cbor::Value::Bytes(y.to_vec()),
        );
        serde_cbor::to_vec(&map).unwrap()
    }

    impl SoftAuthenticator {
        fn new() -> Self {
            let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
            let ec_key = EcKey::generate(&group).unwrap();
            let mut ctx = BigNumContext::new().unwrap();
            let mut point = EcPoint::new(&group).unwrap();
            point
                .mul_generator2(&group, ec_key.private_key(), &mut ctx)
                .unwrap();
            let point_bytes = point
                .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
                .unwrap();
            let cose = cose_ec2_bytes(&point_bytes[1..33], &point_bytes[33..65]);
            let key = PKey::from_ec_key(ec_key).unwrap();
            let cred_id = Uuid::new_v4().as_bytes().to_vec();
            Self {
                key,
                cred_id,
                cose,
            }
        }

        fn sign(&self, data: &[u8]) -> Vec<u8> {
            let mut signer = Signer::new(MessageDigest::sha256(), &self.key).unwrap();
            signer.update(data).unwrap();
            signer.sign_to_vec().unwrap()
        }

        fn rp_id_hash(&self) -> [u8; 32] {
            openssl::sha::sha256(RP_ID.as_bytes())
        }

        /// Build a `webauthn.create` credential for the given challenge.
        fn registration(&self, challenge: &str) -> Value {
            let client_data = format!(
                "{{\"type\":\"webauthn.create\",\"challenge\":\"{challenge}\",\"origin\":\"{ORIGIN}\",\"crossOrigin\":false}}"
            );
            let mut auth_data = Vec::new();
            auth_data.extend(self.rp_id_hash());
            auth_data.push(0x45); // UP | UV | AT
            auth_data.extend(0u32.to_be_bytes());
            auth_data.extend([0u8; 16]); // aaguid
            auth_data.extend((self.cred_id.len() as u16).to_be_bytes());
            auth_data.extend(&self.cred_id);
            auth_data.extend(&self.cose);

            let mut client_hash = Vec::new();
            client_hash.extend(openssl::sha::sha256(client_data.as_bytes()));
            let mut signed = auth_data.clone();
            signed.extend(&client_hash);
            let signature = self.sign(&signed);

            let mut att: BTreeMap<serde_cbor::Value, serde_cbor::Value> = BTreeMap::new();
            att.insert(
                serde_cbor::Value::Text("fmt".into()),
                serde_cbor::Value::Text("none".into()),
            );
            att.insert(
                serde_cbor::Value::Text("attStmt".into()),
                serde_cbor::Value::Map(BTreeMap::new()),
            );
            att.insert(
                serde_cbor::Value::Text("authData".into()),
                serde_cbor::Value::Bytes(auth_data),
            );
            let attestation_object = serde_cbor::to_vec(&att).unwrap();

            let _ = signature;
            json!({
                "id": b64url_encode(&self.cred_id),
                "rawId": b64url_encode(&self.cred_id),
                "type": "public-key",
                "response": {
                    "attestationObject": b64url_encode(&attestation_object),
                    "clientDataJSON": b64url_encode(client_data.as_bytes()),
                    "transports": ["internal"],
                },
            })
        }

        /// Build a `webauthn.get` assertion for the given challenge + counter.
        fn assertion(&self, challenge: &str, counter: u32) -> Value {
            let client_data = format!(
                "{{\"type\":\"webauthn.get\",\"challenge\":\"{challenge}\",\"origin\":\"{ORIGIN}\",\"crossOrigin\":false}}"
            );
            let mut auth_data = Vec::new();
            auth_data.extend(self.rp_id_hash());
            auth_data.push(0x05); // UP | UV
            auth_data.extend(counter.to_be_bytes());

            let mut client_hash = Vec::new();
            client_hash.extend(openssl::sha::sha256(client_data.as_bytes()));
            let mut signed = auth_data.clone();
            signed.extend(&client_hash);
            let signature = self.sign(&signed);

            json!({
                "id": b64url_encode(&self.cred_id),
                "rawId": b64url_encode(&self.cred_id),
                "type": "public-key",
                "response": {
                    "authenticatorData": b64url_encode(&auth_data),
                    "clientDataJSON": b64url_encode(client_data.as_bytes()),
                    "signature": b64url_encode(&signature),
                    "userHandle": null,
                },
            })
        }
    }

    async fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let pool = crate::db::connect(&url).await.ok()?;
        let settings = crate::config::Settings {
            database_url: url,
            jwt_secret_key: SECRET.into(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".into(),
            app_origin: ORIGIN.into(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".into(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: "http://localhost:3000/api/auth/oauth/google/callback".into(),
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
        Some(AppState::new(pool, settings))
    }

    fn request(method: &str, uri: &str, cookies: &[String], body: Option<Value>) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if !cookies.is_empty() {
            builder = builder.header("cookie", cookies.join("; "));
        }
        match body {
            Some(value) => builder
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    async fn call(app: &Router, req: Request<Body>) -> Response {
        app.clone().oneshot(req).await.unwrap()
    }

    async fn body_json(res: Response) -> Value {
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    fn challenge_cookie(res: &Response) -> String {
        res.headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find(|cookie| cookie.starts_with("webauthn_challenge="))
            .map(|cookie| cookie.split(';').next().unwrap().to_string())
            .expect("webauthn_challenge cookie")
    }

    #[tokio::test]
    async fn register_login_list_rename_delete_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = build_router(state.clone(), None);
        let email = format!("rust-passkey-{}@test.local", Uuid::new_v4());
        let user = user::create_email_user(&state.pool, &email, "not-a-real-hash", Some("Key Tester"))
            .await
            .unwrap();
        let access = crate::jwt::encode_access(SECRET, &user.id.to_string(), user.token_version)
            .unwrap();
        let auth = vec![format!("access_token={access}")];

        let authn = SoftAuthenticator::new();

        // register/options -> challenge + handshake cookie.
        let res = call(
            &app,
            request(
                "POST",
                "/api/auth/passkey/register/options",
                &auth,
                Some(json!({})),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let cookie = challenge_cookie(&res);
        let options = body_json(res).await;
        let challenge = options["publicKey"]["challenge"].as_str().unwrap().to_string();

        // register/verify -> stored passkey.
        let mut register_cookies = auth.clone();
        register_cookies.push(cookie);
        let res = call(
            &app,
            request(
                "POST",
                "/api/auth/passkey/register/verify",
                &register_cookies,
                Some(json!({ "credential": authn.registration(&challenge), "name": "Test key" })),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let registered = body_json(res).await;
        let passkey_id = registered["id"].as_str().unwrap().to_string();
        assert_eq!(registered["name"], "Test key");

        // list -> one entry.
        let res = call(&app, request("GET", "/api/auth/passkey", &auth, None)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let listed = body_json(res).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);

        // rename.
        let res = call(
            &app,
            request(
                "PATCH",
                &format!("/api/auth/passkey/{passkey_id}"),
                &auth,
                Some(json!({ "name": "Renamed" })),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["name"], "Renamed");

        // login/options (public) -> fresh challenge + cookie.
        let res = call(
            &app,
            request("POST", "/api/auth/passkey/login/options", &[], Some(json!({}))),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let login_cookie = challenge_cookie(&res);
        let login_options = body_json(res).await;
        let login_challenge = login_options["publicKey"]["challenge"]
            .as_str()
            .unwrap()
            .to_string();

        // login/verify -> auth cookies.
        let res = call(
            &app,
            request(
                "POST",
                "/api/auth/passkey/login/verify",
                &[login_cookie.clone()],
                Some(json!({ "credential": authn.assertion(&login_challenge, 1) })),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let signed_in = body_json(res).await;
        assert_eq!(signed_in["email"], email);

        // login/verify with a desktop nonce -> deep-link handoff.
        let res = call(
            &app,
            request("POST", "/api/auth/passkey/login/options", &[], Some(json!({}))),
        )
        .await;
        let desktop_cookie = challenge_cookie(&res);
        let desktop_options = body_json(res).await;
        let desktop_challenge = desktop_options["publicKey"]["challenge"]
            .as_str()
            .unwrap()
            .to_string();
        let res = call(
            &app,
            request(
                "POST",
                "/api/auth/passkey/login/verify",
                &[desktop_cookie],
                Some(json!({
                    "credential": authn.assertion(&desktop_challenge, 2),
                    "desktop_nonce": "abc-123",
                })),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let handoff = body_json(res).await;
        let redirect = handoff["redirect"].as_str().unwrap();
        assert!(redirect.starts_with("prysmnote://oauth/callback?code="));
        assert!(redirect.ends_with("&nonce=abc-123"));

        // delete -> 204, then empty list.
        let res = call(
            &app,
            request("DELETE", &format!("/api/auth/passkey/{passkey_id}"), &auth, None),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let res = call(&app, request("GET", "/api/auth/passkey", &auth, None)).await;
        assert_eq!(body_json(res).await.as_array().unwrap().len(), 0);

        sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&email)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
