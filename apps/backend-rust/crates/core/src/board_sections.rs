//! `/api/board-sections` routes: kanban/board/timeline section definitions.
//!
//! Mirrors the Python `routers/board_sections.py` contract, including the
//! one-time kanban seed marker (`prysm_board_sections_seeded_<kind>` in
//! `user_preferences`) so a user who deletes every default section does not get
//! them lazily re-seeded. Timeline sections never auto-seed. The AI
//! `auto-organize` route classifies a user's dated tasks into short topic
//! sections (mirroring `services/timeline_organizer.py`) and pins each task to
//! a `kind = "timeline"` row. The section list is served through the cache-aside
//! store (Redis when configured, otherwise in-process) with a 20 second TTL;
//! every write invalidates it.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::db;
use crate::error::ApiError;
use crate::llm::LlmClient;
use crate::task::{Task, COLUMNS, STATUSES};
use crate::{ai_chat, ai_entitlement, api_key};
use crate::AppState;

const VALID_KINDS: [&str; 3] = ["kanban", "board", "timeline"];
const SECTION_TITLE_MAX: usize = 200;
const SECTIONS_CACHE_TTL: u64 = 20;
const SEED_FLAG_PREFIX: &str = "prysm_board_sections_seeded_";

/// Timeline auto-organize tuning, mirroring `timeline_organizer.py`.
const ORGANIZE_BATCH_SIZE: usize = 40;
const ORGANIZE_MAX_TASKS: i64 = 1000;
const ORGANIZE_MAX_TOPICS: usize = 20;
const ORGANIZE_MAX_OUTPUT_TOKENS: u32 = 6000;
const ORGANIZE_MAX_PER_HOUR: u32 = 6;
const SECTION_KIND_TIMELINE: &str = "timeline";
const TOPIC_COLORS: [&str; 20] = [
    "#4FC3F7", "#FFA726", "#66BB6A", "#EF5350", "#AB47BC", "#26A69A", "#FFCA28", "#8D6E63",
    "#42A5F5", "#EC407A", "#7E57C2", "#29B6F6", "#9CCC65", "#FF7043", "#5C6BC0", "#26C6DA",
    "#D4E157", "#FFA000", "#78909C", "#8E24AA",
];

/// Shared `rl:ai` limiter for the auto-sort route.
fn organize_limiter() -> &'static crate::ratelimit::RateLimiter {
    static LIMITER: OnceLock<crate::ratelimit::RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| crate::ratelimit::RateLimiter::from_env("rl:ai"))
}

/// The cache key for one section scope (`kind` + optional list).
fn sections_cache_key(user_id: Uuid, kind: &str, list_id: Option<Uuid>) -> String {
    let list_part = list_id.map(|u| u.to_string()).unwrap_or_else(|| "none".to_string());
    crate::cache::user_cache_key("board_sections", user_id, &[kind, &list_part])
}

/// Drop every cached section scope for a user.
async fn invalidate_sections(state: &AppState, user_id: Uuid) {
    let prefix = crate::cache::user_cache_key("board_sections", user_id, &[]);
    crate::cache::cache_delete_prefix(&state.cache, &prefix).await;
}

/// Default kanban sections: `(status, title, color)`.
const DEFAULT_KANBAN_SECTIONS: [(&str, &str, &str); 4] = [
    ("backlog", "Backlog", "#9E9E9E"),
    ("todo", "To Do", "#4FC3F7"),
    ("in_progress", "In Progress", "#FFA726"),
    ("done", "Done", "#66BB6A"),
];

/// The `/api/board-sections` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/board-sections", get(list_sections).post(create_section))
        .route("/api/board-sections/", get(list_sections).post(create_section))
        .route("/api/board-sections/auto-organize", post(auto_organize))
        .route(
            "/api/board-sections/{section_id}",
            patch(update_section).delete(delete_section),
        )
}

