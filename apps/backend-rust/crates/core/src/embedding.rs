//! Background task embeddings, ported from
//! `apps/backend/app/services/embedding_service.py`.
//!
//! Embeddings are best-effort and fire-and-forget: they are generated with the
//! user's own BYOK key (the hosted PrysmAI gateway does not expose embeddings),
//! stored in the pgvector `task_embeddings` table, and skipped when the source
//! text is unchanged. A missing key or a provider error is swallowed, so a slow
//! or absent embedding provider can never affect a request.

use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};
use std::sync::OnceLock;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::llm::LlmClient;

/// Caps how many embedding provider calls overlap process-wide; an import or a
/// burst of edits must not fan out unbounded concurrent requests.
static EMBED_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn embed_semaphore() -> &'static Semaphore {
    EMBED_SEMAPHORE.get_or_init(|| Semaphore::new(2))
}

/// The text actually embedded: title plus description when present.
pub fn embedding_text(title: &str, description: Option<&str>) -> String {
    match description {
        Some(desc) if !desc.is_empty() => format!("{title}\n{desc}"),
        _ => title.to_string(),
    }
}

/// Stable content hash used to skip re-embedding unchanged text.
pub fn source_hash(title: &str, description: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(embedding_text(title, description).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Render a `Vec<f32>` as a pgvector literal (`[1,2,3]`).
fn vector_literal(embedding: &[f32]) -> String {
    let mut out = String::from("[");
    for (index, value) in embedding.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

/// Build an embedding-capable client from an already-loaded BYOK key. Returns
/// `None` when the provider does not support embeddings or the stored key
/// cannot be decrypted with the current `ENCRYPTION_KEY`.
pub(crate) fn client_from_key(
    key: &crate::api_key::ApiKey,
    encryption_key: &str,
) -> Option<LlmClient> {
    let provider = crate::llm::Provider::parse(&key.provider)?;
    if !provider.supports_embeddings() {
        return None;
    }
    let api_key = crate::api_key::decrypt(key, encryption_key).ok()?;
    LlmClient::new(&key.provider, &api_key).ok()
}

/// Look up the user's active BYOK key and build an embedding-capable client.
pub(crate) async fn client_for_user(
    pool: &sqlx::PgPool,
    encryption_key: &str,
    user_id: Uuid,
) -> Option<LlmClient> {
    let key = crate::api_key::get_active_for_user(pool, user_id).await.ok().flatten()?;
    client_from_key(&key, encryption_key)
}

/// Read the stored source hash for a task, if an embedding row exists.
async fn existing_hash(conn: &mut PgConnection, task_id: Uuid) -> Option<Option<String>> {
    sqlx::query("SELECT source_hash FROM task_embeddings WHERE task_id = $1")
        .bind(task_id)
        .fetch_optional(conn)
        .await
        .ok()
        .flatten()
        .map(|row| row.try_get::<Option<String>, _>("source_hash").unwrap_or(None))
}

/// Generate and store an embedding for a task, skipping unchanged text or a
/// missing/unsupported key. Always Ok; failures are swallowed by design.
pub async fn generate_and_store_embedding(
    pool: &sqlx::PgPool,
    encryption_key: &str,
    task_id: Uuid,
    user_id: Uuid,
    title: &str,
    description: Option<&str>,
) {
    // A user with no usable AI path is skipped before touching the provider.
    if crate::ai_entitlement::check_allowance(pool, user_id).await.mode == "none" {
        return;
    }

    let Some(client) = client_for_user(pool, encryption_key, user_id).await else {
        return;
    };

    let text = embedding_text(title, description);
    let hash = source_hash(title, description);

    // Unchanged text already has an embedding: skip the provider call.
    {
        let Ok(mut conn) = pool.acquire().await else {
            return;
        };
        if let Some(current) = existing_hash(&mut conn, task_id).await {
            if current.as_deref() == Some(hash.as_str()) {
                return;
            }
        }
    }

    let embedding = {
        let _permit = embed_semaphore().acquire().await;
        match client.embed(&text).await {
            Ok(values) => values,
            Err(_) => return,
        }
    };

    if let Ok(mut conn) = pool.acquire().await {
        let _ = store_embedding(&mut conn, task_id, &embedding, Some(&hash)).await;
    }
}

/// Fire-and-forget wrapper: spawns the embedding off the request path.
pub fn spawn_embedding(
    pool: sqlx::PgPool,
    encryption_key: String,
    task_id: Uuid,
    user_id: Uuid,
    title: String,
    description: Option<String>,
) {
    tokio::spawn(async move {
        generate_and_store_embedding(
            &pool,
            &encryption_key,
            task_id,
            user_id,
            &title,
            description.as_deref(),
        )
        .await;
    });
}

/// Insert or replace the embedding row for a task.
pub async fn store_embedding(
    conn: &mut PgConnection,
    task_id: Uuid,
    embedding: &[f32],
    source_hash: Option<&str>,
) -> Result<(), sqlx::Error> {
    let literal = vector_literal(embedding);
    sqlx::query(
        "INSERT INTO task_embeddings (task_id, embedding, source_hash, updated_at) \
         VALUES ($1, $2::vector, $3, now()) \
         ON CONFLICT (task_id) DO UPDATE \
         SET embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, updated_at = now()",
    )
    .bind(task_id)
    .bind(literal)
    .bind(source_hash)
    .execute(conn)
    .await?;
    Ok(())
}

/// Nearest tasks by cosine distance, scored as similarity `1 - distance`.
pub async fn search_similar(
    conn: &mut PgConnection,
    embedding: &[f32],
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<(crate::task::Task, f64)>, sqlx::Error> {
    let literal = vector_literal(embedding);
    let rows = sqlx::query(
        "SELECT e.task_id AS task_id, (1 - (e.embedding <=> $1::vector)) AS score \
         FROM task_embeddings e JOIN tasks t ON t.id = e.task_id \
         WHERE t.user_id = $2 AND t.deleted_at IS NULL \
         ORDER BY e.embedding <=> $1::vector LIMIT $3",
    )
    .bind(literal)
    .bind(user_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;

    let mut out = Vec::new();
    for row in rows {
        let task_id: Uuid = row.try_get("task_id")?;
        let score: f64 = row.try_get("score").unwrap_or(0.0);
        if let Some(task) = crate::task::find_task(&mut *conn, task_id, user_id, false).await? {
            out.push((task, score));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_hash_are_stable() {
        assert_eq!(embedding_text("Buy milk", None), "Buy milk");
        assert_eq!(embedding_text("Buy milk", Some("2 litres")), "Buy milk\n2 litres");
        assert_eq!(embedding_text("Buy milk", Some("")), "Buy milk");
        let a = source_hash("Buy milk", None);
        assert_eq!(a.len(), 64);
        assert_eq!(a, source_hash("Buy milk", Some("")));
        assert_ne!(a, source_hash("Buy milk", Some("2 litres")));
    }

    #[test]
    fn vector_literal_formats_pgvector() {
        assert_eq!(vector_literal(&[0.5, -1.0, 2.0]), "[0.5,-1,2]");
    }

    #[tokio::test]
    async fn store_and_search_round_trip() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let Ok(pool) = crate::db::connect(&url).await else {
            return;
        };
        let email = format!("rust-embed-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");
        let mut conn = pool.acquire().await.expect("acquire");

        let task_id: Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (user_id, title, status, priority, is_all_day, is_archived, sort_order) \
             VALUES ($1, 'Embedded task', 'todo'::task_status, 2, false, false, 0) RETURNING id",
        )
        .bind(user.id)
        .fetch_one(&mut *conn)
        .await
        .expect("insert task");

        let vector = vec![0.1f32; 1536];
        store_embedding(&mut conn, task_id, &vector, Some("hash"))
            .await
            .expect("store");
        let hits = search_similar(&mut conn, &vector, user.id, 10).await.expect("search");
        assert!(hits.iter().any(|(task, _)| task.id == task_id));

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&mut *conn)
            .await
            .expect("cleanup");
    }
}
