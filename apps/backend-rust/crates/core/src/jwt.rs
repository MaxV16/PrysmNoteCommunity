//! JWT access/refresh tokens, byte-compatible with the Python backend's
//! python-jose HS256 tokens. The claim set is `sub`, `exp`, `type`, `jti`, `tv`
//! (exactly the Python layout), so a token minted by either backend is accepted
//! by the other and nobody is logged out at cutover.

use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Access token lifetime, 15 minutes (matches the Python backend).
pub const ACCESS_TTL_SECS: i64 = 900;
/// Refresh token lifetime, 7 days (matches the Python backend).
pub const REFRESH_TTL_SECS: i64 = 604_800;
/// Token type for access tokens.
pub const ACCESS: &str = "access";
/// Token type for refresh tokens.
pub const REFRESH: &str = "refresh";

/// Claims shared by access and refresh tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claims {
    /// Subject: the user id.
    pub sub: String,
    /// Expiry (unix seconds).
    pub exp: i64,
    /// `access` or `refresh`.
    #[serde(rename = "type")]
    pub token_type: String,
    /// Unique token id; refresh rotation and the blacklist key on this.
    pub jti: String,
    /// Token version; a password change bumps it and invalidates old tokens.
    pub tv: i32,
}

/// Sign an arbitrary claim set with HS256.
pub fn encode(secret: &str, claims: &Claims) -> Result<String, String> {
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|err| err.to_string())
}

/// Mint an access token for `user_id` at `token_version`.
pub fn encode_access(secret: &str, user_id: &str, token_version: i32) -> Result<String, String> {
    let now = Utc::now().timestamp();
    encode(
        secret,
        &Claims {
            sub: user_id.to_string(),
            exp: now + ACCESS_TTL_SECS,
            token_type: ACCESS.to_string(),
            jti: Uuid::new_v4().to_string(),
            tv: token_version,
        },
    )
}

/// Mint a refresh token for `user_id` at `token_version`.
pub fn encode_refresh(secret: &str, user_id: &str, token_version: i32) -> Result<String, String> {
    let now = Utc::now().timestamp();
    encode(
        secret,
        &Claims {
            sub: user_id.to_string(),
            exp: now + REFRESH_TTL_SECS,
            token_type: REFRESH.to_string(),
            jti: Uuid::new_v4().to_string(),
            tv: token_version,
        },
    )
}

/// Verify a token's signature and expiry and return its claims.
pub fn decode(secret: &str, token: &str) -> Result<Claims, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|err| err.to_string())
}

/// Claims for the email/side-path tokens: verify, reset and mobile_oauth.
/// Unlike [`Claims`] there is no `tv`, so these are signed and read with a
/// dedicated struct rather than the access/refresh claim set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtraClaims {
    pub sub: String,
    pub exp: i64,
    #[serde(rename = "type")]
    pub token_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
}

/// Sign a verify/reset/mobile token with HS256.
pub fn encode_extra(
    secret: &str,
    sub: &str,
    token_type: &str,
    ttl_secs: i64,
    email: Option<&str>,
    jti: Option<&str>,
) -> Result<String, String> {
    let now = Utc::now().timestamp();
    encode_extra_claims(
        secret,
        &ExtraClaims {
            sub: sub.to_string(),
            exp: now + ttl_secs,
            token_type: token_type.to_string(),
            email: email.map(|e| e.to_string()),
            jti: jti.map(|j| j.to_string()),
        },
    )
}

/// Sign an explicit [`ExtraClaims`] set (used when a caller needs a fixed exp).
pub fn encode_extra_claims(secret: &str, claims: &ExtraClaims) -> Result<String, String> {
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|err| err.to_string())
}

/// Verify a verify/reset/mobile token and return its claims.
pub fn decode_extra(secret: &str, token: &str) -> Result<ExtraClaims, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    jsonwebtoken::decode::<ExtraClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret-key-that-is-at-least-32-chars!";
    // Minted by python-jose with the SECRET above, sub=1111...,
    // tv=2, exp=4102444800 (year 2100), jti=2222.../3333....
    const PY_ACCESS: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiLCJleHAiOjQxMDI0NDQ4MDAsInR5cGUiOiJhY2Nlc3MiLCJqdGkiOiIyMjIyMjIyMi0yMjIyLTIyMjItMjIyMi0yMjIyMjIyMjIyMjIiLCJ0diI6Mn0.xosJ8gf7rfHppAf5cqHQ-V4txf9U4lX2mz441TUlRDk";
    const PY_REFRESH: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiLCJleHAiOjQxMDI0NDQ4MDAsInR5cGUiOiJyZWZyZXNoIiwianRpIjoiMzMzMzMzMzMtMzMzMy0zMzMzLTMzMzMtMzMzMzMzMzMzMzMzIiwidHYiOjJ9.Ipw7BmuoNZuGUHUDRMjSbecEdXQVDDU-eolir16Zqco";

    #[test]
    fn decodes_a_python_access_token() {
        let claims = decode(SECRET, PY_ACCESS).unwrap();
        assert_eq!(claims.sub, "11111111-1111-1111-1111-111111111111");
        assert_eq!(claims.token_type, "access");
        assert_eq!(claims.tv, 2);
        assert_eq!(claims.jti, "22222222-2222-2222-2222-222222222222");
        assert_eq!(claims.exp, 4_102_444_800);
    }

    #[test]
    fn decodes_a_python_refresh_token() {
        let claims = decode(SECRET, PY_REFRESH).unwrap();
        assert_eq!(claims.token_type, "refresh");
        assert_eq!(claims.jti, "33333333-3333-3333-3333-333333333333");
    }

    #[test]
    fn round_trips_an_access_token() {
        let token = encode_access(SECRET, "abc", 5).unwrap();
        let claims = decode(SECRET, &token).unwrap();
        assert_eq!(claims.sub, "abc");
        assert_eq!(claims.token_type, "access");
        assert_eq!(claims.tv, 5);
        assert!(!claims.jti.is_empty());
    }

    #[test]
    fn rejects_a_bad_secret() {
        let token = encode_access(SECRET, "abc", 0).unwrap();
        assert!(decode("another-secret-that-is-also-long-enough-123", &token).is_err());
    }
}
