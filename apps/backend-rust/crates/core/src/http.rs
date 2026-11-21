//! Shared outbound HTTP client.
//!
//! Every provider call (Google, GitHub, Slack, Brevo, Stripe, Tavily) goes
//! through one pooled client with bounded timeouts. Building a fresh
//! `reqwest::Client` per call re-negotiates TLS and, more importantly, has no
//! timeout at all: one stalled provider could hold a background loop (and its
//! database transaction) open forever.

use std::sync::OnceLock;
use std::time::Duration;

/// Connect timeout for a single provider call.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Whole-request ceiling. Provider APIs answer well inside this; a call that
/// does not is treated as unavailable instead of stalling a worker.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Keep idle sockets around so a sync loop reuses TLS sessions.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

fn build() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(4)
        .user_agent(concat!("PrysmNote/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Process-wide client for outbound provider calls.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(build)
}
