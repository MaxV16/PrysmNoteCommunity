use thiserror::Error;

/// Encryption compatible with Python's `cryptography.fernet.Fernet`, which is
/// what the Python backend uses to store API keys and calendar tokens at rest
/// (the `enc:` prefix). The same `ENCRYPTION_KEY` works in both backends.
#[derive(Debug, Error)]
pub enum FernetError {
    #[error("invalid fernet key")]
    InvalidKey,
    #[error("invalid fernet token")]
    InvalidToken,
}

fn fernet(key: &str) -> Result<fernet::Fernet, FernetError> {
    fernet::Fernet::new(key).ok_or(FernetError::InvalidKey)
}

/// Encrypt `plaintext`, returning a Fernet token (base64url, urlsafe).
pub fn encrypt(key: &str, plaintext: &[u8]) -> Result<String, FernetError> {
    Ok(fernet(key)?.encrypt(plaintext))
}

/// Decrypt a Fernet token produced by Python or Rust.
pub fn decrypt(key: &str, token: &str) -> Result<Vec<u8>, FernetError> {
    fernet(key)?
        .decrypt(token)
        .map_err(|_| FernetError::InvalidToken)
}

#[cfg(test)]
mod tests {
    use super::{decrypt, encrypt};

    /// Generated with Python:
    /// `Fernet(base64.urlsafe_b64encode(b"0123456789abcdef0123456789abcdef")).encrypt(b"prysm-fernet-test")`.
    const PY_KEY: &str = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const PY_TOKEN: &str = "gAAAAABqvYJ4mQuKSPEMHcLjtv4z-6jcWMenN5b63p_DKu1OFf6puIm7RQYqPZvKSE80FureK5iU0cQmIH_I8ymeGxtx7GLVwzp5oG0EDlxnqUjl2NW_FQE=";

    #[test]
    fn decrypts_a_python_token() {
        let out = decrypt(PY_KEY, PY_TOKEN).unwrap();
        assert_eq!(out, b"prysm-fernet-test");
    }

    #[test]
    fn round_trips() {
        let token = encrypt(PY_KEY, b"hello").unwrap();
        assert_eq!(decrypt(PY_KEY, &token).unwrap(), b"hello");
    }

    #[test]
    fn rejects_a_bad_key() {
        assert!(encrypt("not-a-key", b"x").is_err());
    }
}
