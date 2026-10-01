//! Repository for user-provided LLM API keys (BYOK).
//!
//! Mirrors Python `models/api_key.py` + the storage side of `routers/keys.py`.
//! Keys are encrypted at rest with the same Fernet `ENCRYPTION_KEY` as Python
//! (`crate::fernet`), so rows written by either backend decrypt in the other.

use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::fernet;

/// Columns selected for every `ApiKey` read.
const COLUMNS: &str = "id, user_id, provider, encrypted_key, key_prefix, is_active";

/// A stored BYOK key.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiKey {
    pub id: Uuid,
    pub user_id: Uuid,
    pub provider: String,
    pub encrypted_key: Vec<u8>,
    pub key_prefix: Option<String>,
    pub is_active: bool,
}

fn row_to_key(row: &sqlx::postgres::PgRow) -> Result<ApiKey, sqlx::Error> {
    Ok(ApiKey {
        id: row.try_get("id")?,
        user_id: row.try_get("user_id")?,
        provider: row.try_get("provider")?,
        encrypted_key: row.try_get("encrypted_key")?,
        key_prefix: row.try_get("key_prefix")?,
        is_active: row.try_get("is_active")?,
    })
}

/// Every key owned by a user, newest first.
pub async fn list_for_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<ApiKey>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC");
    let rows = sqlx::query(&sql).bind(user_id).fetch_all(pool).await?;
    rows.iter().map(row_to_key).collect()
}

/// The user's key for one provider, if any.
pub async fn get_by_provider(
    pool: &PgPool,
    user_id: Uuid,
    provider: &str,
) -> Result<Option<ApiKey>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM api_keys WHERE user_id = $1 AND provider = $2");
    let row = sqlx::query(&sql)
        .bind(user_id)
        .bind(provider)
        .fetch_optional(pool)
        .await?;
    row.as_ref().map(row_to_key).transpose()
}

/// The user's active key for one provider, if any.
pub async fn get_active_by_provider(
    pool: &PgPool,
    user_id: Uuid,
    provider: &str,
) -> Result<Option<ApiKey>, sqlx::Error> {
    let sql = format!(
        "SELECT {COLUMNS} FROM api_keys WHERE user_id = $1 AND provider = $2 AND is_active = true"
    );
    let row = sqlx::query(&sql)
        .bind(user_id)
        .bind(provider)
        .fetch_optional(pool)
        .await?;
    row.as_ref().map(row_to_key).transpose()
}

/// The user's first active key (used by embedding lookups).
pub async fn get_active_for_user(pool: &PgPool, user_id: Uuid) -> Result<Option<ApiKey>, sqlx::Error> {
    let sql = format!(
        "SELECT {COLUMNS} FROM api_keys WHERE user_id = $1 AND is_active = true \
         ORDER BY created_at ASC LIMIT 1"
    );
    let row = sqlx::query(&sql).bind(user_id).fetch_optional(pool).await?;
    row.as_ref().map(row_to_key).transpose()
}

/// The user's first active key, read on an existing (RLS-scoped) connection.
/// `api_keys` is FORCE RLS, so a request handler that needs the embedding key
/// must read it inside the transaction that already set `app.user_id`; a raw
/// pool query would return zero rows on the production app role.
pub(crate) async fn get_active_for_user_conn(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> Result<Option<ApiKey>, sqlx::Error> {
    let sql = format!(
        "SELECT {COLUMNS} FROM api_keys WHERE user_id = $1 AND is_active = true \
         ORDER BY created_at ASC LIMIT 1"
    );
    let row = sqlx::query(&sql).bind(user_id).fetch_optional(conn).await?;
    row.as_ref().map(row_to_key).transpose()
}

/// Insert or replace the user's key for a provider. `plaintext` is encrypted
/// with `encryption_key`; the first eight characters are kept as a prefix for
/// display.
pub async fn upsert(
    pool: &PgPool,
    user_id: Uuid,
    provider: &str,
    plaintext: &str,
    encryption_key: &str,
) -> Result<(), fernet::FernetError> {
    let encrypted = fernet::encrypt(encryption_key, plaintext.as_bytes())?;
    let prefix: String = plaintext.chars().take(8).collect();
    let existing = get_by_provider(pool, user_id, provider)
        .await
        .map_err(|_| fernet::FernetError::InvalidToken)?;
    match existing {
        Some(key) => {
            sqlx::query(
                "UPDATE api_keys SET encrypted_key = $2, key_prefix = $3, is_active = true \
                 WHERE id = $1",
            )
            .bind(key.id)
            .bind(encrypted.as_bytes())
            .bind(prefix)
            .execute(pool)
            .await
            .map_err(|_| fernet::FernetError::InvalidToken)?;
        }
        None => {
            sqlx::query(
                "INSERT INTO api_keys (user_id, provider, encrypted_key, key_prefix, is_active) \
                 VALUES ($1, $2, $3, $4, true)",
            )
            .bind(user_id)
            .bind(provider)
            .bind(encrypted.as_bytes())
            .bind(prefix)
            .execute(pool)
            .await
            .map_err(|_| fernet::FernetError::InvalidToken)?;
        }
    }
    Ok(())
}

/// Decrypt a stored key with the given encryption key.
pub fn decrypt(key: &ApiKey, encryption_key: &str) -> Result<String, fernet::FernetError> {
    let token = String::from_utf8(key.encrypted_key.clone()).map_err(|_| fernet::FernetError::InvalidToken)?;
    let bytes = fernet::decrypt(encryption_key, &token)?;
    String::from_utf8(bytes).map_err(|_| fernet::FernetError::InvalidToken)
}

/// Delete the user's key by id. Returns false when no row matched.
pub async fn delete(pool: &PgPool, user_id: Uuid, id: Uuid) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same Fernet key the Python project uses in tests.
    const TEST_ENCRYPTION_KEY: &str = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

    async fn live_pool() -> Option<PgPool> {
        let url = std::env::var("DATABASE_URL").ok()?;
        crate::db::connect(&url).await.ok()
    }

    #[tokio::test]
    async fn encrypts_upserts_and_round_trips() {
        let Some(pool) = live_pool().await else {
            return;
        };
        let email = format!("rust-api-key-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        upsert(&pool, user.id, "openai", "sk-secret-value", TEST_ENCRYPTION_KEY)
            .await
            .unwrap();
        let stored = get_active_by_provider(&pool, user.id, "openai")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.key_prefix.as_deref(), Some("sk-secre"));
        assert_eq!(decrypt(&stored, TEST_ENCRYPTION_KEY).unwrap(), "sk-secret-value");

        upsert(&pool, user.id, "openai", "sk-rotated-value", TEST_ENCRYPTION_KEY)
            .await
            .unwrap();
        let rotated = get_by_provider(&pool, user.id, "openai").await.unwrap().unwrap();
        assert_eq!(rotated.id, stored.id);
        assert_eq!(decrypt(&rotated, TEST_ENCRYPTION_KEY).unwrap(), "sk-rotated-value");

        assert!(delete(&pool, user.id, stored.id).await.unwrap());
        assert!(get_by_provider(&pool, user.id, "openai").await.unwrap().is_none());

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await
            .ok();
    }
}