#[derive(Deserialize, Default)]
struct AutoOrganizeRequest {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    list_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct ListQuery {
    kind: Option<String>,
    list_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateSectionRequest {
    kind: String,
    title: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    position: Option<i32>,
    #[serde(default)]
    list_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct UpdateSectionRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    position: Option<i32>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn require_uuid(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::NotFound("Invalid id".to_string()))
}

fn parse_list_id(value: Option<&str>) -> Result<Option<Uuid>, ApiError> {
    match value {
        None | Some("") => Ok(None),
        Some(raw) => Uuid::parse_str(raw)
            .map(Some)
            .map_err(|_| ApiError::Unprocessable("Invalid list_id".to_string())),
    }
}

fn valid_kind(kind: &str) -> bool {
    VALID_KINDS.contains(&kind)
}

fn valid_status(status: &str) -> bool {
    STATUSES.contains(&status)
}

fn section_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.try_get::<Uuid, _>("id").unwrap().to_string(),
        "kind": row.try_get::<String, _>("kind").unwrap(),
        "list_id": row.try_get::<Option<Uuid>, _>("list_id").unwrap().map(|u| u.to_string()),
        "title": row.try_get::<String, _>("title").unwrap(),
        "color": row.try_get::<Option<String>, _>("color").unwrap(),
        "status": row.try_get::<Option<String>, _>("status").unwrap(),
        "position": row.try_get::<i32, _>("position").unwrap(),
    })
}

fn seed_flag_key(kind: &str) -> String {
    format!("{SEED_FLAG_PREFIX}{kind}")
}

async fn seeded_flag(
    conn: &mut PgConnection,
    user_id: Uuid,
    kind: &str,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM user_preferences WHERE user_id = $1 AND key = $2",
    )
    .bind(user_id)
    .bind(seed_flag_key(kind))
    .fetch_optional(&mut *conn)
    .await?
    .is_some())
}

/// Atomically claim the one-time default seed. Returns true only to the caller
/// that won the claim; a concurrent loser gets false and no error.
async fn claim_seed(
    conn: &mut PgConnection,
    user_id: Uuid,
    kind: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, 'true'::json) \
         ON CONFLICT (user_id, key) DO NOTHING",
    )
    .bind(user_id)
    .bind(seed_flag_key(kind))
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn next_position(
    conn: &mut PgConnection,
    user_id: Uuid,
    kind: &str,
    list_id: Option<Uuid>,
) -> Result<i32, sqlx::Error> {
    let value: Option<i32> = if list_id.is_none() {
        sqlx::query_scalar(
            "SELECT MAX(position) FROM board_sections WHERE user_id = $1 AND kind = $2 \
             AND list_id IS NULL",
        )
        .bind(user_id)
        .bind(kind)
        .fetch_one(&mut *conn)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT MAX(position) FROM board_sections WHERE user_id = $1 AND kind = $2 \
             AND list_id = $3",
        )
        .bind(user_id)
        .bind(kind)
        .bind(list_id)
        .fetch_one(&mut *conn)
        .await?
    };
    Ok(value.unwrap_or(-1) + 1)
}

async fn list_kind_sections(
    conn: &mut PgConnection,
    user_id: Uuid,
    kind: &str,
    list_id: Option<Uuid>,
) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    let sql = if list_id.is_none() {
        "SELECT id, kind, list_id, title, color, status, position FROM board_sections \
         WHERE user_id = $1 AND kind = $2 AND list_id IS NULL ORDER BY position, created_at"
    } else {
        "SELECT id, kind, list_id, title, color, status, position FROM board_sections \
         WHERE user_id = $1 AND kind = $2 AND list_id = $3 ORDER BY position, created_at"
    };
    let mut q = sqlx::query(sql).bind(user_id).bind(kind);
    if let Some(list_id) = list_id {
        q = q.bind(list_id);
    }
    q.fetch_all(&mut *conn).await
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_sections(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let kind = query.kind.clone().unwrap_or_default();
    if !valid_kind(&kind) {
        return Err(ApiError::Unprocessable("Invalid kind".to_string()));
    }
    let target_list = parse_list_id(query.list_id.as_deref())?;
    let key = sections_cache_key(user.user_id, &kind, target_list);
    if let Some(cached) = crate::cache::cache_get(&state.cache, &key).await {
        return Ok(Json(cached));
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;

    let mut sections = list_kind_sections(&mut *tx, user.user_id, &kind, target_list)
        .await
        .map_err(db_error)?;

    if !sections.is_empty() {
        // Self-heal users who predate the seed marker.
        if kind == "kanban" && !seeded_flag(&mut *tx, user.user_id, &kind).await.map_err(db_error)? {
            claim_seed(&mut *tx, user.user_id, &kind).await.map_err(db_error)?;
        }
    } else if kind == "timeline" {
        // Timeline never seeds; an empty result is the user's real choice.
    } else if seeded_flag(&mut *tx, user.user_id, &kind).await.map_err(db_error)? {
        // Marker present and no sections: the user deleted every default.
    } else if claim_seed(&mut *tx, user.user_id, &kind).await.map_err(db_error)? {
        if kind == "kanban" {
            for (position, (status, title, color)) in DEFAULT_KANBAN_SECTIONS.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO board_sections \
                     (user_id, kind, list_id, title, color, status, position) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(user.user_id)
                .bind(&kind)
                .bind(target_list)
                .bind(title)
                .bind(color)
                .bind(status)
                .bind(position as i32)
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
            }
            sections = list_kind_sections(&mut *tx, user.user_id, &kind, target_list)
                .await
                .map_err(db_error)?;
        }
    }

    let out: Vec<Value> = sections.iter().map(section_json).collect();
    tx.commit().await.map_err(db_error)?;
    let value = Value::Array(out);
    crate::cache::cache_set(&state.cache, &key, &value, SECTIONS_CACHE_TTL).await;
    Ok(Json(value))
}

