use thiserror::Error;

/// bcrypt hashing compatible with Python's `bcrypt` (the `$2b$` format the
/// `pyproject.toml` entry `bcrypt>=4.1` produces), so existing password hashes
/// keep verifying after the port.
#[derive(Debug, Error)]
pub enum PasswordError {
    #[error("could not hash password")]
    Hash,
}

/// Hash a plaintext password with the default cost (12), matching Python's
/// `bcrypt.hashpw(pw, bcrypt.gensalt())`.
pub fn hash_password(password: &str) -> Result<String, PasswordError> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST).map_err(|_| PasswordError::Hash)
}

/// Verify a password against a bcrypt hash. Always returns `false` on a
/// malformed hash rather than erroring.
pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{hash_password, verify_password};

    /// `bcrypt.hashpw(b"correct horse battery staple", bcrypt.gensalt(rounds=12, prefix=b"2b"))` from Python.
    const PY_HASH: &str = "$2b$12$npo8ck20FZ0/oeuQ0NZ1WecPA6obLb3XmGosbpNaiNkjIYKf0/KpW";

    #[test]
    fn verifies_a_python_hash() {
        assert!(verify_password("correct horse battery staple", PY_HASH));
        assert!(!verify_password("wrong", PY_HASH));
    }

    #[test]
    fn hashes_and_verifies_round_trip() {
        let hash = hash_password("s3cret-pw").unwrap();
        assert!(hash.starts_with("$2"));
        assert!(verify_password("s3cret-pw", &hash));
        assert!(!verify_password("nope", &hash));
    }
}
