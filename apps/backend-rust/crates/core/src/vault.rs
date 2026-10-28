//! Vault: markdown notes with wikilinks, tags, revisions and recall.
//!
//! The engine is **core**, so a self-hosted (community) instance gets the whole
//! feature for free. The hosted build installs a [`VaultEntitlement`] provider,
//! which turns every route and the AI tools into a Premium surface with a clear
//! upsell instead of a silent failure. Semantic search reuses the user's BYOK
//! embedding key through [`crate::embedding`]; it is best effort and always
//! degrades to full-text search.
//!
//! Everything is bounded: note/template counts, body size, tag and alias counts,
//! chunk count and result limit. Writes schedule the embedding off the request
//! path, so a slow provider never inflates latency.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::db;
use crate::error::ApiError;
use crate::AppState;

/// Per-user caps. Large enough for a serious vault, small enough that one
/// account cannot fill the VM.
const MAX_NOTES: i64 = 5000;
const MAX_TEMPLATES: i64 = 50;
const MAX_REVISIONS: i64 = 20;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 200_000;
const MAX_TAGS: usize = 64;
const MAX_ALIASES: usize = 32;
const MAX_LINKS: usize = 250;
const MAX_CHUNKS: usize = 24;
const CHUNK_CHARS: usize = 1200;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

const PREMIUM_MESSAGE: &str = "Vault is a Premium feature on this hosted instance. Self-hosting Prysm Note includes it for free, or upgrade to Premium to keep using it here.";

// ---------------------------------------------------------------------------
// Entitlement hook (core never depends on ee)
// ---------------------------------------------------------------------------

/// Premium check installed by the private build. Community registers none, so
/// the Vault is available to every self-hosted user.
pub trait VaultEntitlement: Send + Sync {
    fn is_premium<'a>(
        &'a self,
        pool: &'a PgPool,
        user_id: Uuid,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

static ENTITLEMENT: OnceLock<Box<dyn VaultEntitlement>> = OnceLock::new();

/// Install the Premium entitlement check (called once by the private build).
pub fn register_entitlement(entitlement: Box<dyn VaultEntitlement>) {
    let _ = ENTITLEMENT.set(entitlement);
}

/// Whether the Vault is gated on this build (hosted). Community: never.
pub fn is_gated() -> bool {
    ENTITLEMENT.get().is_some()
}

/// Whether this user may use the Vault. Community always can.
pub async fn allowed(pool: &PgPool, user_id: Uuid) -> bool {
    match ENTITLEMENT.get() {
        Some(entry) => entry.is_premium(pool, user_id).await,
        None => true,
    }
}

async fn require_premium(state: &AppState, user_id: Uuid) -> Result<(), ApiError> {
    if allowed(&state.pool, user_id).await {
        Ok(())
    } else {
        Err(ApiError::PaymentRequired(PREMIUM_MESSAGE.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/vault/notes", get(list_notes).post(create_note))
        .route("/api/vault/notes/", get(list_notes).post(create_note))
        .route(
            "/api/vault/notes/{note_id}",
            get(get_note).patch(update_note).delete(delete_note),
        )
        .route("/api/vault/notes/{note_id}/append", post(append_note))
        .route("/api/vault/notes/{note_id}/backlinks", get(note_backlinks))
        .route(
            "/api/vault/notes/{note_id}/revisions",
            get(list_revisions),
        )
        .route(
            "/api/vault/notes/{note_id}/revisions/{revision_id}/restore",
            post(restore_revision),
        )
        .route("/api/vault/search", get(search_notes))
        .route("/api/vault/backlinks", get(backlinks_by_title))
        .route("/api/vault/graph", get(graph))
        .route("/api/vault/tags", get(list_tags))
        .route("/api/vault/stats", get(stats))
        .route("/api/vault/capture", post(capture))
        .route("/api/vault/templates", get(list_templates).post(create_template))
        .route(
            "/api/vault/templates/{template_id}",
            axum::routing::delete(delete_template),
        )
        .route("/api/vault/export", get(export_bundle))
        .route("/api/vault/import", post(import_bundle))
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CreatePayload {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    pinned: bool,
}

#[derive(Deserialize)]
struct UpdatePayload {
    title: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    aliases: Option<Vec<String>>,
    folder: Option<String>,
    pinned: Option<bool>,
}

#[derive(Deserialize)]
struct AppendPayload {
    text: String,
    #[serde(default)]
    heading: Option<String>,
}

#[derive(Deserialize)]
struct CapturePayload {
    #[serde(default)]
    title: Option<String>,
    text: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
    tag: Option<String>,
    folder: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    mode: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct BacklinkQuery {
    title: Option<String>,
    note_id: Option<String>,
}

#[derive(Deserialize)]
struct TemplatePayload {
    name: String,
    #[serde(default)]
    body: String,
}

#[derive(Deserialize)]
struct ImportPayload {
    notes: Vec<ImportNote>,
}

#[derive(Deserialize)]
struct ImportNote {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    folder: String,
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(err.to_string())
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn parse_id(raw: &str, field: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::Unprocessable(format!("{field} must be a uuid")))
}

fn clean_title(raw: &str) -> Result<String, ApiError> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(ApiError::Unprocessable("title is required".to_string()));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(ApiError::Unprocessable(format!(
            "title must be at most {MAX_TITLE_CHARS} characters"
        )));
    }
    Ok(title.to_string())
}

fn clean_body(raw: &str) -> Result<String, ApiError> {
    if raw.chars().count() > MAX_BODY_CHARS {
        return Err(ApiError::PayloadTooLarge(format!(
            "body must be at most {MAX_BODY_CHARS} characters"
        )));
    }
    Ok(raw.replace("\r\n", "\n"))
}

fn clean_list(raw: &[String], max: usize, field: &str) -> Result<Vec<String>, ApiError> {
    let mut out: Vec<String> = Vec::new();
    for value in raw {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > 100 {
            return Err(ApiError::Unprocessable(format!(
                "{field} entries must be at most 100 characters"
            )));
        }
        if !out.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed)) {
            out.push(trimmed.to_string());
        }
    }
    if out.len() > max {
        return Err(ApiError::Unprocessable(format!(
            "{field} must have at most {max} entries"
        )));
    }
    Ok(out)
}

fn clamp_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn snippet(body: &str, max: usize) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(max).collect();
    if flat.chars().count() > max {
        out.push_str("...");
    }
    out
}

static WIKILINK: OnceLock<regex::Regex> = OnceLock::new();

fn wikilink_regex() -> &'static regex::Regex {
    WIKILINK.get_or_init(|| {
        regex::Regex::new(r"\[\[([^\[\]\n]{1,200})\]\]").expect("valid wikilink regex")
    })
}

