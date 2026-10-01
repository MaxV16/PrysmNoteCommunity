//! Cross-session memory extraction and retrieval for the AI chat.
//!
//! Mirrors Python `services/memory_service.py`: durable facts are distilled
//! from a chat turn by the LLM, deduplicated and capped, then retrieved for
//! later turns by keyword overlap (no embeddings needed). All operations are
//! fail-open - a memory problem must never break a chat request.

use std::collections::HashSet;

use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::llm::LlmClient;

/// How many memories are injected into a later turn.
pub const MEMORY_TOP_K: usize = 5;
/// How many facts are extracted per turn.
pub const MEMORY_PER_TURN: usize = 5;
/// Maximum active memories retained per user.
pub const MEMORY_MAX_ACTIVE: i64 = 60;
/// Approximate token budget for injected memories.
pub const MEMORY_INJECT_MAX_TOKENS: usize = 400;
/// Jaccard overlap above which two facts count as duplicates.
const DUPLICATE_THRESHOLD: f64 = 0.92;

/// A single distilled fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFact {
    pub content: String,
    pub category: String,
}

fn extraction_prompt(transcript: &str) -> String {
    format!(
        "You distill durable, cross-session facts from a task-management chat so the assistant \
can recall them later (appointments, preferences, life context, recurring commitments). Return \
ONLY a JSON array of up to {MEMORY_PER_TURN} objects, each with a \"content\" string (a single \
discrete fact, first-person from the USER's perspective) and a \"category\" string (one of: task \
| preference | schedule | context). Skip trivia, one-off task minutiae, and anything already \
implied by the raw chat history. Empty array if nothing durable is worth remembering.\n\nChat\n\
{transcript}\n\nJSON:"
    )
}

/// Lowercase, collapse whitespace, and cap at 200 characters.
fn normalize(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    collapsed.chars().take(200).collect()
}

/// Word-set Jaccard overlap at or above the threshold (why a fact is skipped).
fn is_near_duplicate(existing: &[String], content: &str) -> bool {
    let a = normalize(content);
    let words_a: HashSet<&str> = a.split(' ').filter(|w| !w.is_empty()).collect();
    for previous in existing {
        let b = normalize(previous);
        if b.is_empty() {
            continue;
        }
        if a == b && !a.is_empty() {
            return true;
        }
        let words_b: HashSet<&str> = b.split(' ').filter(|w| !w.is_empty()).collect();
        if words_a.is_empty() || words_b.is_empty() {
            continue;
        }
        let intersection = words_a.intersection(&words_b).count() as f64;
        let union = words_a.union(&words_b).count().max(1) as f64;
        let overlap = intersection / union;
        if overlap >= DUPLICATE_THRESHOLD
            && words_a.len().min(words_b.len()) >= 3
        {
            return true;
        }
    }
    false
}

