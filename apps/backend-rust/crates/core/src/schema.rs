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

/// Idempotent additive migrations, applied on every boot after the initial
/// bootstrap check. On a fresh database these are no-ops (the bootstrap already
/// created the columns/table); on an existing database (production, which the
/// old backend provisioned) they add the inactivity lifecycle columns and the
/// audit table. Every statement is `IF NOT EXISTS`, so reruns are safe and
/// multi-worker boots are serialized by the advisory lock below.
const CORE_MIGRATIONS_SQL: &str = r#"
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_active_at timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS inactivity_warned_at timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.account_deletions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    email_hash character varying(64) NOT NULL,
    reason character varying(32) NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_account_deletions_email_hash ON public.account_deletions USING btree (email_hash);
CREATE INDEX IF NOT EXISTS ix_account_deletions_user_id ON public.account_deletions USING btree (user_id);

-- user_tokens must NOT be row-level-secured: OAuth tokens are Fernet-encrypted
-- and every query scopes by user_id, while core background loops (the calendar
-- pull) read tokens across users on the app pool with no RLS context. A legacy
-- FORCE with no matching policy rejected every token write ("new row violates
-- row-level security policy for table user_tokens"), so clear it on existing
-- databases; fresh databases no longer enable it at all.
ALTER TABLE public.user_tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_tokens DISABLE ROW LEVEL SECURITY;
"#;

/// Provisions the core schema on a fresh database.
///
/// Runs the embedded bootstrap DDL only when `public.users` is absent (tries the
/// system role pool first, the provisioning role in some deployments, then the
/// app pool), then applies the idempotent additive migrations. The migrations
/// run as the **app** role: on production the app role owns the tables and
/// `zz-init-roles.sh` grants the system role access to objects the app role
/// creates, so new tables/columns are usable by both. Running them as the system
/// role would leave new objects system-owned and the app role without access.
pub async fn ensure_schema(pool: &PgPool, system_pool: &PgPool) -> Result<(), sqlx::Error> {
    match bootstrap(system_pool).await {
        Ok(()) => {}
        Err(err) => {
            tracing::warn!("schema bootstrap via the system pool failed ({err}); retrying on the app pool");
            bootstrap(pool).await?;
        }
    }
    match migrate(pool).await {
        Ok(()) => Ok(()),
        Err(err) => {
            tracing::warn!("schema migrations via the app pool failed ({err}); retrying on the system pool");
            migrate(system_pool).await
        }
    }
}

/// Create the full bootstrap schema only when `public.users` is absent.
async fn bootstrap(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    lock(&mut tx).await?;
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('public.users') IS NOT NULL")
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        tracing::info!("provisioning the core schema on a fresh database");
        sqlx::raw_sql(CORE_SCHEMA_SQL).execute(&mut *tx).await?;
    }
    tx.commit().await
}

/// Apply the idempotent additive migrations on every boot.
async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    lock(&mut tx).await?;
    sqlx::raw_sql(CORE_MIGRATIONS_SQL).execute(&mut *tx).await?;
    tx.commit().await
}

async fn lock(tx: &mut sqlx::PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PROVISION_LOCK_KEY)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `user_tokens` must stay outside row-level security: the core calendar
    /// pull reads tokens across users on the app pool with no RLS context, and
    /// a legacy FORCE with no policy rejected every token write ("new row
    /// violates row-level security policy for table user_tokens"), which broke
    /// GitHub/Slack/email OAuth connects on fresh databases.
    #[test]
    fn user_tokens_is_not_row_level_secured() {
        assert!(!CORE_SCHEMA_SQL.contains("user_tokens ENABLE ROW LEVEL SECURITY"));
        assert!(!CORE_SCHEMA_SQL.contains("user_tokens FORCE ROW LEVEL SECURITY"));
        assert!(CORE_MIGRATIONS_SQL.contains("user_tokens NO FORCE ROW LEVEL SECURITY"));
        assert!(CORE_MIGRATIONS_SQL.contains("user_tokens DISABLE ROW LEVEL SECURITY"));
    }
}