/// Targets referenced by `[[Target]]` / `[[Target|label]]`, de-duplicated
/// case-insensitively and capped so a huge body cannot explode link rows.
pub fn parse_wikilinks(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for capture in wikilink_regex().captures_iter(body) {
        let inner = capture.get(1).map(|m| m.as_str()).unwrap_or("").trim();
        let target = inner.split('|').next().unwrap_or("").trim();
        let target = target.split('#').next().unwrap_or("").trim();
        if target.is_empty() {
            continue;
        }
        if out.iter().any(|existing| existing.eq_ignore_ascii_case(target)) {
            continue;
        }
        out.push(target.chars().take(MAX_TITLE_CHARS).collect());
        if out.len() >= MAX_LINKS {
            break;
        }
    }
    out
}

fn note_json(row: &sqlx::postgres::PgRow) -> Value {
    let tags: Vec<String> = row.try_get("tags").unwrap_or_default();
    let aliases: Vec<String> = row.try_get("aliases").unwrap_or_default();
    json!({
        "id": row.try_get::<Uuid, _>("id").map(|v| v.to_string()).unwrap_or_default(),
        "title": row.try_get::<String, _>("title").unwrap_or_default(),
        "tags": tags,
        "aliases": aliases,
        "folder": row.try_get::<String, _>("folder").unwrap_or_default(),
        "pinned": row.try_get::<bool, _>("pinned").unwrap_or(false),
        "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
        "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
        "snippet": row
            .try_get::<String, _>("body")
            .map(|body| snippet(&body, 220))
            .unwrap_or_default(),
    })
}

const NOTE_COLUMNS: &str =
    "id, title, body, tags, aliases, folder, pinned, created_at, updated_at";

async fn fetch_note(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    note_id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query(&format!(
        "SELECT {NOTE_COLUMNS} FROM vault_notes WHERE user_id = $1 AND id = $2"
    ))
    .bind(user_id)
    .bind(note_id)
    .fetch_optional(conn)
    .await
}

/// Resolve a user-entered reference (id, exact title, or alias) to a note id.
pub async fn resolve_note(
    state: &AppState,
    user_id: Uuid,
    reference: &str,
) -> Result<Option<Uuid>, ApiError> {
    if let Ok(id) = Uuid::parse_str(reference) {
        let mut tx = state.pool.begin().await.map_err(db_error)?;
        db::set_rls_user(&mut *tx, user_id, "")
            .await
            .map_err(db_error)?;
        let found = fetch_note(&mut *tx, user_id, id).await.map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        if found.is_some() {
            return Ok(Some(id));
        }
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM vault_notes WHERE user_id = $1 \
         AND (lower(title) = lower($2) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower($2))) \
         ORDER BY (lower(title) = lower($2)) DESC, updated_at DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(reference.trim())
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(found)
}

// ---------------------------------------------------------------------------
// Link + revision bookkeeping
// ---------------------------------------------------------------------------

