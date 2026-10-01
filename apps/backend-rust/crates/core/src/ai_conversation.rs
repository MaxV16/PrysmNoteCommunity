//! AI conversation + session-summary storage, mirroring the core Python
//! `models/ai_conversation.py` and `models/ai_session.py`.

use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Insert a conversation message.
pub async fn insert_conversation(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
    role: &str,
    content: &str,
    tool_calls: Option<&Value>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO ai_conversations (user_id, session_id, role, content, tool_calls) \
         VALUES ($1, $2, $3, $4, $5::jsonb)",
    )
    .bind(user_id)
    .bind(session_id)
    .bind(role)
    .bind(content)
    .bind(tool_calls)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Insert a conversation message and return its id (used for the assistant
/// placeholder that is committed before the final stream, then updated).
pub async fn insert_conversation_returning_id(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
    role: &str,
    content: &str,
    tool_calls: Option<&Value>,
) -> Result<Uuid, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO ai_conversations (user_id, session_id, role, content, tool_calls) \
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id",
    )
    .bind(user_id)
    .bind(session_id)
    .bind(role)
    .bind(content)
    .bind(tool_calls)
    .fetch_one(&mut *conn)
    .await?;
    row.try_get("id")
}

/// Replace the content of a persisted conversation row.
pub async fn update_conversation_content(
    conn: &mut PgConnection,
    user_id: Uuid,
    conversation_id: Uuid,
    content: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE ai_conversations SET content = $3 WHERE id = $1 AND user_id = $2")
        .bind(conversation_id)
        .bind(user_id)
        .bind(content)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// One conversation row.
pub struct ConversationRow {
    pub role: String,
    pub content: String,
    pub tool_calls: Option<Value>,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// All messages of a session, oldest first.
pub async fn list_conversation(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<Vec<ConversationRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT role, content, tool_calls, created_at FROM ai_conversations \
         WHERE user_id = $1 AND session_id = $2 ORDER BY created_at",
    )
    .bind(user_id)
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| ConversationRow {
            role: row.get("role"),
            content: row.get("content"),
            tool_calls: row.get("tool_calls"),
            created_at: row.get("created_at"),
        })
        .collect())
}

/// A session summary row for the sessions list.
pub struct SessionSummary {
    pub session_id: Uuid,
    pub message_count: i64,
    pub last_message_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Grouped sessions for a user, newest activity first.
pub async fn list_sessions(
    conn: &mut PgConnection,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<SessionSummary>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT session_id, COUNT(id)::bigint AS message_count, MAX(created_at) AS last_at \
         FROM ai_conversations WHERE user_id = $1 GROUP BY session_id \
         ORDER BY MAX(created_at) DESC LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| SessionSummary {
            session_id: row.get("session_id"),
            message_count: row.get("message_count"),
            last_message_at: row.get("last_at"),
        })
        .collect())
}

/// Titles derived from each session's first user message.
pub async fn first_user_contents(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_ids: &[Uuid],
) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT session_id, content FROM ai_conversations \
         WHERE user_id = $1 AND session_id = ANY($2) AND role = 'user' \
         ORDER BY created_at",
    )
    .bind(user_id)
    .bind(session_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in &rows {
        let sid: Uuid = row.get("session_id");
        if seen.insert(sid) {
            out.push((sid, row.get::<String, _>("content")));
        }
    }
    Ok(out)
}

/// Rolling summaries for the given sessions.
pub async fn session_summaries(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_ids: &[Uuid],
) -> Result<Vec<(Uuid, Option<String>)>, sqlx::Error> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT session_id, summary FROM ai_sessions WHERE user_id = $1 AND session_id = ANY($2)",
    )
    .bind(user_id)
    .bind(session_ids)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| (row.get("session_id"), row.get("summary")))
        .collect())
}

/// Summary row for one session, if present.
pub async fn get_summary(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT summary FROM ai_sessions WHERE user_id = $1 AND session_id = $2")
        .bind(user_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.and_then(|row| row.get("summary")))
}

/// Create a session summary row if missing.
pub async fn create_summary_if_missing(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO ai_sessions (user_id, session_id) SELECT $1, $2 \
         WHERE NOT EXISTS (SELECT 1 FROM ai_sessions WHERE user_id = $1 AND session_id = $2)",
    )
    .bind(user_id)
    .bind(session_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Set a session's rolling summary.
pub async fn update_summary(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
    summary: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE ai_sessions SET summary = $3, updated_at = now() \
         WHERE user_id = $1 AND session_id = $2",
    )
    .bind(user_id)
    .bind(session_id)
    .bind(summary)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Delete a session's summary + conversations. Returns (sessions, conversations).
pub async fn delete_session(
    conn: &mut PgConnection,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<(u64, u64), sqlx::Error> {
    let sessions = sqlx::query("DELETE FROM ai_sessions WHERE user_id = $1 AND session_id = $2")
        .bind(user_id)
        .bind(session_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    let convs = sqlx::query("DELETE FROM ai_conversations WHERE user_id = $1 AND session_id = $2")
        .bind(user_id)
        .bind(session_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok((sessions, convs))
}