async fn create_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateSectionRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    if !valid_kind(&req.kind) {
        return Err(ApiError::Unprocessable(
            "Invalid kind. Must be one of: board, kanban, timeline".to_string(),
        ));
    }
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::Unprocessable("Title is required".to_string()));
    }
    if title.chars().count() > SECTION_TITLE_MAX {
        return Err(ApiError::Unprocessable(
            "Title must be at most 200 characters".to_string(),
        ));
    }
    if let Some(status) = &req.status {
        if !valid_status(status) {
            return Err(ApiError::Unprocessable(crate::task::invalid_status_message()));
        }
    }
    let target_list = parse_list_id(req.list_id.as_deref())?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;

    // Status sections upsert by (user_id, kind, list_id, status) so the
    // frontend's one-time migration can converge titles/colors.
    if let Some(status) = &req.status {
        let sql = if target_list.is_none() {
            "SELECT id, kind, list_id, title, color, status, position FROM board_sections \
             WHERE user_id = $1 AND kind = $2 AND list_id IS NULL AND status = $3"
        } else {
            "SELECT id, kind, list_id, title, color, status, position FROM board_sections \
             WHERE user_id = $1 AND kind = $2 AND list_id = $3 AND status = $4"
        };
        let mut q = sqlx::query(sql).bind(user.user_id).bind(&req.kind);
        if let Some(list_id) = target_list {
            q = q.bind(list_id);
        }
        q = q.bind(status);
        if let Some(existing) = q.fetch_optional(&mut *tx).await.map_err(db_error)? {
            let id: Uuid = existing.try_get("id").unwrap();
            sqlx::query("UPDATE board_sections SET title = $1, color = COALESCE($2, color), position = COALESCE($3, position) WHERE id = $4")
                .bind(&title)
                .bind(&req.color)
                .bind(req.position)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
            let row = sqlx::query(
                "SELECT id, kind, list_id, title, color, status, position FROM board_sections WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
            let out = section_json(&row);
            tx.commit().await.map_err(db_error)?;
            invalidate_sections(&state, user.user_id).await;
            return Ok(Json(out));
        }
    }

    let position = match req.position {
        Some(p) => p,
        None => next_position(&mut *tx, user.user_id, &req.kind, target_list)
            .await
            .map_err(db_error)?,
    };
    let row = sqlx::query(
        "INSERT INTO board_sections (user_id, kind, list_id, title, color, status, position) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         RETURNING id, kind, list_id, title, color, status, position",
    )
    .bind(user.user_id)
    .bind(&req.kind)
    .bind(target_list)
    .bind(&title)
    .bind(&req.color)
    .bind(&req.status)
    .bind(position)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let out = section_json(&row);
    tx.commit().await.map_err(db_error)?;
    invalidate_sections(&state, user.user_id).await;
    Ok(Json(out))
}