async fn reindex_links(
    tx: &mut sqlx::PgConnection,
    user_id: Uuid,
    note_id: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM vault_links WHERE user_id = $1 AND source_note_id = $2")
        .bind(user_id)
        .bind(note_id)
        .execute(&mut *tx)
        .await?;
    for target in parse_wikilinks(body) {
        let resolved: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM vault_notes WHERE user_id = $1 \
             AND (lower(title) = lower($2) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower($2))) \
             ORDER BY (lower(title) = lower($2)) DESC, updated_at DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(&target)
        .fetch_optional(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO vault_links (user_id, source_note_id, target_title, target_note_id) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(user_id)
        .bind(note_id)
        .bind(&target)
        .bind(resolved)
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

/// Keep the last [`MAX_REVISIONS`] snapshots of a note. Called before a write
/// that replaces the body, so history is never the current state.
async fn snapshot_revision(
    tx: &mut sqlx::PgConnection,
    user_id: Uuid,
    note_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO vault_revisions (user_id, note_id, title, body, tags, aliases) \
         SELECT user_id, id, title, body, tags, aliases FROM vault_notes \
         WHERE user_id = $1 AND id = $2",
    )
    .bind(user_id)
    .bind(note_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM vault_revisions WHERE user_id = $1 AND note_id = $2 AND id NOT IN (\
             SELECT id FROM vault_revisions WHERE user_id = $1 AND note_id = $2 \
             ORDER BY created_at DESC LIMIT $3\
         )",
    )
    .bind(user_id)
    .bind(note_id)
    .bind(MAX_REVISIONS)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Embeddings (best effort, off the request path)
// ---------------------------------------------------------------------------

fn vector_literal(values: &[f32]) -> String {
    let mut out = String::from("[");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

fn chunk_text(title: &str, body: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for paragraph in body.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        if current.chars().count() + paragraph.chars().count() + 2 > CHUNK_CHARS {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            if paragraph.chars().count() > CHUNK_CHARS {
                // A single huge paragraph is split on character boundaries so
                // the provider never receives an unbounded chunk.
                let chars: Vec<char> = paragraph.chars().collect();
                for piece in chars.chunks(CHUNK_CHARS) {
                    chunks.push(piece.iter().collect());
                    if chunks.len() >= MAX_CHUNKS {
                        break;
                    }
                }
                continue;
            }
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph);
        if chunks.len() >= MAX_CHUNKS {
            break;
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(snippet(title, CHUNK_CHARS));
    }
    chunks.truncate(MAX_CHUNKS);
    chunks
}

fn spawn_embedding(
    pool: PgPool,
    encryption_key: String,
    user_id: Uuid,
    note_id: Uuid,
    title: String,
    body: String,
) {
    tokio::spawn(async move {
        let _ = embed_note(&pool, &encryption_key, user_id, note_id, &title, &body).await;
    });
}

async fn embed_note(
    pool: &PgPool,
    encryption_key: &str,
    user_id: Uuid,
    note_id: Uuid,
    title: &str,
    body: &str,
) -> Result<(), sqlx::Error> {
    let Some(client) = crate::embedding::client_for_user(pool, encryption_key, user_id).await
    else {
        return Ok(());
    };
    let chunks = chunk_text(title, body);
    let mut stored: Vec<(i32, String, Vec<f32>)> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let input = format!("{title}\n\n{chunk}");
        match client.embed(&input).await {
            Ok(values) if !values.is_empty() => {
                stored.push((index as i32, chunk.clone(), values));
            }
            _ => break,
        }
    }
    let mut tx = pool.begin().await?;
    db::set_rls_user(&mut *tx, user_id, "").await?;
    sqlx::query("DELETE FROM vault_chunks WHERE user_id = $1 AND note_id = $2")
        .bind(user_id)
        .bind(note_id)
        .execute(&mut *tx)
        .await?;
    for (index, content, values) in stored {
        sqlx::query(
            "INSERT INTO vault_chunks (user_id, note_id, chunk_index, content, embedding) \
             VALUES ($1, $2, $3, $4, $5::vector)",
        )
        .bind(user_id)
        .bind(note_id)
        .bind(index)
        .bind(content)
        .bind(vector_literal(&values))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

// ---------------------------------------------------------------------------
// Service layer (shared by REST, MCP and the in-app agent)
// ---------------------------------------------------------------------------

pub async fn svc_list(
    state: &AppState,
    user_id: Uuid,
    tag: Option<&str>,
    folder: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(&format!(
        "SELECT {NOTE_COLUMNS} FROM vault_notes WHERE user_id = $1 \
         AND ($2::text IS NULL OR $2 = ANY(tags)) \
         AND ($3::text IS NULL OR folder = $3) \
         ORDER BY pinned DESC, updated_at DESC LIMIT $4 OFFSET $5"
    ))
    .bind(user_id)
    .bind(tag.filter(|value| !value.is_empty()))
    .bind(folder.filter(|value| !value.is_empty()))
    .bind(clamp_limit(Some(limit.max(1))))
    .bind(offset.max(0))
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_notes WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let notes: Vec<Value> = rows.iter().map(note_json).collect();
    Ok(json!({ "notes": notes, "count": notes.len(), "total": total }))
}

pub async fn svc_get(state: &AppState, user_id: Uuid, note_id: Uuid) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let Some(row) = fetch_note(&mut *tx, user_id, note_id).await.map_err(db_error)? else {
        return Err(ApiError::NotFound("Note not found".to_string()));
    };
    let mut payload = note_json(&row);
    payload["body"] = json!(row.try_get::<String, _>("body").unwrap_or_default());

    let backlinks = sqlx::query(
        "SELECT DISTINCT n.id, n.title FROM vault_links l \
         JOIN vault_notes n ON n.id = l.source_note_id \
         WHERE l.user_id = $1 AND l.target_note_id = $2 ORDER BY n.title",
    )
    .bind(user_id)
    .bind(note_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    payload["backlinks"] = Value::Array(
        backlinks
            .iter()
            .map(|link| {
                json!({
                    "id": link.try_get::<Uuid, _>("id").map(|v| v.to_string()).unwrap_or_default(),
                    "title": link.try_get::<String, _>("title").unwrap_or_default(),
                })
            })
            .collect(),
    );

    let outgoing = sqlx::query(
        "SELECT target_title, target_note_id FROM vault_links \
         WHERE user_id = $1 AND source_note_id = $2 ORDER BY target_title",
    )
    .bind(user_id)
    .bind(note_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    payload["links"] = Value::Array(
        outgoing
            .iter()
            .map(|link| {
                json!({
                    "title": link.try_get::<String, _>("target_title").unwrap_or_default(),
                    "note_id": link.try_get::<Option<Uuid>, _>("target_note_id").ok().flatten().map(|v| v.to_string()),
                })
            })
            .collect(),
    );

    let revisions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_revisions WHERE user_id = $1 AND note_id = $2",
    )
    .bind(user_id)
    .bind(note_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    payload["revision_count"] = json!(revisions);
    tx.commit().await.map_err(db_error)?;
    Ok(payload)
}

/// Insert a note on an existing (already RLS-scoped) connection. Shared by the
/// REST/AI path and the OpenClaw mailbox, which both need the same validation,
/// caps and link indexing.
pub async fn insert_note(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    title: &str,
    body: &str,
    tags: Vec<String>,
    aliases: Vec<String>,
    folder: &str,
    pinned: bool,
) -> Result<Uuid, ApiError> {
    let title = clean_title(title)?;
    let body = clean_body(body)?;
    let tags = clean_list(&tags, MAX_TAGS, "tags")?;
    let aliases = clean_list(&aliases, MAX_ALIASES, "aliases")?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_notes WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db_error)?;
    if count >= MAX_NOTES {
        return Err(ApiError::Conflict(format!(
            "Vault is full ({MAX_NOTES} notes). Delete a note or export the vault first."
        )));
    }
    let note_id: Uuid = sqlx::query_scalar(
        "INSERT INTO vault_notes (user_id, title, body, tags, aliases, folder, pinned) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&body)
    .bind(&tags)
    .bind(&aliases)
    .bind(folder.trim())
    .bind(pinned)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_error)?;
    reindex_links(conn, user_id, note_id, &body)
        .await
        .map_err(db_error)?;
    Ok(note_id)
}

pub async fn svc_create(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    body: &str,
    tags: Vec<String>,
    aliases: Vec<String>,
    folder: &str,
    pinned: bool,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let note_id = insert_note(
        &mut tx, user_id, title, body, tags, aliases, folder, pinned,
    )
    .await?;
    tx.commit().await.map_err(db_error)?;

    spawn_embedding(
        state.pool.clone(),
        state.settings.encryption_key.clone(),
        user_id,
        note_id,
        title.trim().to_string(),
        clean_body(body).unwrap_or_default(),
    );
    svc_get(state, user_id, note_id).await
}

pub async fn svc_update(
    state: &AppState,
    user_id: Uuid,
    note_id: Uuid,
    title: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    aliases: Option<Vec<String>>,
    folder: Option<String>,
    pinned: Option<bool>,
) -> Result<Value, ApiError> {
    let title = match title {
        Some(value) => Some(clean_title(&value)?),
        None => None,
    };
    let body = match body {
        Some(value) => Some(clean_body(&value)?),
        None => None,
    };
    let tags = match tags {
        Some(value) => Some(clean_list(&value, MAX_TAGS, "tags")?),
        None => None,
    };
    let aliases = match aliases {
        Some(value) => Some(clean_list(&value, MAX_ALIASES, "aliases")?),
        None => None,
    };

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let Some(row) = fetch_note(&mut *tx, user_id, note_id).await.map_err(db_error)? else {
        return Err(ApiError::NotFound("Note not found".to_string()));
    };
    snapshot_revision(&mut tx, user_id, note_id)
        .await
        .map_err(db_error)?;

    let next_title = title.unwrap_or_else(|| row.try_get("title").unwrap_or_default());
    let next_body = body.unwrap_or_else(|| row.try_get("body").unwrap_or_default());
    let next_tags: Vec<String> = tags.unwrap_or_else(|| row.try_get("tags").unwrap_or_default());
    let next_aliases: Vec<String> = aliases.unwrap_or_else(|| row.try_get("aliases").unwrap_or_default());
    let next_folder = folder.unwrap_or_else(|| row.try_get("folder").unwrap_or_default());
    let next_pinned = pinned.unwrap_or_else(|| row.try_get("pinned").unwrap_or(false));

    sqlx::query(
        "UPDATE vault_notes SET title = $3, body = $4, tags = $5, aliases = $6, \
         folder = $7, pinned = $8, updated_at = now() WHERE user_id = $1 AND id = $2",
    )
    .bind(user_id)
    .bind(note_id)
    .bind(&next_title)
    .bind(&next_body)
    .bind(&next_tags)
    .bind(&next_aliases)
    .bind(next_folder.trim())
    .bind(next_pinned)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    reindex_links(&mut tx, user_id, note_id, &next_body)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    spawn_embedding(
        state.pool.clone(),
        state.settings.encryption_key.clone(),
        user_id,
        note_id,
        next_title,
        next_body,
    );
    svc_get(state, user_id, note_id).await
}

pub async fn svc_append(
    state: &AppState,
    user_id: Uuid,
    note_id: Uuid,
    text: &str,
    heading: Option<&str>,
) -> Result<Value, ApiError> {
    let text = clean_body(text)?;
    if text.trim().is_empty() {
        return Err(ApiError::Unprocessable("text is required".to_string()));
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let Some(row) = fetch_note(&mut *tx, user_id, note_id).await.map_err(db_error)? else {
        return Err(ApiError::NotFound("Note not found".to_string()));
    };
    snapshot_revision(&mut tx, user_id, note_id)
        .await
        .map_err(db_error)?;
    let existing: String = row.try_get("body").unwrap_or_default();
    let mut next = existing.trim_end().to_string();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    if let Some(heading) = heading.map(str::trim).filter(|value| !value.is_empty()) {
        next.push_str(&format!("## {}\n\n", heading.chars().take(120).collect::<String>()));
    }
    next.push_str(text.trim());
    if next.chars().count() > MAX_BODY_CHARS {
        return Err(ApiError::PayloadTooLarge(format!(
            "body must be at most {MAX_BODY_CHARS} characters"
        )));
    }
    let title: String = row.try_get("title").unwrap_or_default();
    sqlx::query("UPDATE vault_notes SET body = $3, updated_at = now() WHERE user_id = $1 AND id = $2")
        .bind(user_id)
        .bind(note_id)
        .bind(&next)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    reindex_links(&mut tx, user_id, note_id, &next)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    spawn_embedding(
        state.pool.clone(),
        state.settings.encryption_key.clone(),
        user_id,
        note_id,
        title,
        next,
    );
    svc_get(state, user_id, note_id).await
}

pub async fn svc_delete(state: &AppState, user_id: Uuid, note_id: Uuid) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let exists = fetch_note(&mut *tx, user_id, note_id).await.map_err(db_error)?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Note not found".to_string()));
    }
    for table in ["vault_links", "vault_revisions", "vault_chunks"] {
        let sql = format!("DELETE FROM {table} WHERE user_id = $1 AND note_id = $2");
        // `vault_links` keys the source note, not `note_id`.
        let sql = if table == "vault_links" {
            "DELETE FROM vault_links WHERE user_id = $1 AND source_note_id = $2".to_string()
        } else {
            sql
        };
        sqlx::query(&sql)
            .bind(user_id)
            .bind(note_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    sqlx::query("UPDATE vault_links SET target_note_id = NULL WHERE user_id = $1 AND target_note_id = $2")
        .bind(user_id)
        .bind(note_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("DELETE FROM vault_notes WHERE user_id = $1 AND id = $2")
        .bind(user_id)
        .bind(note_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(json!({ "deleted": true, "note_id": note_id.to_string() }))
}

pub async fn svc_search(
    state: &AppState,
    user_id: Uuid,
    query: &str,
    mode: &str,
    limit: i64,
) -> Result<Value, ApiError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(json!({ "mode": mode, "results": [], "count": 0 }));
    }
    let limit = clamp_limit(Some(limit));

    if mode.eq_ignore_ascii_case("semantic") {
        if let Some(results) = semantic_search(state, user_id, query, limit).await? {
            let count = results.len();
            return Ok(json!({ "mode": "semantic", "results": results, "count": count }));
        }
    }

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT id, title, body, tags, folder, pinned, created_at, updated_at, \
                ts_headline('english', body, websearch_to_tsquery('english', $2), \
                    'MaxFragments=1,MaxWords=30,MinWords=8') AS hit, \
                ts_rank(search, websearch_to_tsquery('english', $2)) AS score \
         FROM vault_notes WHERE user_id = $1 AND search @@ websearch_to_tsquery('english', $2) \
         ORDER BY score DESC, updated_at DESC LIMIT $3",
    )
    .bind(user_id)
    .bind(query)
    .bind(limit)
    .fetch_all(&mut *tx)
    .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => {
            // Portable fallback: a malformed query (or a database without the
            // English text-search config) still gets substring results.
            let pattern = format!("%{query}%");
            sqlx::query(&format!(
                "SELECT {NOTE_COLUMNS} FROM vault_notes WHERE user_id = $1 \
                 AND (title ILIKE $2 OR body ILIKE $2) \
                 ORDER BY updated_at DESC LIMIT $3"
            ))
            .bind(user_id)
            .bind(pattern)
            .bind(limit)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?
        }
    };
    tx.commit().await.map_err(db_error)?;

    let results: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut payload = note_json(row);
            if let Ok(hit) = row.try_get::<String, _>("hit") {
                if !hit.is_empty() {
                    payload["snippet"] = json!(snippet(&hit.replace(['<', '>'], ""), 260));
                }
            }
            if let Ok(score) = row.try_get::<f32, _>("score") {
                payload["score"] = json!(score);
            }
            payload
        })
        .collect();
    Ok(json!({ "mode": "text", "results": results, "count": results.len() }))
}

async fn semantic_search(
    state: &AppState,
    user_id: Uuid,
    query: &str,
    limit: i64,
) -> Result<Option<Vec<Value>>, ApiError> {
    let Some(client) = crate::embedding::client_for_user(
        &state.pool,
        &state.settings.encryption_key,
        user_id,
    )
    .await
    else {
        return Ok(None);
    };
    let Ok(values) = client.embed(query).await else {
        return Ok(None);
    };
    if values.is_empty() {
        return Ok(None);
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT n.id, n.title, n.body, n.tags, n.aliases, n.folder, n.pinned, \
                n.created_at, n.updated_at, c.content, (1 - (c.embedding <=> $2::vector)) AS score \
         FROM vault_chunks c JOIN vault_notes n ON n.id = c.note_id \
         WHERE c.user_id = $1 AND c.embedding IS NOT NULL \
         ORDER BY c.embedding <=> $2::vector LIMIT $3",
    )
    .bind(user_id)
    .bind(vector_literal(&values))
    .bind(limit * 3)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let mut seen: Vec<Uuid> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    for row in &rows {
        let Ok(note_id) = row.try_get::<Uuid, _>("id") else {
            continue;
        };
        if seen.contains(&note_id) {
            continue;
        }
        seen.push(note_id);
        let mut payload = note_json(row);
        if let Ok(content) = row.try_get::<String, _>("content") {
            payload["snippet"] = json!(snippet(&content, 260));
        }
        if let Ok(score) = row.try_get::<f64, _>("score") {
            payload["score"] = json!(score);
        }
        results.push(payload);
        if results.len() as i64 >= limit {
            break;
        }
    }
    Ok(Some(results))
}

pub async fn svc_backlinks(
    state: &AppState,
    user_id: Uuid,
    reference: &str,
) -> Result<Value, ApiError> {
    let Some(note_id) = resolve_note(state, user_id, reference).await? else {
        return Ok(json!({ "note_id": Value::Null, "backlinks": [], "count": 0 }));
    };
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT DISTINCT n.id, n.title, n.updated_at FROM vault_links l \
         JOIN vault_notes n ON n.id = l.source_note_id \
         WHERE l.user_id = $1 AND l.target_note_id = $2 ORDER BY n.updated_at DESC LIMIT 200",
    )
    .bind(user_id)
    .bind(note_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.try_get::<Uuid, _>("id").map(|v| v.to_string()).unwrap_or_default(),
                "title": row.try_get::<String, _>("title").unwrap_or_default(),
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();
    Ok(json!({ "note_id": note_id.to_string(), "backlinks": items, "count": items.len() }))
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

async fn list_notes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    if let Some(q) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        // A query on the list route is a search, so a UI that sends `?q=` gets
        // ranked results instead of a silent full list.
        let found = svc_search(
            &state,
            user.user_id,
            q,
            "text",
            clamp_limit(query.limit),
        )
        .await?;
        return Ok(Json(json!({
            "notes": found.get("results").cloned().unwrap_or_else(|| json!([])),
            "count": found.get("count").cloned().unwrap_or_else(|| json!(0)),
            "total": found.get("count").cloned().unwrap_or_else(|| json!(0)),
        })));
    }
    let payload = svc_list(
        &state,
        user.user_id,
        query.tag.as_deref(),
        query.folder.as_deref(),
        clamp_limit(query.limit),
        query.offset.unwrap_or(0),
    )
    .await?;
    Ok(Json(payload))
}

