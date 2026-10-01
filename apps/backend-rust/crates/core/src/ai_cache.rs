//! Response cache for the AI chat path.
//!
//! Mirrors Python `services/ai_cache.py`: tool-round responses are cached for a
//! short TTL so repeated identical calls within a turn are served without
//! hitting the provider. Only non-streaming tool rounds are cached; the final
//! streamed answer never is. The cache key does not need to match the Python
//! serialization byte-for-byte - it is internal and ephemeral.

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// How long a cached response stays valid.
pub const CACHE_TTL_SECONDS: i64 = 300;

/// Stable cache key over the user, provider, model, messages and tools.
pub fn make_cache_key(
    user_id: Uuid,
    provider: &str,
    model: &str,
    messages: &Value,
    tools: Option<&Value>,
) -> String {
    let payload = serde_json::json!([
        user_id.to_string(),
        provider,
        model,
        messages,
        tools.cloned().unwrap_or(Value::Null),
    ]);
    let mut hasher = Sha256::new();
    hasher.update(payload.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Return a cached response when a non-expired row exists.
pub async fn get_cached_response(
    conn: &mut PgConnection,
    user_id: Uuid,
    provider: &str,
    cache_key: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT response FROM ai_cache WHERE user_id = $1 AND provider = $2 \
         AND cache_key = $3 AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(provider)
    .bind(cache_key)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let text: String = row.try_get("response")?;
    Ok(serde_json::from_str(&text).ok())
}

/// Store a response for the TTL window.
pub async fn cache_response(
    conn: &mut PgConnection,
    user_id: Uuid,
    provider: &str,
    cache_key: &str,
    response: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO ai_cache (user_id, provider, cache_key, response, expires_at) \
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(user_id)
    .bind(provider)
    .bind(cache_key)
    .bind(response.to_string())
    .bind(CACHE_TTL_SECONDS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Delete expired rows.
pub async fn purge_expired(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_cache WHERE expires_at <= now()")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_and_input_sensitive() {
        let user = Uuid::nil();
        let messages = serde_json::json!([{"role": "user", "content": "hi"}]);
        let a = make_cache_key(user, "openai", "gpt-4o", &messages, None);
        let b = make_cache_key(user, "openai", "gpt-4o", &messages, None);
        let c = make_cache_key(user, "openai", "gpt-4o", &messages, Some(&serde_json::json!([])));
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(a, c);
    }
}
