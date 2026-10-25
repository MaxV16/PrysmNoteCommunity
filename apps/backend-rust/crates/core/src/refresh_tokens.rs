//! Refresh-token rotation with reuse detection.
//!
//! Only the SHA-256 hash of a refresh token is persisted; the raw token never
//! touches the database. Every rotation keeps the original `fid` family claim
//! from [`crate::jwt`], so all copies of one login share a lineage.
//!
//! Semantics:
//! - A valid unrotated token is accepted, marked rotated, and a new token in the
//!   same family is issued.
//! - A rotated token is still accepted for [`ROTATION_GRACE_SECS`] so two tabs
//!   (or a retried request) racing each other do not log the user out.
//! - Presenting a rotated token after the grace window revokes the whole family
//!   and the caller returns 401. A stolen token therefore dies as soon as the
//!   legitimate client refreshes, instead of staying valid for its full 7 days.
//!
//! Retention: rows are cheap and the existing hourly maintenance loop prunes
//! expired ones (`refresh_tokens.expires_at < now()`). Lookups are indexed by
//! the primary-key `token_hash`, so the check is a single index probe.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::api_token::hash_token;

/// How long a token that was just rotated stays acceptable while another tab
/// may still be racing with the same cookie.
pub const ROTATION_GRACE_SECS: i64 = 60;

/// Outcome of consuming a presented refresh token.
#[derive(Debug, Clone, PartialEq)]
pub enum Consume {
    /// Accepted; continue this family with a freshly minted token.
    Fresh(Uuid),
    /// Accepted because it was rotated inside the grace window.
    ReplayedWithinGrace(Uuid),
    /// A rotated token was presented after the grace window: the family is now
    /// revoked and the caller must return 401.
    Reused,
    /// The family is already revoked.
    Revoked,
}

const COLUMNS: &str = "family_id, rotated_at, revoked_at";

/// Consume `token` for `user_id` at `expires_at`, serializing concurrent
/// refreshes on the row. Returns the family to continue, or a rejection.
pub async fn consume(
    pool: &PgPool,
    token: &str,
    user_id: Uuid,
    expires_at: i64,
    family_hint: Option<Uuid>,
) -> Result<Consume, sqlx::Error> {
    let hash = hash_token(token);
    let mut tx = pool.begin().await?;
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE"
    ))
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        // Token minted before rotation support, or by a path that did not
        // persist it (OAuth/passkey helper). Register it as already consumed
        // so a replay is handled by the same grace/reuse rules from here on.
        let family_id = family_hint.unwrap_or_else(Uuid::new_v4);
        sqlx::query(
            "INSERT INTO refresh_tokens \
             (token_hash, family_id, user_id, expires_at, rotated_at) \
             VALUES ($1, $2, $3, to_timestamp($4::double precision), now()) \
             ON CONFLICT (token_hash) DO NOTHING",
        )
        .bind(&hash)
        .bind(family_id)
        .bind(user_id)
        .bind(expires_at as f64)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Consume::Fresh(family_id));
    };

    let family_id: Uuid = row.get("family_id");
    let rotated_at: Option<DateTime<Utc>> = row.get("rotated_at");
    let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");

    if revoked_at.is_some() {
        tx.commit().await?;
        return Ok(Consume::Revoked);
    }

    // A row minted just before a concurrent reuse revoked the family may still
    // have a NULL revoked_at; check the whole lineage, not just this row.
    let family_revoked: Option<Uuid> = sqlx::query_scalar(
        "SELECT family_id FROM refresh_tokens \
         WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1",
    )
    .bind(family_id)
    .fetch_optional(&mut *tx)
    .await?;
    if family_revoked.is_some() {
        tx.commit().await?;
        return Ok(Consume::Revoked);
    }

    if let Some(rotated_at) = rotated_at {
        let elapsed = Utc::now().signed_duration_since(rotated_at).num_seconds();
        if elapsed <= ROTATION_GRACE_SECS {
            tx.commit().await?;
            return Ok(Consume::ReplayedWithinGrace(family_id));
        }
        // Reuse outside the grace window: assume the token leaked and revoke
        // every token issued in this lineage.
        sqlx::query(
            "UPDATE refresh_tokens SET revoked_at = now() \
             WHERE family_id = $1 AND revoked_at IS NULL",
        )
        .bind(family_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Consume::Reused);
    }

    sqlx::query("UPDATE refresh_tokens SET rotated_at = now() WHERE token_hash = $1")
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Consume::Fresh(family_id))
}