async fn get_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let id = parse_id(&note_id, "note_id")?;
    Ok(Json(svc_get(&state, user.user_id, id).await?))
}

async fn create_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreatePayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    Ok(Json(
        svc_create(
            &state,
            user.user_id,
            &payload.title,
            &payload.body,
            payload.tags,
            payload.aliases,
            &payload.folder,
            payload.pinned,
        )
        .await?,
    ))
}

async fn update_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
    Json(payload): Json<UpdatePayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let id = parse_id(&note_id, "note_id")?;
    Ok(Json(
        svc_update(
            &state,
            user.user_id,
            id,
            payload.title,
            payload.body,
            payload.tags,
            payload.aliases,
            payload.folder,
            payload.pinned,
        )
        .await?,
    ))
}

async fn append_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
    Json(payload): Json<AppendPayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let id = parse_id(&note_id, "note_id")?;
    Ok(Json(
        svc_append(&state, user.user_id, id, &payload.text, payload.heading.as_deref()).await?,
    ))
}

async fn delete_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let id = parse_id(&note_id, "note_id")?;
    Ok(Json(svc_delete(&state, user.user_id, id).await?))
}

async fn search_notes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let q = query.q.unwrap_or_default();
    let mode = query.mode.unwrap_or_else(|| "text".to_string());
    Ok(Json(
        svc_search(&state, user.user_id, &q, &mode, clamp_limit(query.limit)).await?,
    ))
}

