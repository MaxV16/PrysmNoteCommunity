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
//! - A replay older than [`REUSE_TOLERANCE_SECS`] revokes only the presented
//!   row, and the caller returns 401 (first strike). The rest of the family
//!   keeps working, so one stale copy (a suspended desktop app, a reload after
//!   an update, a laptop waking up) costs a single failed request instead of
//!   signing the user out everywhere.
//! - Presenting that same revoked copy a second time revokes the whole lineage
//!   (second strike): a real leak keeps replaying the stolen token, while a
//!   legitimate client that lost a race simply moves on with its live token.
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

/// How long a replayed (already rotated) refresh token is still accepted.
///
/// Revoking the whole family on ANY replay logged people out of every device
/// for a benign race: a second tab, a request that was already in flight when
/// the first rotation landed, a laptop waking up, or a reload after an update
/// all present a token that was rotated moments ago. The replay itself is still
/// rejected as a rotation, but only a replay older than this window is treated
/// as a leak worth killing the lineage for.
pub const REUSE_TOLERANCE_SECS: i64 = 900;

/// How a replayed rotation is treated, given how long ago it was rotated.
#[derive(Debug, PartialEq, Eq)]
pub enum ReplayVerdict {
    /// Hand the caller a fresh token in the same family: the session stays.
    Accept,
    /// Older than the tolerance window: assume theft, revoke the lineage.
    Revoke,
}

pub fn replay_verdict(elapsed_secs: i64) -> ReplayVerdict {
    if elapsed_secs <= REUSE_TOLERANCE_SECS {
        ReplayVerdict::Accept
    } else {
        ReplayVerdict::Revoke
    }
}

/// Outcome of consuming a presented refresh token.
#[derive(Debug, Clone, PartialEq)]
pub enum Consume {
    /// Accepted; continue this family with a freshly minted token.
    Fresh(Uuid),
    /// Accepted because it was rotated inside the grace window.
    ReplayedWithinGrace(Uuid),
    /// A rotated token was presented outside the tolerance window. Only that
    /// row is revoked (first strike) unless it had already been revoked by an
    /// earlier strike, in which case the whole family is revoked too. The
    /// caller returns 401 either way, but a live sibling stays valid.
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
        // Second strike: this row was revoked individually by an earlier stale
        // replay while the rest of the lineage is still alive, so the same copy
        // has now been presented twice. Treat it as a leak and end the family.
        // A logout revokes every row, so nothing is left alive and this falls
        // through to plain `Revoked`.
        let family_alive: Option<Uuid> = sqlx::query_scalar(
            "SELECT family_id FROM refresh_tokens \
             WHERE family_id = $1 AND revoked_at IS NULL LIMIT 1",
        )
        .bind(family_id)
        .fetch_optional(&mut *tx)
        .await?;
        if family_alive.is_some() {
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
        tx.commit().await?;
        return Ok(Consume::Revoked);
    }

    // A full family revoke (logout, password change) marks every row, so a live
    // sibling row here is normal and must keep working.

    if let Some(rotated_at) = rotated_at {
        let elapsed = Utc::now().signed_duration_since(rotated_at).num_seconds();
        if elapsed <= ROTATION_GRACE_SECS {
            tx.commit().await?;
            return Ok(Consume::ReplayedWithinGrace(family_id));
        }
        // A replay a little older than the grace window is normally a second
        // tab or an in-flight request, not a stolen token, so keep the session
        // and rotate again instead of logging the user out everywhere.
        if replay_verdict(elapsed) == ReplayVerdict::Accept {
            tx.commit().await?;
            return Ok(Consume::ReplayedWithinGrace(family_id));
        }
        // Older than the tolerance, but this is the most recently rotated copy
        // in its family: the device that rotated it never received the
        // Set-Cookie (a desktop app quitting or updating mid-request, a laptop
        // suspending). Nobody can "steal" a copy that is newer than every other
        // rotation, so keep the session instead of signing the user out.
        let newest: Option<String> = sqlx::query_scalar(
            "SELECT token_hash FROM refresh_tokens \
             WHERE family_id = $1 AND rotated_at IS NOT NULL \
             ORDER BY rotated_at DESC LIMIT 1",
        )
        .bind(family_id)
        .fetch_optional(&mut *tx)
        .await?;
        if newest.as_deref() == Some(hash.as_str()) {
            tx.commit().await?;
            return Ok(Consume::ReplayedWithinGrace(family_id));
        }
        // Reuse well outside the window: this copy was kept alive somewhere it
        // should not have been. Revoke only the presented row so the live
        // sibling tokens keep the user signed in; a second presentation of this
        // same copy trips the full-family revoke above.
        sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1")
            .bind(&hash)
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

/// Whether `token` would currently be accepted by [`consume`], without
/// consuming it.
///
/// `/api/auth/session` reports `refreshable` from this so the client can tell a
/// genuinely dead session (logout, password change, expired, revoked family)
/// from a momentary 401. A token minted before rotation support has no row and
/// is treated as usable, because `consume` registers it on first use.
pub async fn is_usable(pool: &PgPool, token: &str) -> Result<bool, sqlx::Error> {
    let hash = hash_token(token);
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM refresh_tokens WHERE token_hash = $1"
    ))
    .bind(&hash)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else { return Ok(true) };

