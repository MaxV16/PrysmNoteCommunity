//! Passkey (WebAuthn credential) repository. Mirrors the Python `passkeys`
//! table and the CRUD helpers in `routers/passkeys.py`. Runtime queries only.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A stored WebAuthn credential.
#[derive(Debug, Clone)]
pub struct Passkey {
    pub id: Uuid,
    pub user_id: Uuid,
    pub credential_id: String,
    pub public_key: Vec<u8>,
    pub sign_count: i32,
    pub transports: Option<String>,
    pub aaguid: Option<String>,
    pub name: Option<String>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
}

const COLUMNS: &str = "id, user_id, credential_id, public_key, sign_count, transports, \
                       aaguid, name, last_used_at, created_at";

fn row_to_passkey(row: &PgRow) -> Passkey {
    Passkey {
        id: row.get("id"),
        user_id: row.get("user_id"),
        credential_id: row.get("credential_id"),
        public_key: row.get("public_key"),
        sign_count: row.get("sign_count"),
        transports: row.get("transports"),
        aaguid: row.get("aaguid"),
        name: row.get("name"),
        last_used_at: row.get("last_used_at"),
        created_at: row.get("created_at"),
    }
}

/// List a user's passkeys, newest first (matches the Python list endpoint).
pub async fn list_for_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<Passkey>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC");
    let rows = sqlx::query(&sql).bind(user_id).fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_passkey).collect())
}

/// Fetch one of a user's passkeys by id.
pub async fn get_for_user(
    pool: &PgPool,
    id: Uuid,
    user_id: Uuid,
) -> Result<Option<Passkey>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM passkeys WHERE id = $1 AND user_id = $2");
    Ok(sqlx::query(&sql)
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .map(|row| row_to_passkey(&row)))
}

/// Look up a credential by its base64url id (unauthenticated login path).
pub async fn get_by_credential_id(
    pool: &PgPool,
    credential_id: &str,
) -> Result<Option<Passkey>, sqlx::Error> {
    let sql = format!("SELECT {COLUMNS} FROM passkeys WHERE credential_id = $1");
    Ok(sqlx::query(&sql)
        .bind(credential_id)
        .fetch_optional(pool)
        .await?
        .map(|row| row_to_passkey(&row)))
}

/// Count how many passkeys a user has registered.
pub async fn count_for_user(pool: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(row.get("n"))
}

/// Insert a newly registered passkey and return the stored row.
pub async fn insert(
    pool: &PgPool,
    user_id: Uuid,
    credential_id: &str,
    public_key: &[u8],
    sign_count: i32,
    transports: Option<&str>,
    aaguid: Option<&str>,
    name: Option<&str>,
) -> Result<Passkey, sqlx::Error> {
    let sql = format!(
        "INSERT INTO passkeys \
         (user_id, credential_id, public_key, sign_count, transports, aaguid, name) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(user_id)
        .bind(credential_id)
        .bind(public_key)
        .bind(sign_count)
        .bind(transports)
        .bind(aaguid)
        .bind(name)
        .fetch_one(pool)
        .await?;
    Ok(row_to_passkey(&row))
}

/// Rename one of a user's passkeys.
pub async fn rename(
    pool: &PgPool,
    id: Uuid,
    user_id: Uuid,
    name: &str,
) -> Result<Option<Passkey>, sqlx::Error> {
    let sql = format!(
        "UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING {COLUMNS}"
    );
    Ok(sqlx::query(&sql)
        .bind(id)
        .bind(user_id)
        .bind(name)
        .fetch_optional(pool)
        .await?
        .map(|row| row_to_passkey(&row)))
}

/// Delete one of a user's passkeys. Returns true when a row was removed.
pub async fn delete(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM passkeys WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Persist the new signature counter and last-used timestamp after a login.
pub async fn touch_after_auth(
    pool: &PgPool,
    id: Uuid,
    sign_count: i32,
    last_used_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE passkeys SET sign_count = $2, last_used_at = $3 WHERE id = $1")
        .bind(id)
        .bind(sign_count)
        .bind(last_used_at)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn insert_list_rename_delete_round_trips() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = match crate::db::connect(&url).await {
            Ok(pool) => pool,
            Err(_) => return,
        };
        let email = format!("rust-passkey-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(
            &pool,
            &email,
            "$2b$12$placeholderplaceholderplaceholder",
            None,
        )
        .await
        .expect("insert user");

        let cred_id = format!("cred-{}", Uuid::new_v4());
        let pk = vec![0xa1u8, 0x01, 0x02];
        let stored = insert(&pool, user.id, &cred_id, &pk, 0, Some("internal"), None, Some("Laptop"))
            .await
            .expect("insert passkey");
        assert_eq!(stored.credential_id, cred_id);
        assert_eq!(stored.public_key, pk);

        let listed = list_for_user(&pool, user.id).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(count_for_user(&pool, user.id).await.unwrap(), 1);

        let found = get_by_credential_id(&pool, &cred_id).await.unwrap();
        assert_eq!(found.unwrap().id, stored.id);

        let renamed = rename(&pool, stored.id, user.id, "Desktop")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(renamed.name.as_deref(), Some("Desktop"));

        touch_after_auth(&pool, stored.id, 7, Utc::now())
            .await
            .expect("touch");
        assert_eq!(
            get_for_user(&pool, stored.id, user.id)
                .await
                .unwrap()
                .unwrap()
                .sign_count,
            7
        );

        assert!(delete(&pool, stored.id, user.id).await.unwrap());
        assert!(!delete(&pool, stored.id, user.id).await.unwrap());

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await
            .expect("cleanup");
    }
}
