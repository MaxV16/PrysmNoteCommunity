//! Access-token revocation lookup shared by every authenticated request.
//!
//! `token_blacklist` remains the source of truth (logout, password change,
//! one-time codes). This module adds a bounded in-process TTL cache and an
//! optional Redis layer so the common path skips a database round trip, while a
//! write in this process invalidates the cache immediately (logout is
//! instantaneous).
//!
//! Failure policy: a definitively revoked `jti` always fails closed (401), but a
//! cache/Redis/DB *outage* never turns into a global logout. If the store cannot
//! be reached we allow the token for its remaining short lifetime (15 minutes)
//! and log a warning; the alternative would sign every user out during a
//! transient database hiccup, which is a worse outcome on a single-worker VM.
//! Redis is best-effort and not required: when it is unset the in-process cache
//! is authoritative for this process.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sqlx::PgPool;

use crate::cache::RedisPool;

/// Hard cap on cached `jti` entries (positive and negative), so a token flood
/// cannot grow the map without bound. The earliest-expiring entry is evicted.
const MAX_ENTRIES: usize = 10_000;
/// How long a negative (known-good) result is cached when Redis is not
/// configured. Revocation writes in this process invalidate it directly.
const NEGATIVE_TTL_SECS: u64 = 60;

#[derive(Debug, Clone, Copy)]
struct Entry {
    expires: Instant,
    revoked: bool,
}

fn cache() -> &'static Mutex<BTreeMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn redis_key(jti: &str) -> String {
    format!("revoked:{jti}")
}

/// Redis handle for writes from the token paths. Uses the same `REDIS_URL` the
/// rest of the process reads; a write never blocks on an unreachable Redis.
fn write_redis() -> &'static RedisPool {
    static POOL: OnceLock<RedisPool> = OnceLock::new();
    POOL.get_or_init(|| RedisPool::from_url(&std::env::var("REDIS_URL").unwrap_or_default()))
}

fn cache_put(jti: &str, revoked: bool, ttl: Duration) {
    let mut guard = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    guard.retain(|_, entry| entry.expires > now);
    if guard.len() >= MAX_ENTRIES && !guard.contains_key(jti) {
        if let Some(oldest) = guard
            .iter()
            .min_by_key(|(_, entry)| entry.expires)
            .map(|(key, _)| key.clone())
        {
            guard.remove(&oldest);
        }
    }
    guard.insert(
        jti.to_string(),
        Entry {
            expires: now + ttl,
            revoked,
        },
    );
}

fn cache_get(jti: &str) -> Option<Entry> {
    let mut guard = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(jti).copied() {
        Some(entry) if entry.expires > Instant::now() => Some(entry),
        Some(_) => {
            guard.remove(jti);
            None
        }
        None => None,
    }
}

/// Drop expired cache entries. Called opportunistically on inserts; there is no
/// background task.
pub fn prune() {
    let mut guard = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    guard.retain(|_, entry| entry.expires > now);
}

/// Record a token as revoked in the in-process cache and Redis. `expires_at`
/// is the token's `exp` (unix seconds), so cache entries never outlive it.
pub async fn mark_revoked(jti: &str, expires_at: i64) {
    let remaining = expires_at.saturating_sub(chrono::Utc::now().timestamp());
    if remaining <= 0 {
        return;
    }
    cache_put(jti, true, Duration::from_secs(remaining as u64));

    let redis = write_redis();
    if let Some(mut conn) = redis.connection().await {
        let _ = redis::cmd("SET")
            .arg(redis_key(jti))
            .arg("1")
            .arg("EX")
            .arg(remaining)
            .query_async::<()>(&mut conn)
            .await;
    }
}

/// Whether `jti` is currently revoked. See the module-level failure policy.
pub async fn is_revoked(pool: &PgPool, redis: &RedisPool, jti: &str, expires_at: i64) -> bool {
    let remaining = expires_at.saturating_sub(chrono::Utc::now().timestamp());
    if remaining <= 0 {
        return true;
    }
    let ttl = Duration::from_secs(remaining as u64);

    if let Some(entry) = cache_get(jti) {
        if entry.revoked {
            return true;
        }
        // A negative entry is authoritative without Redis, and is kept short
        // when Redis exists so a revocation from another worker is seen.
        if !redis.is_configured() {
            return false;
        }
    }

    if redis.is_configured() {
        if let Some(mut conn) = redis.connection().await {
            match redis::cmd("GET")
                .arg(redis_key(jti))
                .query_async::<Option<String>>(&mut conn)
                .await
            {
                Ok(Some(_)) => {
                    cache_put(jti, true, ttl);
                    return true;
                }
                Ok(None) => {
                    // Redis is the shared view: not revoked there. A short
                    // negative cache keeps a hot token cheap without hiding a
                    // cross-process revocation for long.
                    cache_put(jti, false, Duration::from_secs(NEGATIVE_TTL_SECS));
                    return false;
                }
                Err(err) => {
                    tracing::warn!(error = %err, "revocation: redis read failed, falling back to DB");
                }
            }
        }
    }

    match crate::blacklist::contains(pool, jti).await {
        Ok(revoked) => {
            cache_put(
                jti,
                revoked,
                if revoked {
                    ttl
                } else {
                    Duration::from_secs(NEGATIVE_TTL_SECS)
                },
            );
            revoked
        }
        Err(err) => {
            // Do not convert a store outage into a mass logout.
            tracing::warn!(error = %err, "revocation: DB lookup failed, allowing token for its short TTL");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_expire_and_are_pruned() {
        let jti = format!("test-expire-{}", uuid::Uuid::new_v4());
        cache_put(&jti, true, Duration::from_millis(10));
        assert!(cache_get(&jti).is_some());
        std::thread::sleep(Duration::from_millis(20));
        assert!(
            cache_get(&jti).is_none(),
            "expired entry must not resurrect"
        );
    }

    #[test]
    fn the_cache_stays_bounded() {
        // Insert past the cap and confirm the map does not grow without bound.
        for index in 0..(MAX_ENTRIES + 50) {
            cache_put(
                &format!("test-bound-{index}-{}", uuid::Uuid::new_v4()),
                false,
                Duration::from_secs(60),
            );
        }
        let guard = cache().lock().unwrap();
        assert!(
            guard.len() <= MAX_ENTRIES,
            "cache must respect its hard cap"
        );
    }

    #[tokio::test]
    async fn a_write_invalidates_the_process_cache() {
        let jti = format!("test-invalidate-{}", uuid::Uuid::new_v4());
        cache_put(&jti, false, Duration::from_secs(60));
        assert!(!cache_get(&jti).unwrap().revoked);
        mark_revoked(&jti, chrono::Utc::now().timestamp() + 60).await;
        assert!(cache_get(&jti).unwrap().revoked);
    }
}