/// Persist a freshly minted refresh token (hash only).
pub async fn store_issued(
    pool: &PgPool,
    token: &str,
    user_id: Uuid,
    family_id: Uuid,
    expires_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at) \
         VALUES ($1, $2, $3, to_timestamp($4::double precision)) \
         ON CONFLICT (token_hash) DO NOTHING",
    )
    .bind(hash_token(token))
    .bind(family_id)
    .bind(user_id)
    .bind(expires_at as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke the whole family a token belongs to (logout, password change).
/// Unknown/legacy tokens are a no-op; the blacklist still covers their `jti`.
pub async fn revoke_family_for_token(pool: &PgPool, token: &str) -> Result<(), sqlx::Error> {
    let hash = hash_token(token);
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() \
         WHERE revoked_at IS NULL AND family_id = (\
             SELECT family_id FROM refresh_tokens WHERE token_hash = $1\
         )",
    )
    .bind(hash)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rotation_grace_and_reuse() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let Ok(pool) = crate::db::connect(&url).await else {
            return;
        };
        let _ = crate::schema::ensure_schema(&pool, &pool).await;
        let user_id = Uuid::new_v4();
        let family = Uuid::new_v4();
        let exp = Utc::now().timestamp() + 3600;

        // Fresh token is consumed once.
        let first = format!("test-refresh-first-{user_id}");
        store_issued(&pool, &first, user_id, family, exp)
            .await
            .expect("store first");
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume first"),
            Consume::Fresh(family)
        );

        // A second rapid use is still inside the grace window.
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume grace"),
            Consume::ReplayedWithinGrace(family)
        );

        // Age the rotation past the window: reuse revokes the lineage.
        sqlx::query(
            "UPDATE refresh_tokens SET rotated_at = now() - interval '2 minutes' \
             WHERE token_hash = $1",
        )
        .bind(hash_token(&first))
        .execute(&pool)
        .await
        .expect("age rotation");
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume reuse"),
            Consume::Reused
        );

        let second = format!("test-refresh-second-{user_id}");
        store_issued(&pool, &second, user_id, family, exp)
            .await
            .expect("store second");
        assert_eq!(
            consume(&pool, &second, user_id, exp, Some(family))
                .await
                .expect("consume revoked"),
            Consume::Revoked
        );

        sqlx::query("DELETE FROM refresh_tokens WHERE family_id = $1")
            .bind(family)
            .execute(&pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn logout_revokes_the_family() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let Ok(pool) = crate::db::connect(&url).await else {
            return;
        };
        let _ = crate::schema::ensure_schema(&pool, &pool).await;
        let user_id = Uuid::new_v4();
        let family = Uuid::new_v4();
        let exp = Utc::now().timestamp() + 3600;
        let token = format!("test-refresh-logout-{user_id}");
        store_issued(&pool, &token, user_id, family, exp)
            .await
            .expect("store");
        revoke_family_for_token(&pool, &token)
            .await
            .expect("revoke");
        assert_eq!(
            consume(&pool, &token, user_id, exp, Some(family))
                .await
                .expect("consume"),
            Consume::Revoked
        );
        sqlx::query("DELETE FROM refresh_tokens WHERE family_id = $1")
            .bind(family)
            .execute(&pool)
            .await
            .expect("cleanup");
    }
}