async fn backlinks_by_title(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BacklinkQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let reference = query
        .note_id
        .or(query.title)
        .ok_or_else(|| ApiError::Unprocessable("title or note_id is required".to_string()))?;
    Ok(Json(svc_backlinks(&state, user.user_id, &reference).await?))
}

async fn note_backlinks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    Ok(Json(svc_backlinks(&state, user.user_id, &note_id).await?))
}

async fn capture(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CapturePayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let text = clean_body(&payload.text)?;
    if text.trim().is_empty() {
        return Err(ApiError::Unprocessable("text is required".to_string()));
    }
    let title = payload
        .title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| snippet(&text, 80));
    Ok(Json(
        svc_create(
            &state,
            user.user_id,
            &title,
            &text,
            payload.tags,
            Vec::new(),
            "",
            false,
        )
        .await?,
    ))
}

async fn list_revisions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let id = parse_id(&note_id, "note_id")?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT id, title, body, tags, created_at FROM vault_revisions \
         WHERE user_id = $1 AND note_id = $2 ORDER BY created_at DESC LIMIT $3",
    )
    .bind(user.user_id)
    .bind(id)
    .bind(MAX_REVISIONS)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.try_get::<Uuid, _>("id").map(|v| v.to_string()).unwrap_or_default(),
                "title": row.try_get::<String, _>("title").unwrap_or_default(),
                "body": row.try_get::<String, _>("body").unwrap_or_default(),
                "tags": row.try_get::<Vec<String>, _>("tags").unwrap_or_default(),
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            })
        })
        .collect();
    Ok(Json(json!({ "revisions": items, "count": items.len() })))
}

