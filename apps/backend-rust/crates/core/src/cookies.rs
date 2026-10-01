//! Auth cookie helpers matching the Python backend's cookie attributes, so the
//! same browser session works against either backend at cutover.

/// Build the `Set-Cookie` values for a freshly authenticated session.
pub fn auth_cookies(access_token: &str, refresh_token: &str, secure: bool) -> [String; 2] {
    [
        build("access_token", access_token, 900, secure),
        build("refresh_token", refresh_token, 604_800, secure),
    ]
}

/// Build `Set-Cookie` values that expire both auth cookies.
pub fn clear_cookies(secure: bool) -> [String; 2] {
    [
        build("access_token", "", 0, secure),
        build("refresh_token", "", 0, secure),
    ]
}

/// Build an arbitrary short-lived cookie with the same HttpOnly/SameSite=Lax
/// attributes the Python backend uses for the WebAuthn challenge cookie.
pub fn build_cookie(name: &str, value: &str, max_age: i64, secure: bool) -> String {
    build(name, value, max_age, secure)
}

/// Build a `Set-Cookie` value that deletes a named cookie.
pub fn clear_cookie(name: &str, secure: bool) -> String {
    build(name, "", 0, secure)
}

fn build(name: &str, value: &str, max_age: i64, secure: bool) -> String {
    let mut cookie =
        format!("{name}={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_the_expected_attributes() {
        let [access, refresh] = auth_cookies("a", "r", true);
        assert!(access.starts_with("access_token=a;"));
        assert!(access.contains("HttpOnly"));
        assert!(access.contains("SameSite=Lax"));
        assert!(access.contains("Max-Age=900"));
        assert!(access.ends_with("; Secure"));
        assert!(refresh.contains("Max-Age=604800"));
    }

    #[test]
    fn non_secure_omits_the_secure_flag() {
        let [access, _] = auth_cookies("a", "r", false);
        assert!(!access.contains("Secure"));
    }

    #[test]
    fn clear_cookies_expire() {
        let [access, refresh] = clear_cookies(false);
        assert!(access.contains("Max-Age=0"));
        assert!(refresh.contains("Max-Age=0"));
    }
}
