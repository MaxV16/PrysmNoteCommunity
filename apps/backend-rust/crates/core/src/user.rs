//! Minimal user repository (Phase 1). Mirrors the Python `users` table and the
//! `get_user_by_email` / `create_user` helpers in `auth_service.py`. Uses
//! runtime queries only (no sqlx macros), so the crate builds without a
//! DATABASE_URL at compile time.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// The columns the auth flow needs from `users`.
#[derive(Debug, Clone, PartialEq)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub password_hash: Option<String>,
    pub display_name: Option<String>,
    pub email_verified: bool,
    pub token_version: i32,
    pub provider: Option<String>,
}

const COLUMNS: &str =
    "id, email, password_hash, display_name, email_verified, token_version, provider";

fn row_to_user(row: &PgRow) -> User {
    User {
        id: row.get("id"),
        email: row.get("email"),
        password_hash: row.get("password_hash"),
        display_name: row.get("display_name"),
        email_verified: row.get("email_verified"),
        token_version: row.get("token_version"),
        provider: row.get("provider"),
    }
}

/// Look up a user by email (the caller lowercases and strips it first).
pub async fn get_by_email(pool: &PgPool, email: &str) -> Result<Option<User>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM users WHERE email = $1");
    Ok(sqlx::query(&sql)
        .bind(email)
        .fetch_optional(pool)
        .await?
        .map(|row| row_to_user(&row)))
}

/// Insert a new email/password user and return the stored row.
pub async fn create_email_user(
    pool: &PgPool,
    email: &str,
    password_hash: &str,
    display_name: Option<&str>,
) -> Result<User, sqlx::Error> {
    let sql = format!(
        "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) \
         RETURNING {COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(email)
        .bind(password_hash)
        .bind(display_name)
        .fetch_one(pool)
        .await?;
    Ok(row_to_user(&row))
}

/// Find or create the account for a verified SSO identity.
///
/// Mirrors `oauth.py::_getorcreate_user`: an existing row is linked to the
/// provider (when it was previously email/password) and marked verified; a new
/// row is created with no password hash. `name` is already trimmed/truncated by
/// the caller.
pub async fn get_or_create_oauth_user(
    pool: &PgPool,
    email: &str,
    display_name: Option<&str>,
    provider: &str,
) -> Result<User, sqlx::Error> {
    if let Some(existing) = get_by_email(pool, email).await? {
        let sql = format!(
            "UPDATE users SET provider = COALESCE(provider, $2), email_verified = true \
             WHERE id = $1 RETURNING {COLUMNS}"
        );
        let row = sqlx::query(&sql)
            .bind(existing.id)
            .bind(provider)
            .fetch_one(pool)
            .await?;
        return Ok(row_to_user(&row));
    }

    let sql = format!(
        "INSERT INTO users (email, password_hash, display_name, provider, email_verified) \
         VALUES ($1, NULL, $2, $3, true) RETURNING {COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(email)
        .bind(display_name)
        .bind(provider)
        .fetch_one(pool)
        .await?;
    Ok(row_to_user(&row))
}

/// Look up a user by id.
pub async fn get_by_id(pool: &PgPool, id: Uuid) -> Result<Option<User>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM users WHERE id = $1");
    Ok(sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|row| row_to_user(&row)))
}

/// Set a new password hash and bump the token version, invalidating every
/// session minted before the change (matches the Python reset/change flow).
pub async fn update_password(
    pool: &PgPool,
    id: Uuid,
    password_hash: &str,
) -> Result<Option<User>, sqlx::Error> {
    let sql = format!(
        "UPDATE users SET password_hash = $2, token_version = token_version + 1 \
         WHERE id = $1 RETURNING {COLUMNS}"
    );
    Ok(sqlx::query(&sql)
        .bind(id)
        .bind(password_hash)
        .fetch_optional(pool)
        .await?
        .map(|row| row_to_user(&row)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Integration test: runs only when DATABASE_URL is set (the app schema must
    // already exist). It round-trips a throwaway user and cleans up.
    #[tokio::test]
    async fn insert_then_lookup_round_trips() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = match crate::db::connect(&url).await {
            Ok(pool) => pool,
            Err(_) => return,
        };
        let email = format!("rust-test-{}@test.local", Uuid::new_v4());
        let created =
            super::create_email_user(&pool, &email, "$2b$12$placeholderplaceholderplaceholder", Some("Rust Test"))
                .await
                .expect("insert");
        assert_eq!(created.email, email);
        assert!(!created.email_verified);
        assert_eq!(created.token_version, 0);

        let found = super::get_by_email(&pool, &email).await.expect("lookup");
        let found = found.expect("row exists");
        assert_eq!(found.id, created.id);
        assert_eq!(found.display_name.as_deref(), Some("Rust Test"));

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(created.id)
            .execute(&pool)
            .await
            .expect("cleanup");
    }
}