async fn restore_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((note_id, revision_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let note_id = parse_id(&note_id, "note_id")?;
    let revision_id = parse_id(&revision_id, "revision_id")?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let revision = sqlx::query(
        "SELECT title, body, tags, aliases FROM vault_revisions \
         WHERE user_id = $1 AND note_id = $2 AND id = $3",
    )
    .bind(user.user_id)
    .bind(note_id)
    .bind(revision_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    let Some(revision) = revision else {
        return Err(ApiError::NotFound("Revision not found".to_string()));
    };
    snapshot_revision(&mut tx, user.user_id, note_id)
        .await
        .map_err(db_error)?;
    let title: String = revision.try_get("title").unwrap_or_default();
    let body: String = revision.try_get("body").unwrap_or_default();
    let tags: Vec<String> = revision.try_get("tags").unwrap_or_default();
    let aliases: Vec<String> = revision.try_get("aliases").unwrap_or_default();
    sqlx::query(
        "UPDATE vault_notes SET title = $3, body = $4, tags = $5, aliases = $6, \
         updated_at = now() WHERE user_id = $1 AND id = $2",
    )
    .bind(user.user_id)
    .bind(note_id)
    .bind(&title)
    .bind(&body)
    .bind(&tags)
    .bind(&aliases)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    reindex_links(&mut tx, user.user_id, note_id, &body)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    spawn_embedding(
        state.pool.clone(),
        state.settings.encryption_key.clone(),
        user.user_id,
        note_id,
        title,
        body,
    );
    Ok(Json(svc_get(&state, user.user_id, note_id).await?))
}

async fn graph(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let notes = sqlx::query(
        "SELECT id, title, pinned, updated_at FROM vault_notes WHERE user_id = $1 \
         ORDER BY updated_at DESC LIMIT 2000",
    )
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let links = sqlx::query(
        "SELECT source_note_id, target_note_id, target_title FROM vault_links \
         WHERE user_id = $1 LIMIT 5000",
    )
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let nodes: Vec<Value> = notes
        .iter()
        .map(|row| {
            json!({
                "id": row.try_get::<Uuid, _>("id").map(|v| v.to_string()).unwrap_or_default(),
                "title": row.try_get::<String, _>("title").unwrap_or_default(),
                "pinned": row.try_get::<bool, _>("pinned").unwrap_or(false),
            })
        })
        .collect();
    let edges: Vec<Value> = links
        .iter()
        .map(|row| {
            json!({
                "source": row.try_get::<Uuid, _>("source_note_id").map(|v| v.to_string()).unwrap_or_default(),
                "target": row.try_get::<Option<Uuid>, _>("target_note_id").ok().flatten().map(|v| v.to_string()),
                "target_title": row.try_get::<String, _>("target_title").unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({ "nodes": nodes, "links": edges })))
}

async fn list_tags(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT tag, count(*) AS count FROM vault_notes, unnest(tags) tag \
         WHERE user_id = $1 GROUP BY tag ORDER BY count DESC, tag LIMIT 500",
    )
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "tag": row.try_get::<String, _>("tag").unwrap_or_default(),
                "count": row.try_get::<i64, _>("count").unwrap_or(0),
            })
        })
        .collect();
    Ok(Json(json!({ "tags": items, "count": items.len() })))
}

async fn stats(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let notes: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_notes WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_links WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    let tags: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT tag) FROM vault_notes, unnest(tags) tag WHERE user_id = $1",
    )
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let templates: i64 =
        sqlx::query_scalar("SELECT count(*) FROM vault_templates WHERE user_id = $1")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
    let chunks: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_chunks WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    let last_updated: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT max(updated_at) FROM vault_notes WHERE user_id = $1")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({
        "notes": notes,
        "links": links,
        "tags": tags,
        "templates": templates,
        "embedded_chunks": chunks,
        "last_updated": last_updated,
        "caps": {
            "notes": MAX_NOTES,
            "templates": MAX_TEMPLATES,
            "revisions_per_note": MAX_REVISIONS,
            "body_chars": MAX_BODY_CHARS,
        },
        "semantic_search": chunks > 0,
    })))
}

async fn list_templates(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(
        "SELECT id, name, body, updated_at FROM vault_templates WHERE user_id = $1 \
         ORDER BY name LIMIT $2",
    )
    .bind(user.user_id)
    .bind(MAX_TEMPLATES)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.try_get::<Uuid, _>("id").map(|v| v.to_string()).unwrap_or_default(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "body": row.try_get::<String, _>("body").unwrap_or_default(),
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();
    Ok(Json(json!({ "templates": items, "count": items.len() })))
}

async fn create_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TemplatePayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let name = clean_title(&payload.name)?;
    let body = clean_body(&payload.body)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_templates WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    if count >= MAX_TEMPLATES {
        return Err(ApiError::Conflict(format!(
            "At most {MAX_TEMPLATES} templates are allowed"
        )));
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO vault_templates (user_id, name, body) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user.user_id)
    .bind(&name)
    .bind(&body)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "id": id.to_string(), "name": name, "body": body })))
}

async fn delete_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(template_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let id = parse_id(&template_id, "template_id")?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let affected = sqlx::query("DELETE FROM vault_templates WHERE user_id = $1 AND id = $2")
        .bind(user.user_id)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?
        .rows_affected();
    tx.commit().await.map_err(db_error)?;
    if affected == 0 {
        return Err(ApiError::NotFound("Template not found".to_string()));
    }
    Ok(Json(json!({ "deleted": true })))
}

async fn export_bundle(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let rows = sqlx::query(&format!(
        "SELECT {NOTE_COLUMNS} FROM vault_notes WHERE user_id = $1 ORDER BY title LIMIT $2"
    ))
    .bind(user.user_id)
    .bind(MAX_NOTES)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let notes: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "title": row.try_get::<String, _>("title").unwrap_or_default(),
                "body": row.try_get::<String, _>("body").unwrap_or_default(),
                "tags": row.try_get::<Vec<String>, _>("tags").unwrap_or_default(),
                "aliases": row.try_get::<Vec<String>, _>("aliases").unwrap_or_default(),
                "folder": row.try_get::<String, _>("folder").unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({
        "format": "prysm-vault",
        "version": 1,
        "exported_at": chrono::Utc::now(),
        "notes": notes,
    })))
}

async fn import_bundle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImportPayload>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    require_premium(&state, user.user_id).await?;
    if payload.notes.is_empty() {
        return Err(ApiError::Unprocessable("notes is empty".to_string()));
    }
    if payload.notes.len() as i64 > 500 {
        return Err(ApiError::PayloadTooLarge(
            "Import at most 500 notes per request".to_string(),
        ));
    }
    let mut created = 0usize;
    let mut skipped = 0usize;
    for note in payload.notes.iter().take(500) {
        let tags = clean_list(&note.tags, MAX_TAGS, "tags")?;
        let aliases = clean_list(&note.aliases, MAX_ALIASES, "aliases")?;
        // Import is a restore, not a copy: a note that already exists by title
        // is skipped, so importing the same bundle twice (or importing your own
        // export into a populated vault) never doubles the notebook.
        if title_exists(&state, user.user_id, &note.title).await? {
            skipped += 1;
            continue;
        }
        match svc_create(
            &state,
            user.user_id,
            &note.title,
            &note.body,
            tags,
            aliases,
            &note.folder,
            false,
        )
        .await
        {
            Ok(_) => created += 1,
            Err(ApiError::Conflict(_)) => {
                skipped += 1;
                break;
            }
            Err(_) => skipped += 1,
        }
    }
    Ok(Json(json!({ "created": created, "skipped": skipped })))
}

