//! Personal Access Token (PAT) repository, ported from
//! `apps/backend/app/services/api_tokens_service.py`.
//!
//! Raw tokens are `prysm_live_<64 urlsafe chars>` and shown to the user once.
//! Only the SHA-256 hash is persisted. Lookups for PAT-authenticated requests
//! (the MCP path) happen before a user identity exists, so they run on the
//! system pool rather than an RLS-keyed transaction.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::error::ApiError;

/// Prefix that marks a Personal Access Token.
pub const TOKEN_PREFIX: &str = "prysm_live_";

/// Number of random bytes behind a token (64 url-safe characters).
const TOKEN_BYTES: usize = 48;

/// SHA-256 hex digest of a raw token.
pub fn hash_token(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(raw.as_bytes());
    format!("{digest:x}")
}

/// Generate a fresh raw token (48 random bytes from three UUIDv4s, base64url).
fn generate_raw_token() -> String {
    use base64::Engine;
    let mut bytes = Vec::with_capacity(TOKEN_BYTES);
    while bytes.len() < TOKEN_BYTES {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    bytes.truncate(TOKEN_BYTES);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
    format!("{TOKEN_PREFIX}{encoded}")
}

const COLUMNS: &str =
    "id, user_id, name, token_hash, prefix, created_at, last_used_at, revoked_at";

/// A persisted Personal Access Token row (never carries the plaintext).
#[derive(Debug, Clone)]
pub struct TokenRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub prefix: String,
    pub created_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

fn row_to_token(row: &sqlx::postgres::PgRow) -> TokenRow {
    TokenRow {
        id: row.try_get("id").unwrap(),
        user_id: row.try_get("user_id").unwrap(),
        name: row.try_get("name").unwrap(),
        prefix: row.try_get("prefix").unwrap(),
        created_at: row.try_get("created_at").ok(),
        last_used_at: row.try_get("last_used_at").ok(),
        revoked_at: row.try_get("revoked_at").ok(),
    }
}

/// Public token shape for the settings UI (`token_public`).
pub fn token_public(row: &TokenRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.id,
        "name": row.name,
        "prefix": row.prefix,
        "created_at": row.created_at.map(|t| t.to_rfc3339()),
        "last_used_at": row.last_used_at.map(|t| t.to_rfc3339()),
        "revoked_at": row.revoked_at.map(|t| t.to_rfc3339()),
    })
}

/// Create a token for the user; returns the plaintext (shown once) and the row.
pub async fn create_token(
    conn: &mut PgConnection,
    user_id: Uuid,
    name: Option<&str>,
) -> Result<(String, TokenRow), sqlx::Error> {
    let raw = generate_raw_token();
    let name: String = name.unwrap_or("MCP token").chars().take(80).collect();
    let prefix: String = raw.chars().take(8).collect();
    let row = sqlx::query(&format!(
        "INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1, $2, $3, $4) RETURNING {COLUMNS}"
    ))
    .bind(user_id)
    .bind(name)
    .bind(hash_token(&raw))
    .bind(prefix)
    .fetch_one(&mut *conn)
    .await?;
    Ok((raw, row_to_token(&row)))
}

/// Resolve a live token by its raw value (None when absent or revoked).
pub async fn lookup_token(
    conn: &mut PgConnection,
    raw: &str,
) -> Result<Option<TokenRow>, sqlx::Error> {
    if raw.is_empty() || !raw.starts_with(TOKEN_PREFIX) {
        return Ok(None);
    }
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL"
    ))
    .bind(hash_token(raw))
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(row_to_token))
}

/// Resolve a token on the system pool and stamp `last_used_at`.
///
/// The MCP path has no user identity yet, so it cannot rely on RLS; the
/// production role bypasses RLS on this table for exactly this lookup.
pub async fn lookup_token_system(pool: &PgPool, raw: &str) -> Result<Option<TokenRow>, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let Some(row) = lookup_token(&mut conn, raw).await? else {
        return Ok(None);
    };
    stamp_used(&mut conn, row.id).await?;
    Ok(Some(row))
}

/// Best-effort `last_used_at` bump; failures never fail the request.
pub async fn stamp_used(conn: &mut PgConnection, token_id: Uuid) -> Result<(), sqlx::Error> {
    let _ = sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1")
        .bind(token_id)
        .execute(&mut *conn)
        .await;
    Ok(())
}

/// All tokens for a user, newest first.
pub async fn list_tokens(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> Result<Vec<TokenRow>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC"
    ))
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.iter().map(row_to_token).collect())
}

/// Revoke a token; 404 when it is not the caller's.
pub async fn revoke_token(
    conn: &mut PgConnection,
    token_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(token_id)
    .bind(user_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| ApiError::Internal(format!("database error: {err}")))?;

    if result.rows_affected() == 0 {
        // Either missing, foreign, or already revoked; still report 404 for a
        // row the caller does not own, and surface "not found" otherwise.
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)::bigint FROM api_tokens WHERE id = $1 AND user_id = $2",
        )
        .bind(token_id)
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| ApiError::Internal(format!("database error: {err}")))?;
        if exists == 0 {
            return Err(ApiError::NotFound("Token not found".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_tokens_are_prefixed_and_hashed() {
        let raw = generate_raw_token();
        assert!(raw.starts_with(TOKEN_PREFIX));
        assert_eq!(raw.len(), TOKEN_PREFIX.len() + 64);
        let digest = hash_token(&raw);
        assert_eq!(digest.len(), 64);
        assert_ne!(digest, raw);
    }

    async fn live_pool() -> Option<PgPool> {
        let url = std::env::var("DATABASE_URL").ok()?;
        crate::db::connect(&url).await.ok()
    }

    #[tokio::test]
    async fn create_lookup_list_and_revoke_round_trip() {
        let Some(pool) = live_pool().await else {
            return;
        };
        let email = format!("rust-pat-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");

        let mut conn = pool.acquire().await.unwrap();
        let (raw, created) = create_token(&mut *conn, user.id, Some("My token"))
            .await
            .expect("create token");
        assert_eq!(created.name, "My token");
        assert_eq!(created.prefix, raw.chars().take(8).collect::<String>());

        let found = lookup_token(&mut *conn, &raw).await.unwrap();
        assert_eq!(found.map(|t| t.id), Some(created.id));
        assert!(lookup_token(&mut *conn, "nope").await.unwrap().is_none());

        let listed = list_tokens(&mut *conn, user.id).await.unwrap();
        assert_eq!(listed.len(), 1);

        revoke_token(&mut *conn, created.id, user.id).await.unwrap();
        assert!(lookup_token(&mut *conn, &raw).await.unwrap().is_none());
        assert!(revoke_token(&mut *conn, Uuid::new_v4(), user.id).await.is_err());

        drop(conn);
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await
            .expect("cleanup");
    }
}
