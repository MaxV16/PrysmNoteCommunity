//! AI entitlement + token-usage accounting (core), mirroring the Python
//! `services/ai_entitlement.py`.
//!
//! The community build has no hosted AI tier: with no entitlement provider
//! registered [`check_allowance`] always reports BYOK/unlimited. The EE build
//! installs a provider through [`register_ai_entitlement`] (the same OnceLock
//! hook pattern as `mcp::register_entitlement`) that reads the subscription
//! plan/trial allowance and the monthly `ai_usage` sum.
//!
//! The provider supplies the `{mode, allowance, used}` triple only; `check_allowance`
//! derives `remaining`/`blocked` here, exactly like Python's `check_ai_allowance`.
//! The hook is async because the mode check needs DB access (subscription +
//! usage), which is also why the hook mirrors Python's async `get_ai_mode`.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

/// Resolved entitlement for a user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entitlement {
    pub mode: String,
    pub allowance: i64,
    pub used: i64,
    pub remaining: Option<i64>,
    pub blocked: bool,
}

/// The `{mode, allowance, used}` triple an entitlement provider returns,
/// mirroring Python's `get_ai_mode` hook. `mode` is `"prysmai"` (hosted,
/// allowance-capped), `"byok"` (user's own key, unlimited) or `"none"` (no
/// hosted AI, e.g. a free user with no trial).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiMode {
    pub mode: String,
    pub allowance: i64,
    pub used: i64,
}

impl AiMode {
    /// Community default: BYOK only, unlimited, no premium tier to gate on.
    pub fn community() -> Self {
        AiMode {
            mode: "byok".to_string(),
            allowance: 0,
            used: 0,
        }
    }
}

/// Hosted-AI entitlement provider installed by the EE build. The future
/// borrows the pool for the duration of the (DB-backed) lookup.
pub type AiModeFuture<'a> = Pin<Box<dyn Future<Output = AiMode> + Send + 'a>>;

/// Source of a user's AI mode. The EE build implements this over
/// `ee_subscriptions` + `ai_usage`; core installs none (community BYOK).
pub trait AiEntitlement: Send + Sync {
    fn ai_mode<'a>(&'a self, pool: &'a PgPool, user_id: Uuid) -> AiModeFuture<'a>;
}

static AI_ENTITLEMENT: OnceLock<Box<dyn AiEntitlement>> = OnceLock::new();

/// Install the EE AI-entitlement provider. Called from the EE extension.
pub fn register_ai_entitlement(provider: Box<dyn AiEntitlement>) {
    let _ = AI_ENTITLEMENT.set(provider);
}

fn entitlement_provider() -> Option<&'static dyn AiEntitlement> {
    AI_ENTITLEMENT.get().map(|boxed| boxed.as_ref())
}

async fn resolve_ai_mode(pool: &PgPool, user_id: Uuid) -> AiMode {
    match entitlement_provider() {
        Some(provider) => provider.ai_mode(pool, user_id).await,
        // Community build: BYOK only, unlimited, no premium tier to gate on.
        None => AiMode::community(),
    }
}

/// Resolve the user's AI entitlement + whether a hosted call is allowed.
/// Mirrors Python `check_ai_allowance`: the provider supplies the mode triple,
/// then `remaining`/`blocked` are derived here. Without a registered provider
/// this is the unchanged community BYOK/unlimited result.
pub async fn check_allowance(pool: &PgPool, user_id: Uuid) -> Entitlement {
    entitlement_from_mode(resolve_ai_mode(pool, user_id).await)
}

/// Derive `remaining`/`blocked` from a provider mode triple, mirroring Python
/// `check_ai_allowance`. Non-`prysmai` modes are unlimited and never blocked.
fn entitlement_from_mode(mode: AiMode) -> Entitlement {
    if mode.mode != "prysmai" {
        return Entitlement {
            mode: mode.mode,
            allowance: mode.allowance,
            used: mode.used,
            remaining: None,
            blocked: false,
        };
    }
    let remaining = mode.allowance - mode.used;
    Entitlement {
        mode: mode.mode,
        allowance: mode.allowance,
        used: mode.used,
        remaining: Some(remaining.max(0)),
        blocked: remaining <= 0,
    }
}

/// Token counts extracted from an OpenAI-style provider response.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: i64,
    pub output: i64,
    pub cached_input: i64,
}

/// Extract `{input, output, cached_input}` from an OpenAI-style response.
pub fn parse_usage(response: &Value) -> Usage {
    let usage = response.get("usage").cloned().unwrap_or(Value::Null);
    let prompt = usage.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0);
    let completion = usage
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Usage {
        input: prompt,
        output: completion,
        cached_input: cached,
    }
}