/// Whether a note with this title already exists for the user (case
/// insensitive). Used by import to stay idempotent.
async fn title_exists(state: &AppState, user_id: Uuid, title: &str) -> Result<bool, ApiError> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(false);
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1::bigint FROM vault_notes WHERE user_id = $1 AND lower(title) = lower($2) LIMIT 1",
    )
    .bind(user_id)
    .bind(title)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(found.is_some())
}

// ---------------------------------------------------------------------------
// AI agent + MCP surfaces
// ---------------------------------------------------------------------------

/// Tool definitions for the in-app agent (premium-gated on hosted).
pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "vault_search",
                "description": "Search the user's Vault notes by text or meaning. Use it whenever the user asks what they wrote down, saved, or noted. mode='semantic' needs the user's own embedding key and falls back to text search.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "mode": { "type": "string", "enum": ["text", "semantic"] },
                        "limit": { "type": "integer" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_get_note",
                "description": "Read one Vault note with its body, outgoing [[links]] and backlinks. Pass note_id or the exact title.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "string" },
                        "title": { "type": "string" }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_create_note",
                "description": "Create a Vault note. Body is markdown; link other notes with [[Note title]].",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "aliases": { "type": "array", "items": { "type": "string" } },
                        "folder": { "type": "string" }
                    },
                    "required": ["title"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_update_note",
                "description": "Update a Vault note's title, body, tags or aliases. Everything is replaced, so read the note first when editing part of it; use vault_append_to_note to add without replacing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "string" },
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "aliases": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["note_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_append_to_note",
                "description": "Append markdown to an existing Vault note without replacing its body. Optional heading adds an '## heading' above the text.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "string" },
                        "text": { "type": "string" },
                        "heading": { "type": "string" }
                    },
                    "required": ["note_id", "text"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_delete_note",
                "description": "Permanently delete a Vault note. DESTRUCTIVE: only call it after the user explicitly confirmed this exact note. Never delete to 'archive'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "string" },
                        "confirm": { "type": "boolean" }
                    },
                    "required": ["note_id", "confirm"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_list_notes",
                "description": "List recent Vault notes, optionally filtered by tag or folder.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tag": { "type": "string" },
                        "folder": { "type": "string" },
                        "limit": { "type": "integer" }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "vault_backlinks",
                "description": "List the notes that link to a given note (its backlinks).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "string" },
                        "title": { "type": "string" }
                    }
                }
            }
        }),
    ]
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|value| value.as_str())
}

fn arg_strings(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(single)) => vec![single.clone()],
        _ => Vec::new(),
    }
}

async fn note_reference(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> Result<Uuid, ApiError> {
    let reference = arg_str(args, "note_id")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| arg_str(args, "title"))
        .ok_or_else(|| ApiError::Unprocessable("note_id or title is required".to_string()))?;
    resolve_note(state, user_id, reference)
        .await?
        .ok_or_else(|| ApiError::NotFound("Note not found".to_string()))
}

/// Dispatch an in-app agent tool. `None` means "not a Vault tool".
pub async fn ai_call(
    state: &AppState,
    user_id: Uuid,
    name: &str,
    args: &Value,
) -> Option<Result<Vec<String>, ApiError>> {
    let is_vault = name.starts_with("vault_");
    if !is_vault {
        return None;
    }
    if !allowed(&state.pool, user_id).await {
        return Some(Err(ApiError::PaymentRequired(PREMIUM_MESSAGE.to_string())));
    }
    let result = match name {
        "vault_search" => {
            let query = arg_str(args, "query").unwrap_or("");
            let mode = arg_str(args, "mode").unwrap_or("text");
            let limit = args
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(10);
            svc_search(state, user_id, query, mode, limit).await.map(|value| {
                json!({
                    "mode": value.get("mode"),
                    "count": value.get("count"),
                    "results": value.get("results"),
                })
            })
        }
        "vault_get_note" => {
            let note_id = note_reference(state, user_id, args).await;
            match note_id {
                Ok(id) => svc_get(state, user_id, id).await,
                Err(err) => Err(err),
            }
        }
        "vault_create_note" => {
            svc_create(
                state,
                user_id,
                arg_str(args, "title").unwrap_or(""),
                arg_str(args, "body").unwrap_or(""),
                arg_strings(args, "tags"),
                arg_strings(args, "aliases"),
                arg_str(args, "folder").unwrap_or(""),
                false,
            )
            .await
        }
        "vault_update_note" => match note_reference(state, user_id, args).await {
            Ok(id) => svc_update(
                state,
                user_id,
                id,
                arg_str(args, "title").map(str::to_string),
                arg_str(args, "body").map(str::to_string),
                args.get("tags").map(|_| arg_strings(args, "tags")),
                args.get("aliases").map(|_| arg_strings(args, "aliases")),
                None,
                None,
            )
            .await,
            Err(err) => Err(err),
        },
        "vault_append_to_note" => match note_reference(state, user_id, args).await {
            Ok(id) => {
                svc_append(
                    state,
                    user_id,
                    id,
                    arg_str(args, "text").unwrap_or(""),
                    arg_str(args, "heading"),
                )
                .await
            }
            Err(err) => Err(err),
        },
        "vault_delete_note" => {
            let confirmed = args
                .get("confirm")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if !confirmed {
                return Some(Ok(vec![json!({
                    "error": "confirmation_required",
                    "message": "Ask the user to confirm deleting this note, then call again with confirm=true."
                })
                .to_string()]));
            }
            match note_reference(state, user_id, args).await {
                Ok(id) => svc_delete(state, user_id, id).await,
                Err(err) => Err(err),
            }
        }
        "vault_list_notes" => {
            let limit = args
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(20);
            svc_list(
                state,
                user_id,
                arg_str(args, "tag"),
                arg_str(args, "folder"),
                limit,
                0,
            )
            .await
        }
        "vault_backlinks" => {
            let reference = arg_str(args, "note_id")
                .or_else(|| arg_str(args, "title"))
                .unwrap_or("");
            svc_backlinks(state, user_id, reference).await
        }
        _ => return None,
    };
    Some(result.map(|value| vec![value.to_string()]))
}

