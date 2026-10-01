//! Request authentication: pull the access token out of a request and turn it
//! into the caller's identity. This mirrors the Python backend's
//! `get_current_user` gate (cookie `access_token` first, then a Bearer header).

use axum::http::HeaderMap;
use uuid::Uuid;

use crate::error::ApiError;
use crate::jwt::{self, Claims};

/// The authenticated caller.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub token_version: i32,
}

/// The cookie the browser sends the access token in (matches the Python backend).
pub const ACCESS_COOKIE: &str = "access_token";

/// Read the access token: the `access_token` cookie first (browser), then the
/// `Authorization: Bearer <token>` header (API clients).
pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
    {
        for pair in cookie.split(';') {
            let pair = pair.trim();
            if let Some(value) = pair.strip_prefix("access_token=") {
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = authorization
        .strip_prefix("Bearer ")
        .unwrap_or(authorization)
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Verify an access token and return the caller. Refresh tokens are rejected.
pub fn authenticate(secret: &str, token: &str) -> Result<AuthUser, ApiError> {
    let claims: Claims = jwt::decode(secret, token).map_err(|_| unauthorized())?;
    if claims.token_type != jwt::ACCESS {
        return Err(unauthorized());
    }
    let user_id = Uuid::parse_str(&claims.sub).map_err(|_| unauthorized())?;
    Ok(AuthUser {
        user_id,
        token_version: claims.tv,
    })
}

fn unauthorized() -> ApiError {
    ApiError::Unauthorized("Could not validate credentials".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const SECRET: &str = "test-secret-key-that-is-at-least-32-chars!";
    const UID: &str = "11111111-1111-1111-1111-111111111111";

    #[test]
    fn authenticates_an_access_token() {
        let token = jwt::encode_access(SECRET, UID, 7).unwrap();
        let user = authenticate(SECRET, &token).unwrap();
        assert_eq!(user.user_id.to_string(), UID);
        assert_eq!(user.token_version, 7);
    }

    #[test]
    fn rejects_a_refresh_token() {
        let token = jwt::encode_refresh(SECRET, UID, 0).unwrap();
        assert!(authenticate(SECRET, &token).is_err());
    }

    #[test]
    fn rejects_a_bad_secret() {
        let token = jwt::encode_access(SECRET, UID, 0).unwrap();
        assert!(authenticate("another-secret-that-is-long-enough-1234", &token).is_err());
    }

    #[test]
    fn reads_the_cookie_then_the_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            HeaderValue::from_static("a=b; access_token=CookieTok; c=d"),
        );
        assert_eq!(token_from_headers(&headers).as_deref(), Some("CookieTok"));

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer HeadTok"),
        );
        assert_eq!(token_from_headers(&headers).as_deref(), Some("HeadTok"));
    }

    #[test]
    fn missing_token_is_none() {
        assert!(token_from_headers(&HeaderMap::new()).is_none());
    }
}