    let rotated_at: Option<DateTime<Utc>> = row.get("rotated_at");
    let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
    if revoked_at.is_some() {
        return Ok(false);
    }
    // A sibling row may have been revoked individually by a first strike while
    // this token stays valid, so the lineage is not a proxy for this token.
    if let Some(rotated_at) = rotated_at {
        // Mirrors `consume`: a replay is accepted up to REUSE_TOLERANCE_SECS.
        let elapsed = Utc::now().signed_duration_since(rotated_at).num_seconds();
        return Ok(elapsed <= REUSE_TOLERANCE_SECS);
    }
    Ok(true)
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

    #[test]
    fn replay_tolerance_keeps_benign_races_alive() {
        // Same tab, two tabs, an in-flight request, a waking laptop: these are
        // all minutes old, and none of them may end the session.
        assert_eq!(replay_verdict(0), ReplayVerdict::Accept);
        assert_eq!(replay_verdict(ROTATION_GRACE_SECS), ReplayVerdict::Accept);
        assert_eq!(replay_verdict(REUSE_TOLERANCE_SECS), ReplayVerdict::Accept);
        // A day-old token replayed means someone kept a copy.
        assert_eq!(replay_verdict(REUSE_TOLERANCE_SECS + 1), ReplayVerdict::Revoke);
        assert_eq!(replay_verdict(86_400), ReplayVerdict::Revoke);
    }

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

        // A replay minutes later is a second tab, not a leak: the family stays
        // alive, which is the difference between a stale tab and a logout.
        sqlx::query(
            "UPDATE refresh_tokens SET rotated_at = now() - interval '5 minutes' \
             WHERE token_hash = $1",
        )
        .bind(hash_token(&first))
        .execute(&pool)
        .await
        .expect("age rotation");
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume tolerated replay"),
            Consume::ReplayedWithinGrace(family)
        );

        // Age the rotation well past the tolerance. `first` is still the most
        // recently rotated copy in the family, which is exactly the "the device
        // never got the Set-Cookie" case: the session must survive.
        sqlx::query(
            "UPDATE refresh_tokens SET rotated_at = now() - interval '2 hours' \
             WHERE token_hash = $1",
        )
        .bind(hash_token(&first))
        .execute(&pool)
        .await
        .expect("age rotation");
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume lost set-cookie"),
            Consume::ReplayedWithinGrace(family)
        );

        // Once a newer rotation exists in the family, an old copy is a genuine
        // stale replay: this is the first strike and only that row dies.
        let second = format!("test-refresh-second-{user_id}");
        store_issued(&pool, &second, user_id, family, exp)
            .await
            .expect("store second");
        assert_eq!(
            consume(&pool, &second, user_id, exp, Some(family))
                .await
                .expect("consume live sibling"),
            Consume::Fresh(family)
        );
        sqlx::query(
            "UPDATE refresh_tokens SET rotated_at = now() - interval '2 hours' \
             WHERE token_hash = $1",
        )
        .bind(hash_token(&second))
        .execute(&pool)
        .await
        .expect("age rotation");
        // `second` is now the newest rotated copy again, so re-establish a
        // newer one first: the third token is the live session.
        let third = format!("test-refresh-third-{user_id}");
        store_issued(&pool, &third, user_id, family, exp)
            .await
            .expect("store third");
        assert_eq!(
            consume(&pool, &third, user_id, exp, Some(family))
                .await
                .expect("consume third"),
            Consume::Fresh(family)
        );
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume reuse"),
            Consume::Reused
        );

        // The live sibling still rotates and stays in the same family: one
        // stale copy must never sign the user out everywhere.
        assert_eq!(
            consume(&pool, &third, user_id, exp, Some(family))
                .await
                .expect("consume live sibling after strike"),
            Consume::ReplayedWithinGrace(family)
        );

        // Presenting the same revoked copy again is the second strike: the
        // lineage dies, exactly like a stolen token that keeps being replayed.
        assert_eq!(
            consume(&pool, &first, user_id, exp, Some(family))
                .await
                .expect("consume second strike"),
            Consume::Reused
        );
        assert_eq!(
            consume(&pool, &third, user_id, exp, Some(family))
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
