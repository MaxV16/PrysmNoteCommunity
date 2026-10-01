//! Hourly maintenance cleanup (core), mirroring the Python
//! `app/main.py::maintenance_cleanup` inline loop.
//!
//! Prunes expired token-blacklist rows plus the unbounded-growth premium AI
//! tables (expired response cache and usage rows past the retention window).
//! Runs on the BYPASSRLS system pool so every user's rows are covered; each
//! delete is independent, so one failure cannot skip the rest.

use std::time::Duration;

use sqlx::PgPool;

/// One maintenance pass: delete expired blacklist rows, expired AI cache rows
/// and AI usage rows past `retention_days`. Returns the summed deleted row
/// count. Every statement is wrapped in its own error handler and a failure is
/// logged and skipped, matching Python's per-statement try/except.
pub async fn maintenance_cleanup_once(pool: &PgPool, retention_days: i64) -> u64 {
    let mut total: u64 = 0;

    // token_blacklist has no RLS.
    match sqlx::query("DELETE FROM token_blacklist WHERE expires_at < now()").execute(pool).await {
        Ok(result) => total += result.rows_affected(),
        Err(err) => tracing::warn!("maintenance: token_blacklist prune failed: {err}"),
    }

    // ai_cache is FORCE RLS; the system pool bypasses it.
    match sqlx::query("DELETE FROM ai_cache WHERE expires_at < now()").execute(pool).await {
        Ok(result) => total += result.rows_affected(),
        Err(err) => tracing::warn!("maintenance: ai_cache prune failed: {err}"),
    }

    // ai_usage is FORCE RLS; the system pool bypasses it.
    match sqlx::query("DELETE FROM ai_usage WHERE created_at < now() - ($1 * INTERVAL '1 day')")
        .bind(retention_days)
        .execute(pool)
        .await
    {
        Ok(result) => total += result.rows_affected(),
        Err(err) => tracing::warn!("maintenance: ai_usage prune failed: {err}"),
    }

    total
}

/// Background loop: run one cleanup pass, then sleep `interval`. The Python loop
/// sleeps 3600s; one failing pass never stops the loop.
pub async fn maintenance_cleanup_loop(pool: PgPool, interval: Duration, retention_days: i64) {
    loop {
        maintenance_cleanup_once(&pool, retention_days).await;
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn live_pool() -> Option<PgPool> {
        let url = std::env::var("DATABASE_URL").ok()?;
        sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await.ok()
    }

    #[tokio::test]
    async fn cleanup_removes_expired_rows() {
        let Some(pool) = live_pool().await else {
            return;
        };
        let marker = format!("rust-cleanup-{}", uuid::Uuid::new_v4());
        let user_id = uuid::Uuid::new_v4();

        // Seed one expired and one live token_blacklist row.
        sqlx::query(
            "INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES \
             ($1, $2, now() - INTERVAL '1 day'), ($3, $2, now() + INTERVAL '1 day')",
        )
        .bind(format!("{marker}-expired"))
        .bind(user_id)
        .bind(format!("{marker}-live"))
        .execute(&pool)
        .await
        .expect("seed blacklist");

        maintenance_cleanup_once(&pool, 400).await;

        let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM token_blacklist WHERE jti LIKE $1")
            .bind(format!("{marker}-live%"))
            .fetch_one(&pool)
            .await
            .expect("count live");
        let expired: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM token_blacklist WHERE jti LIKE $1")
                .bind(format!("{marker}-expired%"))
                .fetch_one(&pool)
                .await
                .expect("count expired");
        assert_eq!(live, 1, "unexpired blacklist row must survive");
        assert_eq!(expired, 0, "expired blacklist row must be pruned");

        sqlx::query("DELETE FROM token_blacklist WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("cleanup");
    }
}