/// First instant of the current UTC calendar month.
fn current_month() -> DateTime<Utc> {
    let now = Utc::now();
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// Append a usage row for a provider call.
pub async fn record_usage(
    pool: &PgPool,
    user_id: Uuid,
    provider: &str,
    input_tokens: i64,
    output_tokens: i64,
    cached_input_tokens: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO ai_usage (user_id, provider, month, input_tokens, output_tokens, \
         cached_input_tokens) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(user_id)
    .bind(provider)
    .bind(current_month())
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cached_input_tokens)
    .execute(pool)
    .await?;
    Ok(())
}

/// Append a usage row on an existing (RLS-scoped) connection. The turn runner
/// and chat endpoint write usage inside the same transaction as their other
/// writes so `app.user_id` is set for the RLS-checked `ai_usage` table.
pub async fn record_usage_conn(
    conn: &mut PgConnection,
    user_id: Uuid,
    provider: &str,
    input_tokens: i64,
    output_tokens: i64,
    cached_input_tokens: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO ai_usage (user_id, provider, month, input_tokens, output_tokens, \
         cached_input_tokens) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(user_id)
    .bind(provider)
    .bind(current_month())
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cached_input_tokens)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Sum a user's tokens (input + output + cached) for the current calendar month.
pub async fn monthly_usage(
    pool: &PgPool,
    user_id: Uuid,
    provider: &str,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "SELECT COALESCE(SUM(input_tokens + output_tokens + cached_input_tokens), 0)::bigint AS total \
         FROM ai_usage WHERE user_id = $1 AND provider = $2 AND month >= $3",
    )
    .bind(user_id)
    .bind(provider)
    .bind(current_month())
    .fetch_one(pool)
    .await?;
    Ok(row.get("total"))
}

/// Sum a user's tokens on an existing (RLS-scoped) connection, mirroring
/// [`monthly_usage`]. The EE entitlement provider already holds a connection
/// with `app.user_id` set, so it sums there rather than opening a second one.
pub async fn monthly_usage_conn(
    conn: &mut PgConnection,
    user_id: Uuid,
    provider: &str,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "SELECT COALESCE(SUM(input_tokens + output_tokens + cached_input_tokens), 0)::bigint AS total \
         FROM ai_usage WHERE user_id = $1 AND provider = $2 AND month >= $3",
    )
    .bind(user_id)
    .bind(provider)
    .bind(current_month())
    .fetch_one(&mut *conn)
    .await?;
    Ok(row.get("total"))
}

/// Whether a string parses as a UUID.
pub fn is_uuid_like(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_usage_reads_openai_shape() {
        let response = json!({
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 30}
            }
        });
        assert_eq!(
            parse_usage(&response),
            Usage {
                input: 100,
                output: 20,
                cached_input: 30
            }
        );
    }

    #[tokio::test]
    async fn community_entitlement_is_uncapped_byok() {
        // No provider is registered in the core build, so the pool is never
        // touched; a lazy pool is enough to exercise the default fallback.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://prysm:prysm@localhost:5432/prysm")
            .expect("lazy pool");
        let ent = check_allowance(&pool, Uuid::nil()).await;
        assert_eq!(ent.mode, "byok");
        assert_eq!(ent.allowance, 0);
        assert_eq!(ent.used, 0);
        assert_eq!(ent.remaining, None);
        assert!(!ent.blocked);
    }

    #[test]
    fn entitlement_derives_remaining_and_blocked_for_prysmai() {
        let ent = entitlement_from_mode(AiMode {
            mode: "prysmai".to_string(),
            allowance: 1_500_000,
            used: 500_000,
        });
        assert_eq!(ent.mode, "prysmai");
        assert_eq!(ent.remaining, Some(1_000_000));
        assert!(!ent.blocked);

        let spent = entitlement_from_mode(AiMode {
            mode: "prysmai".to_string(),
            allowance: 1_500_000,
            used: 2_000_000,
        });
        assert_eq!(spent.remaining, Some(0));
        assert!(spent.blocked);

        let none = entitlement_from_mode(AiMode {
            mode: "none".to_string(),
            allowance: 0,
            used: 0,
        });
        assert_eq!(none.remaining, None);
        assert!(!none.blocked);
    }

    #[test]
    fn uuid_detection() {
        assert!(is_uuid_like("00000000-0000-0000-0000-000000000000"));
        assert!(!is_uuid_like("not-a-uuid"));
    }
}
