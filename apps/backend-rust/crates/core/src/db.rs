//! Postgres access and row-level-security plumbing.
//!
//! The Rust backend talks to the same PostgreSQL/pgvector database as the
//! Python backend and must honour the same row-level-security policies: every
//! user-scoped connection sets `app.user_id` (and `app.user_email`) for the
//! current transaction before running queries, exactly like
//! `app/utils/rls.py::set_rls_user_id` on the Python side.

use sqlx::postgres::{PgPool, PgPoolOptions};
use uuid::Uuid;

/// Normalize a database URL for sqlx. The Python backend and the production
/// compose files use SQLAlchemy's asyncpg dialect scheme
/// (`postgresql+asyncpg://`); sqlx only understands `postgresql://`. Strip the
/// driver suffix so the same `DATABASE_URL` works for both backends.
pub fn normalize_database_url(database_url: &str) -> String {
    database_url
        .replace("postgresql+asyncpg://", "postgresql://")
        .replace("postgres+asyncpg://", "postgres://")
}

/// Build a bounded Postgres pool. On the small production VM one worker keeps a
/// small pool (about 16 connections total), mirroring the Python sizing.
pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(6)
        .connect(&normalize_database_url(database_url))
        .await
}

/// Build a small lazy pool without connecting, sized to match the Python
/// system engine (`pool_size=4`). Used for the BYPASSRLS system pool that the
/// cross-user background loops run on: a role is fixed per connection, so the
/// app pool (enforcing RLS) cannot be reused for them. Panics on an invalid
/// URL, which is the same fail-fast behavior as the request pool.
pub fn connect_lazy(database_url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect_lazy(&normalize_database_url(database_url))
        .expect("failed to create system pool")
}

/// Set the transaction-scoped RLS identity for the current connection, the way
/// the Python backend does: `SELECT set_config('app.user_id', $1, true),
/// set_config('app.user_email', $2, true)`.
///
/// `true` means local (transaction-scoped), so this must run inside the same
/// transaction as the queries it protects.
pub async fn set_rls_user(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    email: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.user_email', $2, true)",
    )
    .bind(user_id.to_string())
    .bind(email)
    .execute(conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_asyncpg_scheme() {
        assert_eq!(
            normalize_database_url("postgresql+asyncpg://u:p@db:5432/prysm_note"),
            "postgresql://u:p@db:5432/prysm_note"
        );
        assert_eq!(
            normalize_database_url("postgres+asyncpg://u:p@db:5432/prysm_note"),
            "postgres://u:p@db:5432/prysm_note"
        );
        assert_eq!(
            normalize_database_url("postgresql://u:p@db:5432/prysm_note"),
            "postgresql://u:p@db:5432/prysm_note"
        );
    }
}