/// Distill durable facts from a turn. Fail-open (returns empty on any error).
pub async fn extract_memories(
    client: &LlmClient,
    history: &[Value],
    user_message: &str,
    assistant_content: &str,
) -> Vec<MemoryFact> {
    if !assistant_content.is_empty() && user_message.is_empty() && history.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<String> = Vec::new();
    let recent: Vec<&Value> = history.iter().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    for message in recent {
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if !matches!(role, "user" | "assistant" | "tool") {
            continue;
        }
        let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
        parts.push(format!("{}: {}", role, content.chars().take(400).collect::<String>()));
    }
    parts.push(format!("user: {user_message}"));
    parts.push(format!("assistant: {assistant_content}"));
    let mut transcript = parts.join("\n");
    if transcript.chars().count() > 4000 {
        let skip = transcript.chars().count() - 4000;
        transcript = transcript.chars().skip(skip).collect();
    }
    let messages = json!([{ "role": "user", "content": extraction_prompt(&transcript) }]);
    let response = match client.chat(&messages, None, Some(0.1), Some(300)).await {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let content = LlmClient::first_choice(&response)
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let cleaned = if content.starts_with("```") {
        content
            .trim_matches('`')
            .trim()
            .trim_start_matches("json")
            .trim()
            .to_string()
    } else {
        content
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&cleaned) else {
        return Vec::new();
    };
    let mut out: Vec<MemoryFact> = Vec::new();
    for item in items.into_iter().take(MEMORY_PER_TURN) {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let content = obj
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if content.chars().count() < 12 {
            continue;
        }
        let raw_category = obj
            .get("category")
            .and_then(|c| c.as_str())
            .unwrap_or("context")
            .trim()
            .to_lowercase();
        let category = if matches!(raw_category.as_str(), "task" | "preference" | "schedule" | "context") {
            raw_category
        } else {
            "context".to_string()
        };
        out.push(MemoryFact { content, category });
    }
    out
}

/// Store facts, skipping duplicates, and trim the active set to the cap.
/// Returns how many were stored. Fail-open (returns 0 on error).
pub async fn store_memories(
    conn: &mut PgConnection,
    user_id: Uuid,
    source_session_id: Option<Uuid>,
    memories: &[MemoryFact],
) -> i64 {
    if memories.is_empty() {
        return 0;
    }
    let result = store_memories_inner(conn, user_id, source_session_id, memories).await;
    result.unwrap_or(0)
}

async fn store_memories_inner(
    conn: &mut PgConnection,
    user_id: Uuid,
    source_session_id: Option<Uuid>,
    memories: &[MemoryFact],
) -> Result<i64, sqlx::Error> {
    let existing_rows = sqlx::query(
        "SELECT content FROM ai_memories WHERE user_id = $1 AND is_active = true",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut existing: Vec<String> = existing_rows
        .iter()
        .map(|row| row.try_get::<String, _>("content").unwrap_or_default())
        .collect();
    let mut stored = 0i64;
    for fact in memories {
        let content = fact.content.trim();
        if content.is_empty() || is_near_duplicate(&existing, content) {
            continue;
        }
        sqlx::query(
            "INSERT INTO ai_memories (user_id, content, category, source_session_id, is_active) \
             VALUES ($1, $2, $3, $4, true)",
        )
        .bind(user_id)
        .bind(content)
        .bind(&fact.category)
        .bind(source_session_id)
        .execute(&mut *conn)
        .await?;
        existing.push(content.to_string());
        stored += 1;
    }
    if stored > 0 {
        sqlx::query(
            "DELETE FROM ai_memories WHERE id IN ( \
             SELECT id FROM ai_memories WHERE user_id = $1 AND is_active = true \
             ORDER BY created_at DESC OFFSET $2)",
        )
        .bind(user_id)
        .bind(MEMORY_MAX_ACTIVE)
        .execute(&mut *conn)
        .await?;
    }
    Ok(stored)
}

/// Retrieve the most keyword-relevant active memories for a user message.
pub async fn retrieve_relevant_memories(
    conn: &mut PgConnection,
    user_id: Uuid,
    user_message: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT content FROM ai_memories WHERE user_id = $1 AND is_active = true \
         ORDER BY created_at DESC LIMIT 200",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let tokens: HashSet<String> = normalize(user_message)
        .split(' ')
        .filter(|t| t.chars().count() > 3)
        .map(|t| t.to_string())
        .collect();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let mut scored: Vec<(usize, String)> = Vec::new();
    for row in rows {
        let content: String = row.try_get("content")?;
        let normalized = normalize(&content);
        let score = tokens.iter().filter(|t| normalized.contains(t.as_str())).count();
        if score > 0 {
            scored.push((score, content));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(scored.into_iter().take(MEMORY_TOP_K).map(|(_, c)| c).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_and_lowercases() {
        assert_eq!(normalize("  Hello   WORLD "), "hello world");
    }

    #[test]
    fn near_duplicates_are_detected() {
        let existing = vec!["I prefer morning meetings".to_string()];
        assert!(is_near_duplicate(&existing, "I prefer morning meetings"));
        assert!(!is_near_duplicate(&existing, "I like tea"));
    }
}
