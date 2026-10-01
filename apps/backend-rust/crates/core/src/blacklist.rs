//! Token blacklist (by `jti`), mirroring the Python `token_blacklist` table so a
//! logged-out or rotated token is rejected the same way on either backend.

use sqlx::PgPool;
use uuid::Uuid;

/// Add a token id to the blacklist. Idempotent (a repeated logout is a no-op).
pub async fn add(
    pool: &PgPool,
    jti: &str,
    user_id: Uuid,
    expires_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO token_blacklist (jti, user_id, expires_at) \
         VALUES ($1, $2, to_timestamp($3::double precision)) \
         ON CONFLICT (jti) DO NOTHING",
    )
    .bind(jti)
    .bind(user_id)
    .bind(expires_at as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// Add a token id to the blacklist, reporting whether this call actually
/// inserted it. A single-use code (e.g. a mobile OAuth exchange code) is only
/// consumed when this returns `true`; a replay finds the id present.
pub async fn add_once(
    pool: &PgPool,
    jti: &str,
    user_id: Uuid,
    expires_at: i64,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO token_blacklist (jti, user_id, expires_at) \
         VALUES ($1, $2, to_timestamp($3::double precision)) \
         ON CONFLICT (jti) DO NOTHING",
    )
    .bind(jti)
    .bind(user_id)
    .bind(expires_at as f64)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// True when the token id is blacklisted and not yet expired.
pub async fn contains(pool: &PgPool, jti: &str) -> Result<bool, sqlx::Error> {
    let row = sqlx::query("SELECT 1 FROM token_blacklist WHERE jti = $1 AND expires_at > now()")
        .bind(jti)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}