/// MCP tool definitions (`tools/list`) for the core MCP server.
pub fn mcp_tools() -> Vec<Value> {
    tool_definitions()
        .into_iter()
        .map(|tool| {
            let function = tool.get("function").cloned().unwrap_or(Value::Null);
            json!({
                "name": function.get("name").cloned().unwrap_or(Value::Null),
                "description": function.get("description").cloned().unwrap_or(Value::Null),
                "inputSchema": function.get("parameters").cloned().unwrap_or(json!({"type": "object"})),
            })
        })
        .collect()
}

/// Dispatch an MCP tool call. `None` means "not a Vault tool".
pub async fn mcp_call(
    state: &AppState,
    user_id: Uuid,
    name: &str,
    args: &Value,
) -> Option<Result<Value, ApiError>> {
    if !name.starts_with("vault_") {
        return None;
    }
    if !allowed(&state.pool, user_id).await {
        return Some(Err(ApiError::PaymentRequired(PREMIUM_MESSAGE.to_string())));
    }
    let result = match name {
        "vault_search" => {
            let limit = args
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(10);
            svc_search(
                state,
                user_id,
                arg_str(args, "query").unwrap_or(""),
                arg_str(args, "mode").unwrap_or("text"),
                limit,
            )
            .await
        }
        "vault_get_note" => match note_reference(state, user_id, args).await {
            Ok(id) => svc_get(state, user_id, id).await,
            Err(err) => Err(err),
        },
        "vault_create_note" => {
            svc_create(
                state,
                user_id,
                arg_str(args, "title").unwrap_or(""),
                arg_str(args, "body").unwrap_or(""),
                arg_strings(args, "tags"),
                arg_strings(args, "aliases"),
                arg_str(args, "folder").unwrap_or(""),
                false,
            )
            .await
        }
        "vault_update_note" => match note_reference(state, user_id, args).await {
            Ok(id) => svc_update(
                state,
                user_id,
                id,
                arg_str(args, "title").map(str::to_string),
                arg_str(args, "body").map(str::to_string),
                args.get("tags").map(|_| arg_strings(args, "tags")),
                args.get("aliases").map(|_| arg_strings(args, "aliases")),
                None,
                None,
            )
            .await,
            Err(err) => Err(err),
        },
        "vault_append_to_note" => match note_reference(state, user_id, args).await {
            Ok(id) => {
                svc_append(
                    state,
                    user_id,
                    id,
                    arg_str(args, "text").unwrap_or(""),
                    arg_str(args, "heading"),
                )
                .await
            }
            Err(err) => Err(err),
        },
        "vault_delete_note" => {
            let confirmed = args
                .get("confirm")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if !confirmed {
                return Some(Ok(json!({
                    "error": "confirmation_required",
                    "message": "Ask the user to confirm deleting this note, then call again with confirm=true."
                })));
            }
            match note_reference(state, user_id, args).await {
                Ok(id) => svc_delete(state, user_id, id).await,
                Err(err) => Err(err),
            }
        }
        "vault_list_notes" => {
            let limit = args
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(20);
            svc_list(
                state,
                user_id,
                arg_str(args, "tag"),
                arg_str(args, "folder"),
                limit,
                0,
            )
            .await
        }
        "vault_backlinks" => {
            let reference = arg_str(args, "note_id")
                .or_else(|| arg_str(args, "title"))
                .unwrap_or("");
            svc_backlinks(state, user_id, reference).await
        }
        _ => return None,
    };
    Some(result)
}

/// The Vault system note injected into the agent prompt when the surface is
/// available (always in community, Premium-only on hosted).
pub const SYSTEM_NOTE: &str = r#"VAULT: You also have a Vault of markdown notes. Use `vault_search` whenever the user asks what they wrote/noted/saved, `vault_get_note` to read one, `vault_create_note` to save something new, `vault_append_to_note` to add without replacing, and `vault_backlinks` to show what links to a note. Notes link with [[Note title]]. Deleting is destructive: ask for explicit confirmation first, then call `vault_delete_note` with confirm=true. Never claim a note action succeeded unless the tool returned success."#;

/// The OpenClaw digest body: a bounded summary of the vault for a daily push.
pub async fn digest_summary(state: &AppState, user_id: Uuid) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "")
        .await
        .map_err(db_error)?;
    let recent = sqlx::query(
        "SELECT id, title, updated_at FROM vault_notes WHERE user_id = $1 \
         ORDER BY updated_at DESC LIMIT 5",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_notes WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let items: Vec<Value> = recent
        .iter()
        .map(|row| {
            json!({
                "title": row.try_get::<String, _>("title").unwrap_or_default(),
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();
    Ok(json!({ "notes": total, "recent": items }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilinks_parse_targets_and_aliases() {
        let body = "See [[Projects/Timeline]] and [[Daily note|today]] and [[Projects/Timeline]].";
        let links = parse_wikilinks(body);
        assert_eq!(links, vec!["Projects/Timeline", "Daily note"]);
    }

    #[test]
    fn wikilink_anchors_are_dropped_and_links_are_bounded() {
        let links = parse_wikilinks("[[Note#Heading]] [[ ]]");
        assert_eq!(links, vec!["Note"]);
    }

    #[test]
    fn chunks_respect_the_cap_and_never_start_empty() {
        let body = "paragraph one\n\nparagraph two\n\nparagraph three";
        let chunks = chunk_text("Title", body);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|chunk| !chunk.trim().is_empty()));
        assert!(chunks.len() <= MAX_CHUNKS);

        let long = "x".repeat(CHUNK_CHARS * 4);
        assert_eq!(chunk_text("T", &long).len(), 4);
    }

    #[test]
    fn titles_and_lists_are_validated() {
        assert!(clean_title("  ").is_err());
        assert!(clean_title(&"a".repeat(MAX_TITLE_CHARS + 1)).is_err());
        assert_eq!(clean_title(" Hello ").unwrap(), "Hello");
        let tags = clean_list(
            &["a".to_string(), "A".to_string(), " b ".to_string()],
            MAX_TAGS,
            "tags",
        )
        .unwrap();
        assert_eq!(tags, vec!["a", "b"]);
    }

    #[test]
    fn mcp_schema_mirrors_the_agent_tools() {
        let tools = mcp_tools();
        assert!(tools.iter().any(|tool| tool["name"] == "vault_delete_note"));
        assert!(tools
            .iter()
            .all(|tool| tool.get("inputSchema").is_some()));
    }
}
