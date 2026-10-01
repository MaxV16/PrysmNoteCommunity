//! Cross-worker background-loop leadership via PostgreSQL advisory locks.
//!
//! Mirrors Python `app/services/loop_leader.py`. The server owns in-process
//! background loops (recurring expansion, analytics flush/rollup, and later
//! notifications/calendar). With more than one worker every worker would start
//! its own copy and duplicate work, so workers elect a single leader at startup:
//!
//! * The leader takes a SESSION-level advisory lock on a dedicated connection
//!   kept open for the whole process lifetime. A session lock is released
//!   automatically when the connection closes (worker crash, recycle), so the
//!   next worker to boot acquires it with no TTL/heartbeat and no split-brain.
//! * Followers skip the loops and serve HTTP only.
//!
//! The key is an arbitrary distinct 32-bit value and must match the Python
//! backend while both run side by side (Phase 6 cutover).

use sqlx::{Connection, PgConnection, Row};

/// Advisory-lock key guarding background-loop leadership ("PRYS").
pub const BACKGROUND_LOCK_KEY: i64 = 0x5052_5953;
/// Advisory-lock key serializing schema provisioning ("PRYT").
pub const SCHEMA_LOCK_KEY: i64 = 0x5052_5954;

/// This process's background leadership. Holds the dedicated connection that
/// owns the session-level advisory lock for as long as the value lives.
pub struct BackgroundLeader {
    leader: bool,
    conn: Option<PgConnection>,
}

impl BackgroundLeader {
    /// A non-leader handle.
    pub fn follower() -> Self {
        Self { leader: false, conn: None }
    }

    /// A leader handle with no held connection (non-Postgres URLs / tests).
    fn leader_without_lock() -> Self {
        Self { leader: true, conn: None }
    }

    /// Whether this process should run the shared background loops.
    pub fn is_leader(&self) -> bool {
        self.leader
    }

    /// Take the session-level advisory lock on a dedicated connection. Returns a
    /// follower handle when another worker already owns it. Any error degrades
    /// to follower (HTTP only) rather than failing startup.
    pub async fn try_acquire(database_url: &str) -> Self {
        let database_url = crate::db::normalize_database_url(database_url);
        if !database_url.starts_with("postgres") {
            // Non-Postgres (tests): leadership is always granted, matching the
            // Python lock being a no-op outside Postgres.
            return Self::leader_without_lock();
        }
        let mut conn = match PgConnection::connect(&database_url).await {
            Ok(conn) => conn,
            Err(err) => {
                tracing::warn!(error = %err, "background leadership check failed; running as follower");
                return Self::follower();
            }
        };
        let acquired = sqlx::query("SELECT pg_try_advisory_lock($1)")
            .bind(BACKGROUND_LOCK_KEY)
            .fetch_one(&mut conn)
            .await
            .ok()
            .and_then(|row| row.try_get::<bool, _>(0).ok())
            .unwrap_or(false);
        if acquired {
            tracing::info!("acquired background-loop leadership (advisory lock)");
            Self { leader: true, conn: Some(conn) }
        } else {
            tracing::info!("another worker owns background-loop leadership; HTTP only");
            let _ = conn.close().await;
            Self::follower()
        }
    }

    /// Release the advisory lock and close the dedicated connection (idempotent).
    pub async fn release(&mut self) {
        self.leader = false;
        if let Some(mut conn) = self.conn.take() {
            let _ = sqlx::query("SELECT pg_advisory_unlock($1)")
                .bind(BACKGROUND_LOCK_KEY)
                .execute(&mut conn)
                .await;
            let _ = conn.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only one holder of a session advisory lock at a time; releasing lets the
    /// next process become leader.
    #[tokio::test]
    async fn only_one_leader_and_release_hands_over() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let mut first = BackgroundLeader::try_acquire(&url).await;
        assert!(first.is_leader(), "first acquirer must lead");

        let second = BackgroundLeader::try_acquire(&url).await;
        assert!(!second.is_leader(), "second acquirer must be a follower");

        first.release().await;
        let third = BackgroundLeader::try_acquire(&url).await;
        assert!(third.is_leader(), "leadership must transfer after release");
    }

    #[tokio::test]
    async fn non_postgres_urls_always_lead() {
        let leader = BackgroundLeader::try_acquire("sqlite::memory:").await;
        assert!(leader.is_leader());
    }
}
