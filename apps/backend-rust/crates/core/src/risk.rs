//! Risk-based signup assessment hook (core side).
//!
//! The private (EE) build installs an assessor through [`register_assessor`],
//! mirroring the existing global-hook pattern (`mcp::register_entitlement`,
//! `ai_tools::register_ee_agent_tools`); the community build registers none, so
//! every signup is allowed. This mirrors the guarded risk hook the Python auth
//! router used to carry: the assessor runs after the signup
//! rate limit and before the user row is created, a `block` verdict returns a
//! 403 whose JSON body carries an object `detail` plus an `X-Risk-Reference`
//! header, and a `challenge` verdict forces email verification. Any assessor
//! error fails open (the signup proceeds).

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;

/// The three verdicts the Python risk engine can return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskVerdict {
    Allow,
    Challenge,
    Block,
}

/// A scored signup decision. `detail` is the object surfaced under `detail` in
/// the 403 body for a block (matching FastAPI's `HTTPException(detail=dict)`).
#[derive(Debug, Clone)]
pub struct RiskDecision {
    pub verdict: RiskVerdict,
    pub score: i64,
    pub reason: String,
    /// First 8 chars of the fingerprint hash (or opaque key) for support lookup.
    pub reference: Option<String>,
    pub detail: Value,
}

impl RiskDecision {
    /// A plain allow, used by the assessor and the fail-open path.
    pub fn allow() -> Self {
        Self {
            verdict: RiskVerdict::Allow,
            score: 0,
            reason: String::new(),
            reference: None,
            detail: Value::Null,
        }
    }

    /// Render the hard-block response: `{"detail": {...}}` with the
    /// `X-Risk-Reference` header, byte-compatible with the Python hook.
    pub fn block_response(&self) -> Response {
        let mut response = (
            StatusCode::FORBIDDEN,
            Json(json!({ "detail": self.detail })),
        )
            .into_response();
        if let Some(reference) = self.reference.as_deref() {
            if let Ok(value) = HeaderValue::from_str(reference) {
                response.headers_mut().insert("x-risk-reference", value);
            }
        }
        response
    }
}

/// Boxed future returned by the risk assessor (dynamic EE dispatch).
pub type RiskFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RiskDecision, ApiError>> + Send + 'a>>;

/// Enterprise signup-risk assessor. The private build installs one; the
/// community core installs none, so signups always pass.
pub trait RiskAssessor: Send + Sync {
    fn assess<'a>(
        &'a self,
        email: &'a str,
        ip: &'a str,
        profile: &'a Value,
    ) -> RiskFuture<'a>;
}

static ASSESSOR: OnceLock<Box<dyn RiskAssessor>> = OnceLock::new();

/// Install the EE risk assessor (called once by the private build).
pub fn register_assessor(assessor: Box<dyn RiskAssessor>) {
    let _ = ASSESSOR.set(assessor);
}

/// The installed assessor, if any (community build has none).
pub fn assessor() -> Option<&'static dyn RiskAssessor> {
    ASSESSOR.get().map(|boxed| boxed.as_ref())
}

/// The outcome the register handler acts on.
pub enum RiskOutcome {
    /// Proceed through the normal flow.
    Allow,
    /// Create the account but force email verification first.
    Challenge,
    /// Reject with this already-rendered 403 response.
    Block(Response),
}

/// Run the installed assessor, failing open on any error or when none is
/// installed. Mirrors the Python register hook's `except Exception` reset.
pub async fn assess_signup(email: &str, ip: &str, profile: &Value) -> RiskOutcome {
    let Some(assessor) = assessor() else {
        return RiskOutcome::Allow;
    };
    match assessor.assess(email, ip, profile).await {
        Ok(decision) => match decision.verdict {
            RiskVerdict::Allow => RiskOutcome::Allow,
            RiskVerdict::Challenge => RiskOutcome::Challenge,
            RiskVerdict::Block => RiskOutcome::Block(decision.block_response()),
        },
        // Fail open: an assessor outage never blocks signups.
        Err(_) => RiskOutcome::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[test]
    fn block_response_wraps_detail_and_sets_header() {
        let decision = RiskDecision {
            verdict: RiskVerdict::Block,
            score: 100,
            reason: "honeypot".to_string(),
            reference: Some("deadbeef".to_string()),
            detail: json!({
                "message": "blocked",
                "code": "signup_blocked",
                "score": 100,
                "reference": "deadbeef",
            }),
        };
        let response = decision.block_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers().get("x-risk-reference").unwrap(), "deadbeef");
    }

    #[tokio::test]
    async fn missing_assessor_allows() {
        // No assessor is installed in this core unit test process.
        let outcome = assess_signup("a@b.com", "1.2.3.4", &Value::Null).await;
        assert!(matches!(outcome, RiskOutcome::Allow));
    }

    #[tokio::test]
    async fn block_body_is_an_object_under_detail() {
        let decision = RiskDecision {
            verdict: RiskVerdict::Block,
            score: 74,
            reason: "score".to_string(),
            reference: Some("abcd1234".to_string()),
            detail: json!({
                "message": "flagged",
                "code": "signup_blocked",
                "score": 74,
                "reference": "abcd1234",
            }),
        };
        let bytes = to_bytes(decision.block_response().into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["detail"]["code"], "signup_blocked");
        assert_eq!(value["detail"]["score"], 74);
    }
}
