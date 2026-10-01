//! Short-lived single-use login codes handed to the mobile/desktop apps over a
//! deep link, byte-compatible with the Python backend's `mobile_oauth` JWTs.

use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;
use uuid::Uuid;

/// Deep-link base the desktop app registers, matching the Python backend.
pub const DESKTOP_DEEP_LINK: &str = "prysmnote://oauth/callback";
/// Mobile app scheme base, matching the Python backend.
pub const MOBILE_DEEP_LINK: &str = "com.prysmnote.app://oauth/client";
/// Login-code lifetime, 2 minutes (matches `MOBILE_CODE_TTL_MINUTES`).
pub const CODE_TTL_SECS: i64 = 120;

#[derive(Debug, Serialize)]
struct LoginCodeClaims {
    sub: String,
    exp: i64,
    #[serde(rename = "type")]
    token_type: String,
    jti: String,
}

/// Mint a single-use mobile/desktop login code for `user_id`.
pub fn create_app_login_code(secret: &str, user_id: &str) -> Result<String, String> {
    let claims = LoginCodeClaims {
        sub: user_id.to_string(),
        exp: (Utc::now() + Duration::seconds(CODE_TTL_SECS)).timestamp(),
        token_type: "mobile_oauth".to_string(),
        jti: Uuid::new_v4().to_string(),
    };
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|err| err.to_string())
}

/// Validate the `nonce` shape the desktop app sends (`[A-Za-z0-9_-]{1,64}`).
pub fn is_safe_nonce(nonce: &str) -> bool {
    !nonce.is_empty()
        && nonce.len() <= 64
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{DecodingKey, Validation};

    #[derive(serde::Deserialize)]
    struct Decoded {
        sub: String,
        #[serde(rename = "type")]
        token_type: String,
        jti: String,
        exp: i64,
    }

    #[test]
    fn mints_a_mobile_oauth_code() {
        let secret = "test-secret-key-that-is-at-least-32-chars!";
        let token = create_app_login_code(secret, "user-1").unwrap();
        let data = jsonwebtoken::decode::<Decoded>(
            &token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &Validation::new(Algorithm::HS256),
        )
        .unwrap();
        assert_eq!(data.claims.sub, "user-1");
        assert_eq!(data.claims.token_type, "mobile_oauth");
        assert!(!data.claims.jti.is_empty());
        assert!(data.claims.exp > Utc::now().timestamp());
    }

    #[test]
    fn nonce_shape_is_enforced() {
        assert!(is_safe_nonce("abc-123_XYZ"));
        assert!(!is_safe_nonce(""));
        assert!(!is_safe_nonce("has space"));
        assert!(!is_safe_nonce(&"a".repeat(65)));
    }
}
