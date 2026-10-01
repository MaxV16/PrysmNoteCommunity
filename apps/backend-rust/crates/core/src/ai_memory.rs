//! Durable cross-session AI memories (core), mirroring the storage shape of
//! Python `models/ai_memory.py`. Retrieval/storage by embedding is deferred;
//! this module covers listing and deletion, which is what the API exposes.

use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Active memories for a user, newest first.
pub async fn list_active(
    conn: &mut PgConnection,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, content, category, source_session_id, created_at FROM ai_memories \
         WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let created: Option<chrono::DateTime<chrono::Utc>> = row.get("created_at");
            let source: Option<Uuid> = row.get("source_session_id");
            json!({
                "id": row.get::<Uuid, _>("id").to_string(),
                "content": row.get::<String, _>("content"),
                "category": row.get::<String, _>("category"),
                "source_session_id": source.map(|s| s.to_string()),
                "created_at": created.map(|c| c.to_rfc3339()),
            })
        })
        .collect())
}

/// Delete one memory. Returns true when a row was removed.
pub async fn delete(conn: &mut PgConnection, user_id: Uuid, memory_id: Uuid) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM ai_memories WHERE user_id = $1 AND id = $2")
        .bind(user_id)
        .bind(memory_id)
        .execute(&mut *conn)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Purge every memory sourced from a session (called when the session is deleted).
pub async fn purge_for_session(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let result =
        sqlx::query("DELETE FROM ai_memories WHERE user_id = $1 AND source_session_id = $2")
            .bind(user_id)
            .bind(session_id)
            .execute(&mut *conn)
            .await?;
    Ok(result.rows_affected())
}
