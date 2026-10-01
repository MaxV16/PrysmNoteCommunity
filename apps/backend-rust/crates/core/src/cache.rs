//! Cache-aside helper with a Redis backend and a bounded in-process fallback.
//!
//! Mirrors Python `utils/cache.py`: every operation is best-effort and never
//! fails a request. When `REDIS_URL` is unset or unreachable, a bounded
//! in-process TTL map is used instead, which keeps dev and CI working without a
//! Redis container. Keys are namespaced per user (`cache:{resource}:{user_id}`)
//! so one user's cached payload can never be served to another.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use uuid::Uuid;

/// Cap on the in-process fallback map; it is cleared wholesale when exceeded
/// (same coarse strategy as Python).
const MEM_MAX: usize = 2000;

static MEMORY: OnceLock<Mutex<BTreeMap<String, (Instant, Value)>>> = OnceLock::new();

fn memory() -> &'static Mutex<BTreeMap<String, (Instant, Value)>> {
    MEMORY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Shared handle to an optional Redis connection manager. Cloning is cheap; the
/// connection is established lazily on first use and reused thereafter.
#[derive(Clone)]
pub struct RedisPool {
    url: String,
    manager: Arc<tokio::sync::OnceCell<Option<redis::aio::ConnectionManager>>>,
}

impl RedisPool {
    /// Build a pool from `REDIS_URL`; an empty URL disables Redis.
    pub fn from_url(url: &str) -> Self {
        Self {
            url: url.trim().to_string(),
            manager: Arc::new(tokio::sync::OnceCell::new()),
        }
    }

    /// Whether a Redis URL was configured (does not imply reachability).
    pub fn is_configured(&self) -> bool {
        !self.url.is_empty()
    }

    /// Lazily connect and return a cloneable multiplexed connection. Returns
    /// `None` when Redis is unset, misconfigured, or unreachable, which makes
    /// every caller fall back to the in-process store.
    pub async fn connection(&self) -> Option<redis::aio::ConnectionManager> {
        if self.url.is_empty() {
            return None;
        }
        let cell = self
            .manager
            .get_or_init(|| async {
                match redis::Client::open(self.url.clone()) {
                    Ok(client) => match redis::aio::ConnectionManager::new(client).await {
                        Ok(manager) => Some(manager),
                        Err(err) => {
                            tracing::warn!(error = %err, "redis connection failed");
                            None
                        }
                    },
                    Err(err) => {
                        tracing::warn!(error = %err, "invalid REDIS_URL");
                        None
                    }
                }
            })
            .await;
        cell.clone()
    }
}

/// Build a per-user cache key: `cache:{resource}:{user_id}[:part:...]`.
pub fn user_cache_key(resource: &str, user_id: Uuid, parts: &[&str]) -> String {
    let mut key = format!("cache:{resource}:{user_id}");
    for part in parts {
        key.push(':');
        key.push_str(part);
    }
    key
}

fn memory_get(key: &str) -> Option<Value> {
    let mut guard = memory().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(key) {
        Some((expires, value)) if *expires > Instant::now() => Some(value.clone()),
        Some(_) => {
            guard.remove(key);
            None
        }
        None => None,
    }
}

fn memory_set(key: &str, value: Value, ttl_secs: u64) {
    let mut guard = memory().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= MEM_MAX {
        guard.clear();
    }
    let expires = Instant::now() + Duration::from_secs(ttl_secs);
    guard.insert(key.to_string(), (expires, value));
}

/// Read a cached JSON value, or `None` on a miss / any error.
pub async fn cache_get(redis: &RedisPool, key: &str) -> Option<Value> {
    if let Some(mut conn) = redis.connection().await {
        let raw: Option<String> = redis::cmd("GET")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok()?;
        return raw.and_then(|text| serde_json::from_str(&text).ok());
    }
    memory_get(key)
}

/// Store a JSON value with a TTL (best-effort).
pub async fn cache_set(redis: &RedisPool, key: &str, value: &Value, ttl_secs: u64) {
    if let Some(mut conn) = redis.connection().await {
        if let Ok(payload) = serde_json::to_string(value) {
            let _ = redis::cmd("SET")
                .arg(key)
                .arg(payload)
                .arg("EX")
                .arg(ttl_secs)
                .query_async::<()>(&mut conn)
                .await;
        }
        return;
    }
    memory_set(key, value.clone(), ttl_secs);
}

/// Delete specific keys (best-effort).
pub async fn cache_delete(redis: &RedisPool, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    if let Some(mut conn) = redis.connection().await {
        let _ = redis::cmd("DEL")
            .arg(keys)
            .query_async::<i64>(&mut conn)
            .await;
        return;
    }
    let mut guard = memory().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for key in keys {
        guard.remove(key);
    }
}

/// Delete every key beginning with `prefix` (best-effort).
pub async fn cache_delete_prefix(redis: &RedisPool, prefix: &str) {
    if let Some(mut conn) = redis.connection().await {
        let pattern = format!("{prefix}*");
        let mut cursor = "0".to_string();
        loop {
            let result: Result<(String, Vec<String>), _> = redis::cmd("SCAN")
                .arg(&cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(200)
                .query_async(&mut conn)
                .await;
            let (next, keys) = match result {
                Ok(value) => value,
                Err(_) => return,
            };
            if !keys.is_empty() {
                let _ = redis::cmd("DEL")
                    .arg(&keys)
                    .query_async::<i64>(&mut conn)
                    .await;
            }
            if next == "0" {
                break;
            }
            cursor = next;
        }
        return;
    }
    let mut guard = memory().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.retain(|key, _| !key.starts_with(prefix));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_process_fallback_round_trips_and_expires() {
        let pool = RedisPool::from_url("");
        let key = user_cache_key("tags", Uuid::nil(), &[]);
        assert!(cache_get(&pool, &key).await.is_none());
        cache_set(&pool, &key, &serde_json::json!([1, 2, 3]), 30).await;
        assert_eq!(cache_get(&pool, &key).await, Some(serde_json::json!([1, 2, 3])));
        cache_delete(&pool, &[key.clone()]).await;
        assert!(cache_get(&pool, &key).await.is_none());
    }

    #[tokio::test]
    async fn prefix_delete_only_removes_matching_keys() {
        let pool = RedisPool::from_url("");
        let user = Uuid::new_v4();
        let a = user_cache_key("board_sections", user, &["kanban", "none"]);
        let b = user_cache_key("board_sections", user, &["board", "none"]);
        let other = user_cache_key("tags", user, &[]);
        cache_set(&pool, &a, &serde_json::json!(1), 30).await;
        cache_set(&pool, &b, &serde_json::json!(2), 30).await;
        cache_set(&pool, &other, &serde_json::json!(3), 30).await;
        let prefix = user_cache_key("board_sections", user, &[]);
        cache_delete_prefix(&pool, &prefix).await;
        assert!(cache_get(&pool, &a).await.is_none());
        assert!(cache_get(&pool, &b).await.is_none());
        assert_eq!(cache_get(&pool, &other).await, Some(serde_json::json!(3)));
    }

    #[test]
    fn key_includes_user_and_parts() {
        let user = Uuid::nil();
        assert_eq!(
            user_cache_key("tags", user, &[]),
            "cache:tags:00000000-0000-0000-0000-000000000000"
        );
        assert_eq!(
            user_cache_key("board_sections", user, &["kanban", "none"]),
            "cache:board_sections:00000000-0000-0000-0000-000000000000:kanban:none"
        );
    }
}