async fn update_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(section_id): Path<String>,
    Json(req): Json<UpdateSectionRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let section_id = require_uuid(&section_id)?;
    if let Some(title) = &req.title {
        if title.trim().is_empty() {
            return Err(ApiError::Unprocessable("Title must not be empty".to_string()));
        }
        if title.chars().count() > SECTION_TITLE_MAX {
            return Err(ApiError::Unprocessable(
                "Title must be at most 200 characters".to_string(),
            ));
        }
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let exists =
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM board_sections WHERE id = $1 AND user_id = $2")
            .bind(section_id)
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Section not found".to_string()));
    }
    if let Some(title) = &req.title {
        sqlx::query("UPDATE board_sections SET title = $1 WHERE id = $2")
            .bind(title.trim())
            .bind(section_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(color) = &req.color {
        sqlx::query("UPDATE board_sections SET color = $1 WHERE id = $2")
            .bind(color)
            .bind(section_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(position) = req.position {
        sqlx::query("UPDATE board_sections SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(section_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    let row = sqlx::query(
        "SELECT id, kind, list_id, title, color, status, position FROM board_sections WHERE id = $1",
    )
    .bind(section_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let out = section_json(&row);
    tx.commit().await.map_err(db_error)?;
    invalidate_sections(&state, user.user_id).await;
    Ok(Json(out))
}

async fn delete_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(section_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let section_id = require_uuid(&section_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let exists =
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM board_sections WHERE id = $1 AND user_id = $2")
            .bind(section_id)
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Section not found".to_string()));
    }
    sqlx::query("UPDATE tasks SET board_section_id = NULL WHERE board_section_id = $1 AND user_id = $2")
        .bind(section_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("DELETE FROM board_sections WHERE id = $1")
        .bind(section_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    invalidate_sections(&state, user.user_id).await;
    Ok(Json(json!({ "status": "deleted" })))
}

// ---------------------------------------------------------------------------
// AI timeline auto-organize (mirrors services/timeline_organizer.py)
// ---------------------------------------------------------------------------

/// One existing timeline section (`kind = "timeline"`).
struct TimelineSection {
    id: Uuid,
    title: String,
}

/// Title-case a raw topic into 1 to 3 short words, mirroring
/// `_normalize_topic` (`[A-Za-z0-9][A-Za-z0-9&/+'.-]*`, max 3 words).
fn normalize_topic(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() && words.len() < 3 {
        let c = chars[i];
        if c.is_ascii_alphanumeric() {
            let start = i;
            let mut j = i + 1;
            while j < chars.len() {
                let d = chars[j];
                if d.is_ascii_alphanumeric() || matches!(d, '&' | '/' | '+' | '\'' | '.' | '-') {
                    j += 1;
                } else {
                    break;
                }
            }
            words.push(chars[start..j].iter().collect());
            i = j;
        } else {
            i += 1;
        }
    }
    if words.is_empty() {
        return "Other".to_string();
    }
    words
        .iter()
        .map(|w| {
            let mut it = w.chars();
            match it.next() {
                Some(first) => first.to_uppercase().collect::<String>() + it.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Read a JSON string literal starting at `chars[start] == '"'`; returns the
/// unescaped content and the index just past the closing quote.
fn read_json_string(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() => {
                out.push(chars[i + 1]);
                i += 2;
            }
            '"' => return Some((out, i + 1)),
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

/// Extract the first JSON value from an LLM reply, tolerating ``` fences and
/// surrounding prose; falls back to scanning `"id"`/`"topic"` string pairs.
fn extract_json_value(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    let mut candidate = trimmed.to_string();
    if candidate.starts_with("```") {
        let after = candidate.trim_start_matches("```");
        let after = match after.find('\n') {
            Some(n) => &after[n + 1..],
            None => after,
        };
        candidate = after.trim().trim_end_matches("```").trim().to_string();
    }
    for (open, close) in [('[', ']'), ('{', '}')] {
        if let (Some(a), Some(b)) = (candidate.find(open), candidate.rfind(close)) {
            if b > a {
                if let Ok(v) = serde_json::from_str::<Value>(&candidate[a..=b]) {
                    return Some(v);
                }
            }
        }
    }

    // Fallback: pair an "id"/"task_id" string with a nearby topic string.
    let chars: Vec<char> = candidate.chars().collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '"' {
            i += 1;
            continue;
        }
        let Some((key, after_key)) = read_json_string(&chars, i) else {
            i += 1;
            continue;
        };
        let mut j = after_key;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if j < chars.len() && chars[j] == ':' {
            j += 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && chars[j] == '"' {
                if let Some((value, after_value)) = read_json_string(&chars, j) {
                    pairs.push((key, value));
                    i = after_value;
                    continue;
                }
            }
        }
        i = after_key;
    }
    let mut items: Vec<Value> = Vec::new();
    let mut last_id: Option<String> = None;
    let mut pending_topic: Option<String> = None;
    for (key, value) in &pairs {
        match key.as_str() {
            "id" | "task_id" => {
                if let Some(topic) = pending_topic.take() {
                    items.push(json!({ "id": value, "topic": topic }));
                } else {
                    last_id = Some(value.clone());
                }
            }
            "topic" | "section" | "category" => {
                if let Some(id) = last_id.take() {
                    items.push(json!({ "id": id, "topic": value }));
                } else {
                    pending_topic = Some(value.clone());
                }
            }
            _ => {}
        }
    }
    if items.is_empty() {
        None
    } else {
        Some(Value::Array(items))
    }
}

/// Collect `{id -> topic}` assignments from a decoded array of pairs/objects.
fn collect_assignments(items: &[Value], out: &mut HashMap<String, String>) {
    for item in items {
        match item {
            Value::Array(pair) if pair.len() >= 2 => {
                if let Some(key) = pair[0].as_str() {
                    out.insert(
                        key.to_string(),
                        pair[1].as_str().unwrap_or("").to_string(),
                    );
                }
            }
            Value::Object(map) => {
                let task_id = map
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| map.get("task_id").and_then(|v| v.as_str()));
                let topic = map
                    .get("topic")
                    .and_then(|v| v.as_str())
                    .or_else(|| map.get("section").and_then(|v| v.as_str()))
                    .or_else(|| map.get("category").and_then(|v| v.as_str()));
                if let Some(id) = task_id {
                    out.insert(id.to_string(), topic.unwrap_or("").to_string());
                }
            }
            _ => {}
        }
    }
}

/// Parse an LLM reply into `{task_id -> topic}`, mirroring `_parse_assignments`.
fn parse_assignments(text: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let Some(value) = extract_json_value(text) else {
        return out;
    };
    match value {
        Value::Object(map) => {
            let mut nested: Option<&Vec<Value>> = None;
            for key in ["assignments", "tasks", "results", "topics"] {
                if let Some(Value::Array(arr)) = map.get(key) {
                    nested = Some(arr);
                    break;
                }
            }
            if let Some(arr) = nested {
                collect_assignments(arr, &mut out);
            } else {
                for (k, v) in map.iter() {
                    if let Value::String(s) = v {
                        out.insert(k.clone(), s.clone());
                    }
                }
            }
        }
        Value::Array(arr) => collect_assignments(&arr, &mut out),
        _ => {}
    }
    out
}

/// The organizer prompt, mirroring `_topic_prompt`.
fn topic_prompt(existing_topics: &[String], tasks: &[Task]) -> String {
    let listing: Vec<Value> = tasks
        .iter()
        .map(|t| {
            let title: String = t.title.chars().take(160).collect();
            let notes: String = t
                .description
                .clone()
                .unwrap_or_default()
                .chars()
                .take(160)
                .collect();
            json!({ "id": t.id.to_string(), "title": title, "notes": notes })
        })
        .collect();
    let existing = if existing_topics.is_empty() {
        "(none yet)".to_string()
    } else {
        existing_topics.join(", ")
    };
    let listing = serde_json::to_string(&listing).unwrap_or_else(|_| "[]".to_string());
    format!(
        "You are organizing a personal task list into short topic sections.\n\
Existing topics you should REUSE when they fit: {existing}\n\n\
For EACH task below choose exactly one topic: 1 to 3 words, Title Case, no punctuation, no \
numbering, no duplicates by meaning. Prefer the existing topics; only invent a new one when \
nothing fits. Use at most {ORGANIZE_MAX_TOPICS} topics in total. Do NOT answer with prose.\n\n\
Return ONLY a JSON array: [{{\"id\": \"<task id>\", \"topic\": \"<topic>\"}}, ...]\n\n\
Tasks:\n{listing}"
    )
}

/// Pick the provider for an auto-sort run, mirroring `_resolve_provider`.
async fn resolve_organize_provider(
    state: &AppState,
    user_id: Uuid,
    requested: Option<String>,
) -> Result<String, ApiError> {
    if let Some(p) = requested {
        if !p.is_empty() && p != "auto" {
            return Ok(p);
        }
    }
    let ent = ai_entitlement::check_allowance(&state.pool, user_id).await;
    if ent.mode == "prysmai" && !ent.blocked {
        return Ok("prysmai".to_string());
    }
    for provider in ["openai", "gemini", "deepseek", "openrouter"] {
        if api_key::get_active_by_provider(&state.pool, user_id, provider)
            .await
            .map_err(db_error)?
            .is_some()
        {
            return Ok(provider.to_string());
        }
    }
    if let Some(key) = api_key::get_active_for_user(&state.pool, user_id)
        .await
        .map_err(db_error)?
    {
        return Ok(key.provider);
    }
    Ok(ai_chat::default_provider())
}

/// Dated, still-active tasks the organizer may pin, mirroring `_load_tasks`.
async fn load_organize_tasks(
    state: &AppState,
    user_id: Uuid,
    force: bool,
    list_id: Option<Uuid>,
) -> Result<Vec<Task>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let mut sql = format!(
        "SELECT {COLUMNS} FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND is_archived = false AND status <> 'cancelled' \
         AND (start_date IS NOT NULL OR due_date IS NOT NULL)"
    );
    let mut next = 2;
    if list_id.is_some() {
        sql.push_str(&format!(" AND list_id = ${next}"));
        next += 1;
    }
    // list_id = None organizes EVERY dated task across all lists (the
    // unfiltered timeline scope), not only the no-list tasks.
    if !force {
        sql.push_str(" AND board_section_id IS NULL");
    }
    sql.push_str(&format!(" ORDER BY created_at ASC LIMIT ${next}"));
    let mut query = sqlx::query(&sql).bind(user_id);
    if let Some(id) = list_id {
        query = query.bind(id);
    }
    query = query.bind(ORGANIZE_MAX_TASKS);
    let rows = query.fetch_all(&mut *tx).await.map_err(db_error)?;
    let tasks = rows
        .iter()
        .map(Task::from_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(tasks)
}

/// Existing `kind = "timeline"` sections, mirroring `_existing_timeline_sections`.
async fn load_timeline_sections(
    state: &AppState,
    user_id: Uuid,
    list_id: Option<Uuid>,
) -> Result<Vec<TimelineSection>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let sql = if list_id.is_none() {
        "SELECT id, title FROM board_sections WHERE user_id = $1 AND kind = 'timeline' \
         AND list_id IS NULL ORDER BY position, created_at"
    } else {
        "SELECT id, title FROM board_sections WHERE user_id = $1 AND kind = 'timeline' \
         AND list_id = $2 ORDER BY position, created_at"
    };
    let mut query = sqlx::query(sql).bind(user_id);
    if let Some(id) = list_id {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&mut *tx).await.map_err(db_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(TimelineSection {
            id: row.try_get("id").map_err(db_error)?,
            title: row.try_get("title").map_err(db_error)?,
        });
    }
    tx.commit().await.map_err(db_error)?;
    Ok(out)
}

/// Count dated active tasks still unpinned, mirroring `_count_remaining`.
async fn count_organize_remaining(
    state: &AppState,
    user_id: Uuid,
    list_id: Option<Uuid>,
) -> Result<i64, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let sql = if list_id.is_none() {
        "SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND is_archived = false AND status <> 'cancelled' \
         AND (start_date IS NOT NULL OR due_date IS NOT NULL) \
         AND board_section_id IS NULL"
    } else {
        "SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND is_archived = false AND status <> 'cancelled' \
         AND (start_date IS NOT NULL OR due_date IS NOT NULL) \
         AND board_section_id IS NULL AND list_id = $2"
    };
    let mut query = sqlx::query_scalar::<_, i64>(sql).bind(user_id);
    if let Some(id) = list_id {
        query = query.bind(id);
    }
    let count = query.fetch_one(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(count)
}

/// Organize the user's dated tasks into timeline topic sections.
pub(crate) async fn svc_organize_timeline(
    state: &AppState,
    user_id: Uuid,
    provider: Option<String>,
    force: bool,
    list_id: Option<Uuid>,
    headers: &HeaderMap,
) -> Result<Value, ApiError> {
    let provider = resolve_organize_provider(state, user_id, provider).await?;
    let (resolved_provider, api_key_value, chain) =
        ai_chat::resolve_llm_key(state, user_id, &provider, headers).await?;
    let client = ai_chat::build_llm_client(state, &resolved_provider, &api_key_value, chain)?;

    let tasks = load_organize_tasks(state, user_id, force, list_id).await?;
    if tasks.is_empty() {
        return Ok(json!({
            "sections_created": 0,
            "tasks_assigned": 0,
            "topics": Vec::<String>::new(),
            "skipped": true,
            "remaining": 0,
            "message": "There are no dated tasks to organize yet.",
        }));
    }

    let sections = load_timeline_sections(state, user_id, list_id).await?;
    let mut by_title: HashMap<String, Uuid> = HashMap::new();
    let mut topic_case: HashMap<String, String> = HashMap::new();
    let mut existing_topics: Vec<String> = Vec::new();
    for section in &sections {
        by_title.insert(section.title.to_lowercase(), section.id);
        topic_case
            .entry(section.title.to_lowercase())
            .or_insert_with(|| section.title.clone());
        if !existing_topics.contains(&section.title) {
            existing_topics.push(section.title.clone());
        }
    }

    let mut assignments: HashMap<String, String> = HashMap::new();
    let mut failed_batches = 0usize;
    for batch in tasks.chunks(ORGANIZE_BATCH_SIZE) {
        let messages = json!([{ "role": "user", "content": topic_prompt(&existing_topics, batch) }]);
        let mut response: Option<Value> = None;
        for attempt in 0..3u64 {
            match client
                .chat(&messages, None, Some(0.2), Some(ORGANIZE_MAX_OUTPUT_TOKENS))
                .await
            {
                Ok(value) => {
                    response = Some(value);
                    break;
                }
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(2 * (attempt + 1))).await;
                }
            }
        }
        let Some(response) = response else {
            failed_batches += 1;
            continue;
        };
        let message = LlmClient::first_choice(&response)
            .get("message")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut content = message
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if content.trim().is_empty() {
            content = message
                .get("reasoning")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
        let parsed = parse_assignments(&content);
        if parsed.is_empty() {
            failed_batches += 1;
            continue;
        }
        for task in batch {
            if let Some(raw) = parsed.get(&task.id.to_string()) {
                let topic = normalize_topic(raw);
                let canonical = topic_case
                    .entry(topic.to_lowercase())
                    .or_insert_with(|| topic.clone())
                    .clone();
                assignments.insert(task.id.to_string(), canonical.clone());
                if !existing_topics.contains(&canonical) {
                    existing_topics.push(canonical);
                }
            }
        }
    }

    if assignments.is_empty() {
        if failed_batches > 0 {
            return Err(ApiError::BadGateway(
                "Auto-sort could not reach the AI provider. Please try again.".to_string(),
            ));
        }
        let remaining = count_organize_remaining(state, user_id, list_id).await?;
        let message = if remaining > 0 {
            format!("Nothing new to sort right now; {remaining} dated task(s) are still unsorted.")
        } else {
            "Everything dated is already sorted.".to_string()
        };
        return Ok(json!({
            "sections_created": 0,
            "tasks_assigned": 0,
            "topics": Vec::<String>::new(),
            "skipped": true,
            "remaining": remaining,
            "message": message,
        }));
    }

    // Clamp to at most ORGANIZE_MAX_TOPICS, folding the tail into "Other".
    let mut counts: HashMap<String, i64> = HashMap::new();
    for topic in assignments.values() {
        *counts.entry(topic.clone()).or_insert(0) += 1;
    }
    if counts.len() > ORGANIZE_MAX_TOPICS {
        let mut entries: Vec<(String, i64)> = counts.into_iter().collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let keep: HashSet<String> = entries
            .iter()
            .take(ORGANIZE_MAX_TOPICS - 1)
            .map(|e| e.0.clone())
            .collect();
        let mut folded: HashMap<String, i64> = HashMap::new();
        let mut other = 0i64;
        for (topic, count) in entries {
            if keep.contains(&topic) {
                folded.insert(topic, count);
            } else {
                other += count;
            }
        }
        if other > 0 {
            folded.insert("Other".to_string(), other);
        }
        for topic in assignments.values_mut() {
            if !keep.contains(topic) {
                *topic = "Other".to_string();
            }
        }
        counts = folded;
    }

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let mut next_pos = next_position(&mut *tx, user_id, SECTION_KIND_TIMELINE, list_id)
        .await
        .map_err(db_error)?;
    let mut topics_sorted: Vec<String> = counts.keys().cloned().collect();
    topics_sorted.sort();
    let mut created = 0i64;
    for (index, topic) in topics_sorted.iter().enumerate() {
        if by_title.contains_key(&topic.to_lowercase()) {
            continue;
        }
        let color = TOPIC_COLORS[index % TOPIC_COLORS.len()];
        let row = sqlx::query(
            "INSERT INTO board_sections (user_id, kind, list_id, title, color, status, position) \
             VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING id",
        )
        .bind(user_id)
        .bind(SECTION_KIND_TIMELINE)
        .bind(list_id)
        .bind(topic)
        .bind(color)
        .bind(next_pos)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
        let section_id: Uuid = row.try_get("id").map_err(db_error)?;
        by_title.insert(topic.to_lowercase(), section_id);
        next_pos += 1;
        created += 1;
    }
    let mut assigned = 0i64;
    for task in &tasks {
        let Some(topic) = assignments.get(&task.id.to_string()) else {
            continue;
        };
        let Some(section_id) = by_title.get(&topic.to_lowercase()) else {
            continue;
        };
        let result =
            sqlx::query("UPDATE tasks SET board_section_id = $1 WHERE id = $2 AND user_id = $3")
                .bind(section_id)
                .bind(task.id)
                .bind(user_id)
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
        if result.rows_affected() > 0 {
            assigned += 1;
        }
    }
    tx.commit().await.map_err(db_error)?;

    let remaining = count_organize_remaining(state, user_id, list_id).await?;
    let message = if remaining > 0 {
        format!(
            "Grouped {assigned} task(s) into {created} new section(s). {remaining} dated task(s) are still unsorted; run organize again to continue."
        )
    } else {
        format!("Grouped {assigned} task(s) into {created} new section(s). Everything dated is now sorted.")
    };
    Ok(json!({
        "sections_created": created,
        "tasks_assigned": assigned,
        "topics": topics_sorted,
        "skipped": false,
        "remaining": remaining,
        "message": message,
    }))
}

async fn auto_organize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AutoOrganizeRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let used = organize_limiter()
        .count(&format!("organize:{}", user.user_id), Duration::from_secs(3600))
        .await;
    if used >= ORGANIZE_MAX_PER_HOUR {
        return Err(ApiError::TooManyRequests(
            "Auto-sort was used too many times in the last hour. Try again later.".to_string(),
        ));
    }
    let list_id = parse_list_id(req.list_id.as_deref())?;
    let result = svc_organize_timeline(
        &state,
        user.user_id,
        req.provider,
        req.force,
        list_id,
        &headers,
    )
    .await?;
    invalidate_sections(&state, user.user_id).await;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let settings = config::Settings {
            database_url: url,
            jwt_secret_key: "test-secret-key-that-is-at-least-32-chars!".to_string(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".to_string(),
            app_origin: "http://localhost:3000".to_string(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".to_string(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: "http://localhost:3000/api/auth/oauth/google/callback".to_string(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: false,
            csrf_allowed_origins: "http://localhost:3000".to_string(),
            api_rate_limit_enabled: false,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".to_string(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: "mailto:support@prysmnote.com".to_string(),
            notify_email: String::new(),
            notification_loop_interval: 1800,
            digest_hour: 7,
        };
        Some(AppState::lazy(settings))
    }

    async fn call(
        app: Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        let request = builder
            .body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty))
            .unwrap();
        app.oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn kanban_seeds_once_then_stays_empty() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-sections-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();
        let app = router().with_state(state.clone());

        // first load seeds 4 kanban sections
        let res = call(app.clone(), "GET", "/api/board-sections?kind=kanban", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let sections = body_json(res).await;
        assert_eq!(sections.as_array().unwrap().len(), 4);

        // timeline never seeds
        let res = call(app.clone(), "GET", "/api/board-sections?kind=timeline", &token, None).await;
        assert!(body_json(res).await.as_array().unwrap().is_empty());

        // delete all kanban sections, then a re-load must stay empty
        for section in sections.as_array().unwrap() {
            let id = section["id"].as_str().unwrap();
            let res = call(
                app.clone(),
                "DELETE",
                &format!("/api/board-sections/{id}"),
                &token,
                None,
            )
            .await;
            assert_eq!(res.status(), StatusCode::OK);
        }
        let res = call(app.clone(), "GET", "/api/board-sections?kind=kanban", &token, None).await;
        assert!(body_json(res).await.as_array().unwrap().is_empty());

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[test]
    fn normalize_topic_title_cases_words() {
        assert_eq!(normalize_topic("home & garden"), "Home Garden");
        assert_eq!(normalize_topic("deep work sessions"), "Deep Work Sessions");
        assert_eq!(normalize_topic("one two three four"), "One Two Three");
    }

    #[test]
    fn normalize_topic_falls_back_to_other() {
        assert_eq!(normalize_topic("!!!"), "Other");
        assert_eq!(normalize_topic(""), "Other");
    }

    #[test]
    fn parse_assignments_reads_object_array() {
        let parsed = parse_assignments(
            r#"[{"id":"a","topic":"Home"},{"task_id":"b","category":"Work"}]"#,
        );
        assert_eq!(parsed.get("a").map(String::as_str), Some("Home"));
        assert_eq!(parsed.get("b").map(String::as_str), Some("Work"));
    }

    #[test]
    fn parse_assignments_reads_fenced_json() {
        let parsed =
            parse_assignments("```json\n[{\"id\": \"x\", \"topic\": \"Errands\"}]\n```");
        assert_eq!(parsed.get("x").map(String::as_str), Some("Errands"));
    }

    #[test]
    fn parse_assignments_falls_back_to_string_scan() {
        let parsed = parse_assignments("sure: \"id\": \"y\", \"topic\": \"Chores\", thanks");
        assert_eq!(parsed.get("y").map(String::as_str), Some("Chores"));
    }
}
