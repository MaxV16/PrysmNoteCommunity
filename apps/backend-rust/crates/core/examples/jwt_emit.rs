//! Emit an HS256 access token so a Python (python-jose) check can verify the
//! Rust-signed token is accepted by the Python backend's verifier.

use prysm_core::jwt;

fn main() {
    let secret = "test-secret-key-that-is-at-least-32-chars!";
    let token = jwt::encode_access(secret, "11111111-1111-1111-1111-111111111111", 2).unwrap();
    println!("{token}");
}
