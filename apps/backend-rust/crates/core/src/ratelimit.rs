//! Rate limiting with a Redis backend and an in-process fallback.
//!
//! Mirrors Python `utils/ratelimit.py`: `count` increments a fixed window
//! anchored to the first hit (`INCR` + `EXPIRE NX`) and `block`/`is_blocked`
//! back the failed-login gate. Every operation is best-effort: when `REDIS_URL`
//! is unset or unreachable the in-process fallback is used, so dev, CI and a
//! single-worker box keep working without a Redis container.
//!
//! The Redis path is shared via [`crate::cache::RedisPool`] so a process holds
//! at most one connection manager.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::cache::RedisPool;

pub struct RateLimiter {
    name: &'static str,
    entries: Mutex<BTreeMap<String, (Instant, u32)>>,
    blocks: Mutex<BTreeMap<String, Instant>>,
    redis: Option<RedisPool>,
}

impl RateLimiter {
    /// An in-process-only limiter (no Redis).
    pub const fn new(name: &'static str) -> Self {
        Self {
            name,
            entries: Mutex::new(BTreeMap::new()),
            blocks: Mutex::new(BTreeMap::new()),
            redis: None,
        }
    }

    /// A limiter that uses `redis` when it is configured, else stays in-process.
    pub fn with_redis(name: &'static str, redis: RedisPool) -> Self {
        let redis = if redis.is_configured() { Some(redis) } else { None };
        Self {
            name,
            entries: Mutex::new(BTreeMap::new()),
            blocks: Mutex::new(BTreeMap::new()),
            redis,
        }
    }

    /// Build a limiter whose Redis backend comes from the `REDIS_URL` env var.
    /// Used by module-level namespace limiters (analytics, mobile OAuth) that
    /// have no `AppState` handle.
    pub fn from_env(name: &'static str) -> Self {
        let url = std::env::var("REDIS_URL").unwrap_or_default();
        Self::with_redis(name, RedisPool::from_url(&url))
    }

    /// Whether this limiter is backed by Redis. Callers that must only engage a
    /// throttle when a shared store exists (signups, so a single-writer VM can
    /// never lock itself out via the in-memory fallback) check this first.
    pub fn uses_redis(&self) -> bool {
        self.redis.is_some()
    }

    /// Increment `key` and return the count within `window`.
    ///
    /// The Redis path is a fixed window anchored to the first hit; the
    /// in-process path is a fixed window per key. Callers compare the returned
    /// count against their own limit.
    pub async fn count(&self, key: &str, window: Duration) -> u32 {
        if let Some(redis) = &self.redis {
            if let Some(count) = self.redis_count(redis, key, window).await {
                return count;
            }
        }
        self.memory_count(key, window)
    }

    async fn redis_count(&self, redis: &RedisPool, key: &str, window: Duration) -> Option<u32> {
        let mut conn = redis.connection().await?;
        let full = format!("{}:{}", self.name, key);
        let secs = window.as_secs().max(1);
        redis::pipe()
            .cmd("INCR")
            .arg(&full)
            .cmd("EXPIRE")
            .arg(&full)
            .arg(secs)
            .arg("NX")
            .ignore()
            .query_async(&mut conn)
            .await
            .ok()
    }

    fn memory_count(&self, key: &str, window: Duration) -> u32 {
        let full = format!("{}:{}", self.name, key);
        let now = Instant::now();
        let mut guard = match self.entries.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Self-prune expired keys so the fallback map cannot grow without bound.
        // This replaces the Python `_prune_rate_limits` background task (the
        // Redis path expires counters on its own, via TTLs).
        guard.retain(|_, (started, _)| now.duration_since(*started) < window);
        let entry = guard.entry(full).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        entry.1
    }

    /// Block `key` for `duration`.
    pub async fn block(&self, key: &str, duration: Duration) {
        if let Some(redis) = &self.redis {
            if let Some(mut conn) = redis.connection().await {
                let full = format!("{}:block:{}", self.name, key);
                let secs = duration.as_secs().max(1);
                let _ = redis::cmd("SET")
                    .arg(&full)
                    .arg("1")
                    .arg("EX")
                    .arg(secs)
                    .query_async::<()>(&mut conn)
                    .await;
                return;
            }
        }
        let now = Instant::now();
        let mut guard = match self.blocks.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Drop expired blocks so the fallback map stays bounded too.
        guard.retain(|_, expires| *expires > now);
        guard.insert(key.to_string(), now + duration);
    }

    /// Whether `key` is currently blocked.
    pub async fn is_blocked(&self, key: &str) -> bool {
        if let Some(redis) = &self.redis {
            if let Some(mut conn) = redis.connection().await {
                let full = format!("{}:block:{}", self.name, key);
                let exists: i64 = redis::cmd("EXISTS")
                    .arg(&full)
                    .query_async(&mut conn)
                    .await
                    .unwrap_or(0);
                return exists > 0;
            }
        }
        let now = Instant::now();
        let mut guard = match self.blocks.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.get(key) {
            Some(expires) if *expires > now => true,
            Some(_) => {
                guard.remove(key);
                false
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn counts_within_a_window_and_isolates_keys() {
        let limiter = RateLimiter::new("test");
        let window = Duration::from_secs(600);
        assert_eq!(limiter.count("a", window).await, 1);
        assert_eq!(limiter.count("a", window).await, 2);
        assert_eq!(limiter.count("a", window).await, 3);
        assert_eq!(limiter.count("b", window).await, 1);
    }

    #[tokio::test]
    async fn resets_after_the_window_elapses() {
        let limiter = RateLimiter::new("test");
        let window = Duration::from_millis(20);
        assert_eq!(limiter.count("a", window).await, 1);
        assert_eq!(limiter.count("a", window).await, 2);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(limiter.count("a", window).await, 1);
    }

    #[tokio::test]
    async fn the_fallback_prunes_expired_entries() {
        let limiter = RateLimiter::new("test-prune");
        let window = Duration::from_millis(10);
        limiter.count("stale", window).await;
        std::thread::sleep(Duration::from_millis(20));
        // A later count on a different key sweeps the expired one.
        limiter.count("fresh", window).await;

        let guard = limiter.entries.lock().unwrap();
        assert!(!guard.contains_key("test-prune:stale"), "expired key must be evicted");
        assert!(guard.contains_key("test-prune:fresh"), "live key must remain");
    }

    #[tokio::test]
    async fn block_and_is_blocked_round_trip() {
        let limiter = RateLimiter::new("test-block");
        assert!(!limiter.is_blocked("ip:1").await);
        limiter.block("ip:1", Duration::from_secs(60)).await;
        assert!(limiter.is_blocked("ip:1").await);
        assert!(!limiter.is_blocked("ip:2").await);
        limiter.block("ip:2", Duration::from_millis(10)).await;
        std::thread::sleep(Duration::from_millis(20));
        assert!(!limiter.is_blocked("ip:2").await);
    }
}
