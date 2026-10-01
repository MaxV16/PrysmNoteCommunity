// Prints a Fernet token for a fixed key/plaintext so the Python backend can
// confirm it decrypts Rust-produced tokens (round-trip compatibility check).
//
//   cargo run -p prysm-core --example fernet_emit

fn main() {
    let key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    match prysm_core::fernet::encrypt(key, b"prysm-fernet-test") {
        Ok(token) => println!("{token}"),
        Err(e) => {
            eprintln!("encrypt failed: {e}");
            std::process::exit(1);
        }
    }
}
