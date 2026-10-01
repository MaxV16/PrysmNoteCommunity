//! First-boot schema provisioning for a fresh PostgreSQL database.
//!
//! Up to now the schema was created by the Python backend's startup
//! `ensure_schema`. With the backend cut over to Rust, the server owns that
//! bootstrap: [`ensure_schema`] applies the embedded DDL (`sql/core_schema.sql`,
//! captured from the live reference schema) exactly once when the database has
//! no `users` table.
//!
//! Existing databases (including production, which Python already provisioned)
//! are detected by that marker and skipped, so this is a no-op on every boot
//! after the first. A blocking transaction-scoped advisory lock serializes
//! concurrent workers so two processes cannot race the bootstrap.

use sqlx::PgPool;

/// Transaction-scoped advisory lock key for schema provisioning. Distinct from
/// the background-loop leader key so the two never contend.
const PROVISION_LOCK_KEY: i64 = 0x7072_7973_6d73_6368; // "prysm sch"

const CORE_SCHEMA_SQL: &str = include_str!("../sql/core_schema.sql");

/// Provisions the core schema on a fresh database.
///
/// Runs the embedded bootstrap DDL only when `public.users` is absent, so it is
/// a cheap no-op once the schema exists. Tries the system role pool first (the
/// provisioning role owns the tables) and falls back to the app pool.
pub async fn ensure_schema(pool: &PgPool, system_pool: &PgPool) -> Result<(), sqlx::Error> {
    match provision(system_pool).await {
        Ok(()) => Ok(()),
        Err(err) => {
            tracing::warn!("schema bootstrap via the system pool failed ({err}); retrying on the app pool");
            provision(pool).await
        }
    }
}

async fn provision(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PROVISION_LOCK_KEY)
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('public.users') IS NOT NULL")
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        tracing::info!("provisioning the core schema on a fresh database");
        sqlx::raw_sql(CORE_SCHEMA_SQL).execute(&mut *tx).await?;
    }
    tx.commit().await
}
