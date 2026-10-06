//! `/api/tasks` routes: the core task suite (CRUD, trash, batch operations,
//! search and board moves).
//!
//! Mirrors the Python `routers/tasks.py` contract (paths, status codes,
//! `{"detail": ...}` errors, serialized task shape) closely enough that the
//! frontend works against either backend. Read/access paths honour team
//! sharing via `task::access_condition`; mutations that touch a task's parent,
//! board section or list stay owner-scoped. Recurring expansion, background
//! embeddings and the subtask/AI breakdown routes live elsewhere. Every handler
//! runs in a transaction with `app.user_id` set so the RLS policies hold on
//! production.

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::db;
use crate::error::ApiError;
use crate::task::{self, Task, COLUMNS};
use crate::AppState;

const TITLE_MAX: usize = 5000;
const DESCRIPTION_MAX: usize = 100_000;
const TRASH_RETENTION_DAYS: i64 = 14;

/// The `/api/tasks` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/", get(list_tasks).post(create_task))
        .route("/api/tasks/search", get(search_route))
        .route("/api/tasks/date-range", get(date_range))
        .route("/api/tasks/upcoming-deadlines", get(upcoming_deadlines))
        .route("/api/tasks/trash", get(list_trash))
        .route("/api/tasks/trash/empty", post(empty_trash))
        .route("/api/tasks/batch", post(batch_create))
        .route("/api/tasks/batch-restore", post(batch_restore))
        .route("/api/tasks/batch-delete", post(batch_delete))
        .route("/api/tasks/batch-reschedule", post(batch_reschedule))
        .route("/api/tasks/batch-board-move", post(batch_board_move))
        .route("/api/tasks/batch-set-date", post(batch_set_date))
        .route("/api/tasks/board-move", post(board_move))
        .route("/api/tasks/expand-recurring", post(expand_recurring))
        .route(
            "/api/tasks/{task_id}",
            get(get_task).patch(update_task).delete(delete_task),
        )
        .route("/api/tasks/{task_id}/permanent", axum::routing::delete(delete_permanent))
        .route("/api/tasks/{task_id}/restore", post(restore_task))
        .route(
            "/api/tasks/{task_id}/subtasks",
            get(list_subtasks).post(create_subtask),
        )
        .route("/api/tasks/{task_id}/subtasks/reorder", post(reorder_subtasks))
        .route(
            "/api/tasks/{task_id}/description-to-subtasks",
            post(description_to_subtasks),
        )
        .route(
            "/api/tasks/{task_id}/subtasks-to-description",
            post(subtasks_to_description),
        )
        .route("/api/tasks/{task_id}/breakdown", post(breakdown_task))
        .route(
            "/api/tasks/{task_id}/subtasks/{subtask_id}",
            patch(update_subtask).delete(delete_subtask),
        )
}

// ---------------------------------------------------------------------------
// Request/response types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ListQuery {
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    date_from: Option<String>,
    date_to: Option<String>,
    list_id: Option<String>,
    updated_since: Option<String>,
    #[serde(default)]
    include_deleted: bool,
}

#[derive(Deserialize)]
pub(crate) struct CreateTaskRequest {
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) parent_task_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) board_section_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default = "default_status")]
    pub(crate) status: String,
    #[serde(default = "default_priority")]
    pub(crate) priority: i64,
    #[serde(default)]
    pub(crate) start_date: Option<String>,
    #[serde(default)]
    pub(crate) due_date: Option<String>,
    #[serde(default)]
    pub(crate) start_time: Option<String>,
    #[serde(default)]
    pub(crate) end_time: Option<String>,
    #[serde(default)]
    pub(crate) recurrence_rule: Option<String>,
    #[serde(default)]
    pub(crate) recurrence_end_date: Option<String>,
    #[serde(default)]
    pub(crate) estimated_minutes: Option<i32>,
    #[serde(default)]
    pub(crate) tag_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub(crate) list_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) reminder_enabled: bool,
}

fn default_status() -> String {
    "backlog".to_string()
}

fn default_priority() -> i64 {
    2
}

#[derive(Deserialize, Default)]
pub(crate) struct UpdateTaskRequest {
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) priority: Option<i64>,
    #[serde(default)]
    pub(crate) start_date: Option<String>,
    #[serde(default)]
    pub(crate) due_date: Option<String>,
    #[serde(default)]
    pub(crate) start_time: Option<String>,
    #[serde(default)]
    pub(crate) end_time: Option<String>,
    #[serde(default)]
    pub(crate) is_all_day: Option<bool>,
    #[serde(default)]
    pub(crate) estimated_minutes: Option<i32>,
    #[serde(default)]
    pub(crate) recurrence_rule: Option<String>,
    #[serde(default)]
    pub(crate) recurrence_end_date: Option<String>,
    #[serde(default)]
    pub(crate) sort_order: Option<i32>,
    #[serde(default)]
    pub(crate) parent_task_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) is_archived: Option<bool>,
    #[serde(default)]
    pub(crate) board_section_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) board_order: Option<i32>,
    #[serde(default)]
    pub(crate) list_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) reminder_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) tag_ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize)]
struct BatchIdsRequest {
    task_ids: Vec<String>,
}

#[derive(Deserialize)]
struct BatchRescheduleRequest {
    task_ids: Vec<String>,
    delta_days: i64,
}

#[derive(Deserialize)]
struct BatchSetDateRequest {
    task_ids: Vec<String>,
    date: String,
}

#[derive(Deserialize)]
struct BatchCreateRequest {
    tasks: Vec<CreateTaskRequest>,
}

#[derive(Deserialize)]
struct BoardMoveRequest {
    task_id: String,
    #[serde(default)]
    section_id: Option<Uuid>,
    #[serde(default)]
    index: Option<i64>,
}

#[derive(Deserialize)]
struct BatchBoardMoveRequest {
    task_ids: Vec<String>,
    #[serde(default)]
    section_id: Option<Uuid>,
    #[serde(default)]
    index: Option<i64>,
}

#[derive(Deserialize)]
struct CreateSubtaskRequest {
    title: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize, Default)]
struct ReorderRequest {
    #[serde(default)]
    ordered_ids: Vec<String>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    date_from: Option<String>,
    #[serde(default)]
    date_to: Option<String>,
    #[serde(default)]
    priority_min: Option<i16>,
    #[serde(default)]
    priority_max: Option<i16>,
}

#[derive(Deserialize)]
struct RangeQuery {
    date_from: Option<String>,
    date_to: Option<String>,
}

#[derive(Deserialize, Default)]
struct UpcomingQuery {
    days_ahead: Option<i64>,
}

/// Fully validated input for creating a task.
struct NewTask {
    title: String,
    parent_task_id: Option<Uuid>,
    board_section_id: Option<Uuid>,
    description: Option<String>,
    status: String,
    priority: i16,
    start_date: Option<NaiveDate>,
    due_date: Option<NaiveDate>,
    start_time: Option<NaiveTime>,
    end_time: Option<NaiveTime>,
    recurrence_rule: Option<String>,
    recurrence_end_date: Option<NaiveDate>,
    estimated_minutes: Option<i32>,
    list_id: Option<Uuid>,
    reminder_enabled: bool,
    tag_ids: Option<Vec<Uuid>>,
}

/// Validated update input. `None` means "not provided/unchanged"; the two time
/// fields are always applied (mirroring Python `to_fields_dict`).
#[derive(Default)]
struct TaskPatch {
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<i16>,
    start_date: Option<NaiveDate>,
    due_date: Option<NaiveDate>,
    start_time: Option<NaiveTime>,
    end_time: Option<NaiveTime>,
    is_all_day: Option<bool>,
    estimated_minutes: Option<i32>,
    recurrence_rule: Option<String>,
    recurrence_end_date: Option<NaiveDate>,
    sort_order: Option<i32>,
    parent_task_id: Option<Uuid>,
    is_archived: Option<bool>,
    board_section_id: Option<Uuid>,
    board_order: Option<i32>,
    list_id: Option<Uuid>,
    reminder_enabled: Option<bool>,
    tag_ids: Option<Vec<Uuid>>,
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

fn parse_date_field(value: Option<&str>) -> Result<Option<NaiveDate>, ApiError> {
    match value {
        None => Ok(None),
        Some(raw) => task::parse_date(Some(raw)).map(Some).ok_or_else(|| {
            ApiError::Unprocessable("Date must be in YYYY-MM-DD format".to_string())
        }),
    }
}

fn parse_time_field(value: Option<&str>) -> Result<Option<NaiveTime>, ApiError> {
    match value {
        None => Ok(None),
        Some(raw) => task::parse_time(Some(raw)).map(Some).ok_or_else(|| {
            ApiError::Unprocessable("Time must be in HH:MM format".to_string())
        }),
    }
}

fn parse_datetime(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(ndt.and_utc());
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Some(ndt.and_utc());
    }
    None
}

async fn list_owned(conn: &mut PgConnection, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    Ok(
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM lists WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
    )
}

async fn section_owned(
    conn: &mut PgConnection,
    id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM board_sections WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .is_some())
}

async fn tag_owned(conn: &mut PgConnection, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    Ok(
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM tags WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
    )
}

async fn task_active(conn: &mut PgConnection, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let access = task::access_condition(2);
    let sql = format!("SELECT 1 FROM tasks WHERE id = $1 AND {access} AND deleted_at IS NULL");
    Ok(sqlx::query_scalar::<_, i32>(&sql)
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
        .is_some())
}

async fn owned_list_uuid(
    conn: &mut PgConnection,
    user_id: Uuid,
    raw: &str,
) -> Result<Uuid, ApiError> {
    let id = Uuid::parse_str(raw).map_err(|_| ApiError::NotFound("List not found".to_string()))?;
    if list_owned(conn, id, user_id).await.map_err(db_error)? {
        Ok(id)
    } else {
        Err(ApiError::NotFound("List not found".to_string()))
    }
}

fn parse_batch_ids(raw: &[String]) -> Result<Vec<Uuid>, ApiError> {
    if raw.is_empty() {
        return Err(ApiError::Unprocessable(
            "Batch must contain at least one task id".to_string(),
        ));
    }
    if raw.len() > 100 {
        return Err(ApiError::Unprocessable(
            "Batch must contain at most 100 task ids".to_string(),
        ));
    }
    raw.iter().map(|value| task::require_uuid(value)).collect()
}

async fn serialize_all(
    conn: &mut PgConnection,
    tasks: Vec<Task>,
) -> Result<Vec<Value>, sqlx::Error> {
    let ids: Vec<Uuid> = tasks.iter().map(|t| t.id).collect();
    let tags = task::tags_for(&mut *conn, &ids).await?;
    Ok(tasks
        .iter()
        .map(|t| task::task_json(t, tags.get(&t.id).map(|v| v.as_slice())))
        .collect())
}

pub(crate) async fn serialize_one(conn: &mut PgConnection, task: &Task) -> Result<Value, sqlx::Error> {
    let tags = task::tags_for(&mut *conn, &[task.id]).await?;
    Ok(task::task_json(task, tags.get(&task.id).map(|v| v.as_slice())))
}

async fn insert_task(
    conn: &mut PgConnection,
    user_id: Uuid,
    new: &NewTask,
    list_id: Uuid,
) -> Result<Uuid, ApiError> {
    let mut start_date = new.start_date;
    if new.recurrence_rule.is_some() && start_date.is_none() {
        start_date = Some(Utc::now().date_naive());
    }
    task::validate_order(start_date, new.due_date, new.start_time, new.end_time)?;
    let row = sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, board_section_id, title, description, \
         status, priority, start_date, due_date, start_time, end_time, recurrence_rule, \
         recurrence_end_date, estimated_minutes, list_id, reminder_enabled, is_all_day, \
         is_archived, sort_order) \
         VALUES ($1, $2, $3, $4, $5, $6::task_status, $7, $8, $9, $10, $11, $12, $13, $14, \
         $15, $16, false, false, 0) RETURNING id",
    )
    .bind(user_id)
    .bind(new.parent_task_id)
    .bind(new.board_section_id)
    .bind(&new.title)
    .bind(&new.description)
    .bind(&new.status)
    .bind(new.priority)
    .bind(start_date)
    .bind(new.due_date)
    .bind(new.start_time)
    .bind(new.end_time)
    .bind(&new.recurrence_rule)
    .bind(new.recurrence_end_date)
    .bind(new.estimated_minutes)
    .bind(list_id)
    .bind(new.reminder_enabled)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_error)?;
    row.try_get("id").map_err(db_error)
}

pub(crate) async fn persist_task(conn: &mut PgConnection, t: &Task) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE tasks SET parent_task_id = $2, board_section_id = $3, board_order = $4, \
         title = $5, description = $6, status = $7::task_status, priority = $8, start_date = $9, \
         due_date = $10, start_time = $11, end_time = $12, is_all_day = $13, \
         estimated_minutes = $14, recurrence_rule = $15, recurrence_end_date = $16, \
         sort_order = $17, is_archived = $18, reminder_enabled = $19, list_id = $20, \
         updated_at = now() WHERE id = $1",
    )
    .bind(t.id)
    .bind(t.parent_task_id)
    .bind(t.board_section_id)
    .bind(t.board_order)
    .bind(&t.title)
    .bind(&t.description)
    .bind(&t.status)
    .bind(t.priority)
    .bind(t.start_date)
    .bind(t.due_date)
    .bind(t.start_time)
    .bind(t.end_time)
    .bind(t.is_all_day)
    .bind(t.estimated_minutes)
    .bind(&t.recurrence_rule)
    .bind(t.recurrence_end_date)
    .bind(t.sort_order)
    .bind(t.is_archived)
    .bind(t.reminder_enabled)
    .bind(t.list_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn apply_delete(
    conn: &mut PgConnection,
    root: Uuid,
    user_id: Uuid,
    deleted: bool,
) -> Result<u64, sqlx::Error> {
    let value = if deleted { "now()" } else { "NULL" };
    let access = task::access_condition(2);
    let sql = format!(
        "WITH RECURSIVE tree AS ( \
           SELECT id FROM tasks WHERE id = $1 AND {access} \
           UNION ALL \
           SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id \
         ) UPDATE tasks SET deleted_at = {value}, updated_at = now() WHERE id IN (SELECT id FROM tree)"
    );
    let result = sqlx::query(&sql)
        .bind(root)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    Ok(result.rows_affected())
}

fn validate_create(req: CreateTaskRequest) -> Result<NewTask, ApiError> {
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::Unprocessable("Title is required".to_string()));
    }
    if title.chars().count() > TITLE_MAX {
        return Err(ApiError::Unprocessable(
            "Title must be at most 5,000 characters".to_string(),
        ));
    }
    if let Some(description) = &req.description {
        if description.chars().count() > DESCRIPTION_MAX {
            return Err(ApiError::Unprocessable(
                "Description must be at most 100,000 characters".to_string(),
            ));
        }
    }
    if !task::valid_status(&req.status) {
        return Err(ApiError::Unprocessable(task::invalid_status_message()));
    }
    if !(1..=3).contains(&req.priority) {
        return Err(ApiError::Unprocessable(
            "Priority must be between 1 and 3".to_string(),
        ));
    }
    Ok(NewTask {
        title,
        parent_task_id: req.parent_task_id,
        board_section_id: req.board_section_id,
        description: req.description,
        status: req.status,
        priority: task::normalize_priority(Some(req.priority)),
        start_date: parse_date_field(req.start_date.as_deref())?,
        due_date: parse_date_field(req.due_date.as_deref())?,
        start_time: parse_time_field(req.start_time.as_deref())?,
        end_time: parse_time_field(req.end_time.as_deref())?,
        recurrence_rule: req.recurrence_rule,
        recurrence_end_date: parse_date_field(req.recurrence_end_date.as_deref())?,
        estimated_minutes: req.estimated_minutes,
        list_id: req.list_id,
        reminder_enabled: req.reminder_enabled,
        tag_ids: req.tag_ids,
    })
}

fn validate_update(req: UpdateTaskRequest) -> Result<TaskPatch, ApiError> {
    let title = match req.title {
        Some(raw) => {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return Err(ApiError::Unprocessable("Title must not be empty".to_string()));
            }
            if trimmed.chars().count() > TITLE_MAX {
                return Err(ApiError::Unprocessable(
                    "Title must be at most 5,000 characters".to_string(),
                ));
            }
            Some(trimmed)
        }
        None => None,
    };
    if let Some(description) = &req.description {
        if description.chars().count() > DESCRIPTION_MAX {
            return Err(ApiError::Unprocessable(
                "Description must be at most 100,000 characters".to_string(),
            ));
        }
    }
    if let Some(status) = &req.status {
        if !task::valid_status(status) {
            return Err(ApiError::Unprocessable(task::invalid_status_message()));
        }
    }
    let priority = match req.priority {
        Some(value) => {
            if !(1..=3).contains(&value) {
                return Err(ApiError::Unprocessable(
                    "Priority must be between 1 and 3".to_string(),
                ));
            }
            Some(task::normalize_priority(Some(value)))
        }
        None => None,
    };
    Ok(TaskPatch {
        title,
        description: req.description,
        status: req.status,
        priority,
        start_date: parse_date_field(req.start_date.as_deref())?,
        due_date: parse_date_field(req.due_date.as_deref())?,
        start_time: parse_time_field(req.start_time.as_deref())?,
        end_time: parse_time_field(req.end_time.as_deref())?,
        is_all_day: req.is_all_day,
        estimated_minutes: req.estimated_minutes,
        recurrence_rule: req.recurrence_rule,
        recurrence_end_date: parse_date_field(req.recurrence_end_date.as_deref())?,
        sort_order: req.sort_order,
        parent_task_id: req.parent_task_id,
        is_archived: req.is_archived,
        board_section_id: req.board_section_id,
        board_order: req.board_order,
        list_id: req.list_id,
        reminder_enabled: req.reminder_enabled,
        tag_ids: req.tag_ids,
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Next `sort_order` for a new subtask under `parent_id` (Python `next_sort_order`).
async fn next_sort_order(conn: &mut PgConnection, parent_id: Uuid) -> Result<i32, sqlx::Error> {
    let max: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) FROM tasks WHERE parent_task_id = $1",
    )
    .bind(parent_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(max + 1)
}

/// Split a description into subtask titles, stripping markdown bullets
/// (Python `subtask_service._split_bullets`).
pub(crate) fn split_bullets(description: Option<&str>) -> Vec<String> {
    const PREFIXES: [&str; 6] = ["- ", "* ", "+ ", "\u{2022} ", "-", "*"];
    let mut items = Vec::new();
    for raw in description.unwrap_or("").lines() {
        let mut line = raw.trim();
        if line.is_empty() {
            continue;
        }
        for prefix in PREFIXES {
            if let Some(rest) = line.strip_prefix(prefix) {
                line = rest.trim();
                break;
            }
        }
        if !line.is_empty() {
            items.push(line.to_string());
        }
    }
    items
}

/// Generic fallback breakdown when the description has no bullets.
fn generic_breakdown() -> Vec<String> {
    [
        "Define scope and requirements",
        "Plan the steps and timeline",
        "Execute the core work",
        "Review and test the result",
        "Finalize and deliver",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Subtask titles for the breakdown fallback chain: description bullets, else
/// a generic list; capped at 6 (Python `ai_breakdown_titles`). The LLM path is
/// tried first by [`llm_breakdown_titles`].
fn breakdown_titles(description: Option<&str>) -> Vec<String> {
    let mut titles = split_bullets(description);
    if titles.is_empty() {
        titles = generic_breakdown();
    }
    titles.truncate(6);
    titles
}

/// Ask the user's own LLM (BYOK) for breakdown subtask titles, mirroring
/// Python `ai_breakdown_titles` when a client is available. Fail-soft: any
/// error (no stored key, decrypt failure, provider error, unparseable reply)
/// yields an empty list so the caller falls back to bullets then the generic
/// list. The network call is deliberately outside any DB transaction.
async fn llm_breakdown_titles(
    state: &AppState,
    user_id: uuid::Uuid,
    title: &str,
    description: Option<&str>,
) -> Vec<String> {
    let Some(key) = crate::api_key::get_active_for_user(&state.pool, user_id)
        .await
        .ok()
        .flatten()
    else {
        return Vec::new();
    };
    let Ok(api_key) = crate::api_key::decrypt(&key, &state.settings.encryption_key) else {
        return Vec::new();
    };
    let Ok(client) = crate::llm::LlmClient::new(&key.provider, &api_key) else {
        return Vec::new();
    };

    let prompt = format!(
        "You are a task breakdown expert. Given the task, respond with EXACTLY a JSON array of 4-6 concrete, actionable subtask titles to complete it. Return nothing but the JSON array, e.g. [\"Research and define scope\", \"Create a plan\", \"Execute\", \"Review\"].\n\nTask title: {title}\nTask description: {}",
        description.unwrap_or("None")
    );
    let messages = serde_json::json!([{ "role": "user", "content": prompt }]);

    let response = match client.chat(&messages, None, Some(0.7), Some(500)).await {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let content = crate::llm::LlmClient::first_choice(&response)
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let mut titles: Vec<String> = Vec::new();
    if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&content) {
        for item in items {
            let text = item.to_string();
            let text = text.trim_matches('"').trim();
            if !text.is_empty() {
                titles.push(text.to_string());
            }
        }
    }
    if titles.is_empty() {
        for line in content.lines() {
            let cleaned = line
                .trim()
                .trim_start_matches('-')
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            if !cleaned.is_empty() && cleaned.len() > 3 {
                titles.push(cleaned.to_string());
            }
        }
    }
    titles.truncate(6);
    titles
}

/// Apply a validated patch to a loaded task and persist it (shared by the task
/// and subtask update routes, mirroring Python `task_service.update_task`).
async fn apply_patch(
    conn: &mut PgConnection,
    user_id: Uuid,
    task: &mut Task,
    patch: &TaskPatch,
) -> Result<(), ApiError> {
    if let Some(value) = patch.title.clone() {
        task.title = value;
    }
    if let Some(value) = patch.description.clone() {
        task.description = Some(value);
    }
    if let Some(value) = patch.status.clone() {
        task.status = value;
    }
    if let Some(value) = patch.priority {
        task.priority = value;
    }
    if let Some(value) = patch.start_date {
        task.start_date = Some(value);
    }
    if let Some(value) = patch.due_date {
        task.due_date = Some(value);
    }
    task.start_time = patch.start_time;
    task.end_time = patch.end_time;
    if let Some(value) = patch.is_all_day {
        task.is_all_day = value;
    }
    if let Some(value) = patch.estimated_minutes {
        task.estimated_minutes = Some(value);
    }
    if let Some(value) = patch.recurrence_rule.clone() {
        task.recurrence_rule = Some(value);
    }
    if let Some(value) = patch.recurrence_end_date {
        task.recurrence_end_date = Some(value);
    }
    if let Some(value) = patch.sort_order {
        task.sort_order = value;
    }
    if let Some(value) = patch.is_archived {
        task.is_archived = value;
    }
    if let Some(value) = patch.board_order {
        task.board_order = Some(value);
    }
    if let Some(value) = patch.reminder_enabled {
        task.reminder_enabled = value;
    }

    if let Some(parent) = patch.parent_task_id {
        if !task_active(conn, parent, user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Parent task not found".to_string()));
        }
        task.parent_task_id = Some(parent);
    }
    if let Some(section) = patch.board_section_id {
        if !section_owned(conn, section, user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Board section not found".to_string()));
        }
        task.board_section_id = Some(section);
    }
    if let Some(list) = patch.list_id {
        if !list_owned(conn, list, user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("List not found".to_string()));
        }
        task.list_id = Some(list);
    }
    if task.recurrence_rule.is_some() && task.start_date.is_none() {
        task.start_date = Some(Utc::now().date_naive());
    }
    task::validate_order(task.start_date, task.due_date, task.start_time, task.end_time)?;

    persist_task(conn, task).await.map_err(db_error)?;
    Ok(())
}

async fn list_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let offset = params.offset.unwrap_or(0).max(0);
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;

    let tasks: Vec<Task> = if let Some(query) = params.query.as_deref().filter(|s| !s.is_empty()) {
        let mut hits =
            task::search_tasks(&mut *tx, user.user_id, query, limit).await.map_err(db_error)?;
        if let Some(raw_list) = params.list_id.as_deref() {
            let list_id = owned_list_uuid(&mut *tx, user.user_id, raw_list).await?;
            hits.retain(|(t, _)| t.list_id == Some(list_id));
        }
        hits.into_iter().map(|(t, _)| t).collect()
    } else if params.date_from.is_some() || params.date_to.is_some() {
        let from = task::parse_date(params.date_from.as_deref())
            .or_else(|| task::parse_date(params.date_to.as_deref()));
        let to = task::parse_date(params.date_to.as_deref())
            .or_else(|| task::parse_date(params.date_from.as_deref()));
        let (Some(from), Some(to)) = (from, to) else {
            return Err(ApiError::Unprocessable(
                "date_from and date_to must be valid YYYY-MM-DD dates".to_string(),
            ));
        };
        if to < from {
            return Err(ApiError::Unprocessable(
                "date_to must not be before date_from".to_string(),
            ));
        }
        crate::recurring::expand_recurring_for_range(&mut *tx, Some(user.user_id), from, to)
            .await
            .map_err(db_error)?;
        let access = task::access_condition(1);
        let sql = format!(
            "SELECT {COLUMNS} FROM tasks WHERE {access} AND deleted_at IS NULL AND ( \
             (start_date >= $2 AND start_date <= $3) OR (due_date >= $2 AND due_date <= $3) OR \
             (start_date <= $2 AND due_date >= $3)) ORDER BY start_date"
        );
        let rows = sqlx::query(&sql)
            .bind(user.user_id)
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
        rows.iter().map(Task::from_row).collect::<Result<_, _>>().map_err(db_error)?
    } else if let Some(raw_since) = params.updated_since.as_deref() {
        let since = parse_datetime(raw_since).ok_or_else(|| {
            ApiError::Unprocessable("updated_since must be a valid ISO datetime".to_string())
        })?;
        let list_id = match params.list_id.as_deref() {
            Some(raw) => Some(owned_list_uuid(&mut *tx, user.user_id, raw).await?),
            None => None,
        };
        let access = task::access_condition(1);
        let sql = format!(
            "SELECT {COLUMNS} FROM tasks WHERE {access} AND ($2::bool OR deleted_at IS NULL) \
             AND ($3::uuid IS NULL OR list_id = $3) AND updated_at > $4 \
             ORDER BY updated_at ASC, id ASC LIMIT $5 OFFSET $6"
        );
        let rows = sqlx::query(&sql)
            .bind(user.user_id)
            .bind(params.include_deleted)
            .bind(list_id)
            .bind(since)
            .bind(limit)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
        rows.iter().map(Task::from_row).collect::<Result<_, _>>().map_err(db_error)?
    } else {
        let list_id = match params.list_id.as_deref() {
            Some(raw) => Some(owned_list_uuid(&mut *tx, user.user_id, raw).await?),
            None => None,
        };
        let access = task::access_condition(1);
        let sql = format!(
            "SELECT {COLUMNS} FROM tasks WHERE {access} AND ($2::bool OR deleted_at IS NULL) \
             AND ($3::uuid IS NULL OR list_id = $3) \
             ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5"
        );
        let rows = sqlx::query(&sql)
            .bind(user.user_id)
            .bind(params.include_deleted)
            .bind(list_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
        rows.iter().map(Task::from_row).collect::<Result<_, _>>().map_err(db_error)?
    };

    let out = serialize_all(&mut *tx, tasks).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

pub(crate) async fn svc_create_task(
    state: &AppState,
    user_id: Uuid,
    req: CreateTaskRequest,
) -> Result<Value, ApiError> {
    let new = validate_create(req)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;

    if let Some(parent) = new.parent_task_id {
        if !task_active(&mut *tx, parent, user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Parent task not found".to_string()));
        }
    }
    if let Some(section) = new.board_section_id {
        if !section_owned(&mut *tx, section, user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Board section not found".to_string()));
        }
    }
    let list_id = match new.list_id {
        Some(id) => {
            if !list_owned(&mut *tx, id, user_id).await.map_err(db_error)? {
                return Err(ApiError::NotFound("List not found".to_string()));
            }
            id
        }
        None => task::default_list_id(&mut *tx, user_id).await.map_err(db_error)?,
    };

    let id = insert_task(&mut *tx, user_id, &new, list_id).await?;

    if let Some(tag_ids) = &new.tag_ids {
        for tag_id in tag_ids {
            if !tag_owned(&mut *tx, *tag_id, user_id).await.map_err(db_error)? {
                return Err(ApiError::BadRequest(format!("Tag not found: {tag_id}")));
            }
            sqlx::query(
                "INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
    }

    let task = task::find_task(&mut *tx, id, user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::Internal("created task missing".to_string()))?;
    if new.recurrence_rule.is_some() && new.parent_task_id.is_none() {
        crate::recurring::expand_task_occurrences(&mut *tx, &task)
            .await
            .map_err(db_error)?;
    }
    let out = serialize_one(&mut *tx, &task).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    crate::embedding::spawn_embedding(
        state.pool.clone(),
        state.settings.encryption_key.clone(),
        task.id,
        user_id,
        task.title.clone(),
        task.description.clone(),
    );
    Ok(out)
}

pub(crate) async fn svc_update_task(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    req: UpdateTaskRequest,
) -> Result<Value, ApiError> {
    let patch = validate_update(req)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;

    let mut task = task::find_task(&mut *tx, id, user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?;

    apply_patch(&mut *tx, user_id, &mut task, &patch).await?;

    if let Some(tag_ids) = &patch.tag_ids {
        for tag_id in tag_ids {
            if !tag_owned(&mut *tx, *tag_id, user_id).await.map_err(db_error)? {
                return Err(ApiError::BadRequest(format!("Tag not found: {tag_id}")));
            }
        }
        sqlx::query("DELETE FROM task_tags WHERE task_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        for tag_id in tag_ids {
            sqlx::query(
                "INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
    }

    let refreshed = task::find_task(&mut *tx, id, user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::Internal("updated task missing".to_string()))?;
    if refreshed.recurrence_rule.is_some() && refreshed.parent_task_id.is_none() {
        crate::recurring::expand_task_occurrences(&mut *tx, &refreshed)
            .await
            .map_err(db_error)?;
    }
    let out = serialize_one(&mut *tx, &refreshed).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    crate::embedding::spawn_embedding(
        state.pool.clone(),
        state.settings.encryption_key.clone(),
        refreshed.id,
        user_id,
        refreshed.title.clone(),
        refreshed.description.clone(),
    );
    Ok(out)
}

pub(crate) async fn svc_get_task(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let task = task::find_task(&mut *tx, id, user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?;
    let out = serialize_one(&mut *tx, &task).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(out)
}

pub(crate) async fn svc_delete_task_permanent(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let trashed = task::find_task(&mut *tx, id, user_id, true)
        .await
        .map_err(db_error)?
        .filter(|t| t.deleted_at.is_some());
    if trashed.is_none() {
        return Err(ApiError::NotFound("Task not found in trash".to_string()));
    }
    let access = task::access_condition(2);
    let sql = format!(
        "WITH RECURSIVE tree AS (SELECT id FROM tasks WHERE id = $1 AND {access} \
         UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id) \
         DELETE FROM tasks WHERE id IN (SELECT id FROM tree)"
    );
    sqlx::query(&sql)
        .bind(id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(())
}

async fn create_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_create_task(&state, user.user_id, req).await?))
}

async fn update_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(req): Json<UpdateTaskRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    Ok(Json(svc_update_task(&state, user.user_id, id, req).await?))
}

async fn get_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    Ok(Json(svc_get_task(&state, user.user_id, id).await?))
}

async fn delete_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    if !task_active(&mut *tx, id, user.user_id).await.map_err(db_error)? {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    apply_delete(&mut *tx, id, user.user_id, true).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn delete_permanent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    svc_delete_task_permanent(&state, user.user_id, id).await?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn restore_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let trashed = task::find_task(&mut *tx, id, user.user_id, true)
        .await
        .map_err(db_error)?
        .filter(|t| t.deleted_at.is_some());
    if trashed.is_none() {
        return Err(ApiError::NotFound("Task not found in trash".to_string()));
    }
    apply_delete(&mut *tx, id, user.user_id, false).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "restored" })))
}

/// Hard-delete trashed tasks older than `retention_days`, plus their descendant
/// subtasks, in one recursive-CTE delete. `user_id` `Some` scopes the pass to
/// one user (the opportunistic purge inside `list_trash`); `None` covers every
/// user (the background loop, which must run on the BYPASSRLS system pool since
/// `tasks` is FORCE RLS). Returns the number of rows deleted. Mirrors Python
/// `task_service.purge_trash`.
pub async fn purge_trash(
    conn: &mut PgConnection,
    user_id: Option<Uuid>,
    retention_days: i64,
) -> Result<u32, sqlx::Error> {
    let result = match user_id {
        Some(user_id) => {
            sqlx::query(
                "WITH RECURSIVE expired AS ( \
                   SELECT id FROM tasks WHERE user_id = $2 AND deleted_at IS NOT NULL \
                   AND deleted_at < now() - ($1 * INTERVAL '1 day') \
                   UNION ALL SELECT t.id FROM tasks t JOIN expired e ON t.parent_task_id = e.id \
                 ) DELETE FROM tasks WHERE id IN (SELECT id FROM expired)",
            )
            .bind(retention_days)
            .bind(user_id)
            .execute(&mut *conn)
            .await?
        }
        None => {
            sqlx::query(
                "WITH RECURSIVE expired AS ( \
                   SELECT id FROM tasks WHERE deleted_at IS NOT NULL \
                   AND deleted_at < now() - ($1 * INTERVAL '1 day') \
                   UNION ALL SELECT t.id FROM tasks t JOIN expired e ON t.parent_task_id = e.id \
                 ) DELETE FROM tasks WHERE id IN (SELECT id FROM expired)",
            )
            .bind(retention_days)
            .execute(&mut *conn)
            .await?
        }
    };
    Ok(result.rows_affected() as u32)
}

/// Background loop: hard-delete trash past the retention window for every user,
/// then sleep (Python `trash_purge_loop`, every 6 hours). Runs on the system
/// pool; one failing pass never stops the loop.
pub async fn trash_purge_loop(pool: PgPool, interval: Duration) {
    loop {
        match pool.acquire().await {
            Ok(mut conn) => match purge_trash(&mut conn, None, TRASH_RETENTION_DAYS).await {
                Ok(purged) if purged > 0 => {
                    tracing::info!("trash: purged {purged} expired task(s)")
                }
                Ok(_) => {}
                Err(err) => tracing::warn!("trash purge pass failed: {err}"),
            },
            Err(err) => tracing::warn!("trash purge could not acquire a connection: {err}"),
        }
        tokio::time::sleep(interval).await;
    }
}

async fn list_trash(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    purge_trash(&mut tx, Some(user.user_id), TRASH_RETENTION_DAYS)
        .await
        .map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "SELECT {COLUMNS} FROM tasks WHERE {access} AND deleted_at IS NOT NULL \
         ORDER BY deleted_at DESC LIMIT 500"
    );
    let rows = sqlx::query(&sql)
        .bind(user.user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let tasks: Vec<Task> =
        rows.iter().map(Task::from_row).collect::<Result<_, _>>().map_err(db_error)?;
    let out = serialize_all(&mut *tx, tasks).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

async fn empty_trash(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!("DELETE FROM tasks WHERE {access} AND deleted_at IS NOT NULL");
    let result = sqlx::query(&sql)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "deleted": result.rows_affected() })))
}

async fn batch_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BatchIdsRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let ids = parse_batch_ids(&req.task_ids)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE {access} AND deleted_at IS NULL \
         AND id = ANY($2)"
    );
    let result = sqlx::query(&sql)
        .bind(user.user_id)
        .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "deleted": result.rows_affected() })))
}

async fn batch_restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BatchIdsRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let ids = parse_batch_ids(&req.task_ids)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "UPDATE tasks SET deleted_at = NULL, updated_at = now() WHERE {access} AND deleted_at IS NOT NULL \
         AND id = ANY($2)"
    );
    let result = sqlx::query(&sql)
        .bind(user.user_id)
        .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "restored": result.rows_affected() })))
}

async fn batch_set_date(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BatchSetDateRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let ids = parse_batch_ids(&req.task_ids)?;
    let date = task::parse_date(Some(&req.date))
        .ok_or_else(|| ApiError::Unprocessable("Invalid date".to_string()))?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "UPDATE tasks SET start_date = $3, due_date = $3 WHERE {access} AND deleted_at IS NULL \
         AND id = ANY($2) AND updated_at = updated_at"
    );
    let result = sqlx::query(&sql)
        .bind(user.user_id)
        .bind(&ids)
    .bind(date)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "updated": result.rows_affected() })))
}

async fn batch_reschedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BatchRescheduleRequest>,
) -> Result<Json<Value>, ApiError> {
    if !(-3650..=3650).contains(&req.delta_days) {
        return Err(ApiError::Unprocessable(
            "delta_days must be between -3650 and 3650".to_string(),
        ));
    }
    let user = require_user(&state, &headers)?;
    let ids = parse_batch_ids(&req.task_ids)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "UPDATE tasks SET \
        start_date = CASE \
          WHEN start_date IS NULL AND due_date IS NULL THEN (CURRENT_DATE + ($3 * INTERVAL '1 day'))::date \
          WHEN start_date IS NULL THEN NULL \
          ELSE (start_date + ($3 * INTERVAL '1 day'))::date END, \
        due_date = CASE \
          WHEN due_date IS NULL AND start_date IS NULL THEN (CURRENT_DATE + ($3 * INTERVAL '1 day'))::date \
          WHEN due_date IS NULL THEN NULL \
          ELSE (due_date + ($3 * INTERVAL '1 day'))::date END \
        WHERE {access} AND deleted_at IS NULL AND id = ANY($2)"
    );
    let result = sqlx::query(&sql)
        .bind(user.user_id)
        .bind(&ids)
        .bind(req.delta_days)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "rescheduled": result.rows_affected() })))
}

async fn board_move(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BoardMoveRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&req.task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    if !task_active(&mut *tx, id, user.user_id).await.map_err(db_error)? {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    if let Some(section) = req.section_id {
        if !section_owned(&mut *tx, section, user.user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Section not found".to_string()));
        }
    }
    task::move_tasks_to_section(
        &mut *tx,
        user.user_id,
        &[id],
        req.section_id,
        None,
        req.index.unwrap_or(0),
    )
    .await
    .map_err(db_error)?;
    let task = task::find_task(&mut *tx, id, user.user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?;
    let out = serialize_one(&mut *tx, &task).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(out))
}

async fn batch_board_move(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BatchBoardMoveRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let ids = parse_batch_ids(&req.task_ids)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    for id in &ids {
        if !task_active(&mut *tx, *id, user.user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Task not found".to_string()));
        }
    }
    if let Some(section) = req.section_id {
        if !section_owned(&mut *tx, section, user.user_id).await.map_err(db_error)? {
            return Err(ApiError::NotFound("Section not found".to_string()));
        }
    }
    let moved = task::move_tasks_to_section(
        &mut *tx,
        user.user_id,
        &ids,
        req.section_id,
        None,
        req.index.unwrap_or(0),
    )
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "moved": moved })))
}

async fn batch_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BatchCreateRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.tasks.is_empty() {
        return Err(ApiError::Unprocessable(
            "Batch must contain at least one task".to_string(),
        ));
    }
    if req.tasks.len() > 50 {
        return Err(ApiError::Unprocessable(
            "Batch must contain at most 50 tasks".to_string(),
        ));
    }
    let user = require_user(&state, &headers)?;
    let mut parsed = Vec::with_capacity(req.tasks.len());
    for item in req.tasks {
        parsed.push(validate_create(item)?);
    }
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;

    let explicit: Vec<Uuid> = parsed.iter().filter_map(|n| n.list_id).collect();
    if !explicit.is_empty() {
        let owned: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM lists WHERE user_id = $1 AND id = ANY($2)",
        )
        .bind(user.user_id)
        .bind(&explicit)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
        let owned: std::collections::HashSet<Uuid> = owned.into_iter().collect();
        if explicit.iter().any(|id| !owned.contains(id)) {
            return Err(ApiError::NotFound("List not found".to_string()));
        }
    }

    let default_list = task::default_list_id(&mut *tx, user.user_id).await.map_err(db_error)?;
    let mut created = Vec::with_capacity(parsed.len());
    for new in &parsed {
        let list_id = new.list_id.unwrap_or(default_list);
        let id = insert_task(&mut *tx, user.user_id, new, list_id).await?;
        created.push(json!({ "id": id.to_string(), "title": new.title }));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "created": created.len(), "tasks": created })))
}

async fn expand_recurring(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let created = crate::recurring::expand_recurring_tasks(
        &mut *tx,
        Some(user.user_id),
        state.settings.recurring_expand_cooldown_hours(),
    )
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "expanded": created })))
}

async fn search_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let hits = task::search_tasks(&mut *tx, user.user_id, &params.q, 20).await.map_err(db_error)?;
    let from = task::parse_date(params.date_from.as_deref());
    let to = task::parse_date(params.date_to.as_deref());
    let mut out = Vec::new();
    for (task, rank) in hits {
        if let Some(min) = params.priority_min {
            if task.priority < min {
                continue;
            }
        }
        if let Some(max) = params.priority_max {
            if task.priority > max {
                continue;
            }
        }
        if let Some(from) = from {
            if task.due_date.map(|d| d < from).unwrap_or(true) {
                continue;
            }
        }
        if let Some(to) = to {
            if task.start_date.map(|d| d > to).unwrap_or(true) {
                continue;
            }
        }
        let rounded = (rank * 1000.0).round() / 1000.0;
        out.push(json!({
            "id": task.id.to_string(),
            "title": task.title,
            "status": task.status,
            "priority": task.priority,
            "start_date": task.start_date.map(|d| d.to_string()),
            "due_date": task.due_date.map(|d| d.to_string()),
            "rank": rounded,
        }));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

async fn date_range(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<RangeQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let (Some(from), Some(to)) = (
        task::parse_date(params.date_from.as_deref()),
        task::parse_date(params.date_to.as_deref()),
    ) else {
        return Err(ApiError::Unprocessable(
            "date_from and date_to must be valid YYYY-MM-DD dates".to_string(),
        ));
    };
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    crate::recurring::expand_recurring_for_range(&mut *tx, Some(user.user_id), from, to)
        .await
        .map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "SELECT {COLUMNS} FROM tasks WHERE {access} AND deleted_at IS NULL \
         AND status NOT IN ('done'::task_status, 'cancelled'::task_status) AND ( \
         (start_date >= $2 AND start_date <= $3) OR (due_date >= $2 AND due_date <= $3) OR \
         (start_date <= $2 AND due_date >= $3)) ORDER BY start_date"
    );
    let rows = sqlx::query(&sql)
        .bind(user.user_id)
        .bind(from)
        .bind(to)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let tasks: Vec<Task> =
        rows.iter().map(Task::from_row).collect::<Result<_, _>>().map_err(db_error)?;
    let out: Vec<Value> = tasks
        .iter()
        .map(|t| {
            json!({
                "id": t.id.to_string(),
                "title": t.title,
                "status": t.status,
                "priority": t.priority,
                "start_date": t.start_date.map(|d| d.to_string()),
                "due_date": t.due_date.map(|d| d.to_string()),
            })
        })
        .collect();
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

async fn upcoming_deadlines(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<UpcomingQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let days = params.days_ahead.unwrap_or(7).max(0);
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let access = task::access_condition(1);
    let sql = format!(
        "SELECT {COLUMNS} FROM tasks WHERE {access} AND deleted_at IS NULL \
         AND status NOT IN ('done'::task_status, 'cancelled'::task_status) \
         AND due_date >= CURRENT_DATE AND due_date <= (CURRENT_DATE + ($2 * INTERVAL '1 day'))::date \
         ORDER BY due_date ASC, priority DESC"
    );
    let rows = sqlx::query(&sql)
        .bind(user.user_id)
        .bind(days)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let tasks: Vec<Task> =
        rows.iter().map(Task::from_row).collect::<Result<_, _>>().map_err(db_error)?;
    let out: Vec<Value> = tasks
        .iter()
        .map(|t| {
            json!({
                "id": t.id.to_string(),
                "title": t.title,
                "status": t.status,
                "priority": t.priority,
                "due_date": t.due_date.map(|d| d.to_string()),
                "start_date": t.start_date.map(|d| d.to_string()),
            })
        })
        .collect();
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

async fn insert_subtask(
    conn: &mut PgConnection,
    user_id: Uuid,
    parent_id: Uuid,
    title: &str,
    description: Option<&str>,
    priority: i16,
    sort_order: i32,
) -> Result<Uuid, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, title, description, status, priority, \
         sort_order, is_all_day, is_archived) \
         VALUES ($1, $2, $3, $4, 'todo'::task_status, $5, $6, false, false) RETURNING id",
    )
    .bind(user_id)
    .bind(parent_id)
    .bind(title)
    .bind(description)
    .bind(priority)
    .bind(sort_order)
    .fetch_one(&mut *conn)
    .await?;
    row.try_get("id")
}

fn validate_subtask_title(req: &CreateSubtaskRequest) -> Result<String, ApiError> {
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::Unprocessable("Title is required".to_string()));
    }
    if title.chars().count() > TITLE_MAX {
        return Err(ApiError::Unprocessable(
            "Title must be at most 5,000 characters".to_string(),
        ));
    }
    if let Some(description) = &req.description {
        if description.chars().count() > DESCRIPTION_MAX {
            return Err(ApiError::Unprocessable(
                "Description must be at most 100,000 characters".to_string(),
            ));
        }
    }
    Ok(title)
}

async fn list_subtasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    if task::find_task(&mut *tx, id, user.user_id, false)
        .await
        .map_err(db_error)?
        .is_none()
    {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    let access = task::access_condition(2);
    let sql = format!(
        "SELECT id, title, status::text AS status, priority FROM tasks \
         WHERE parent_task_id = $1 AND {access} AND deleted_at IS NULL \
         ORDER BY sort_order, created_at"
    );
    let rows = sqlx::query(&sql)
        .bind(id)
        .bind(user.user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            let sid: Uuid = row.try_get("id")?;
            let title: String = row.try_get("title")?;
            let status: String = row.try_get("status")?;
            let priority: i16 = row.try_get("priority")?;
            Ok(json!({ "id": sid.to_string(), "title": title, "status": status, "priority": priority }))
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
}

async fn create_subtask(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(req): Json<CreateSubtaskRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let title = validate_subtask_title(&req)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let parent = task::find_task(&mut *tx, id, user.user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Parent task not found".to_string()))?;
    if parent.user_id != user.user_id {
        return Err(ApiError::NotFound("Parent task not found".to_string()));
    }
    let sort_order = next_sort_order(&mut *tx, id).await.map_err(db_error)?;
    let subtask_id = insert_subtask(
        &mut *tx,
        user.user_id,
        id,
        &title,
        req.description.as_deref(),
        2,
        sort_order,
    )
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "id": subtask_id.to_string(), "title": title, "status": "todo" })))
}

async fn reorder_subtasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(body): Json<ReorderRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let parent = task::find_task(&mut *tx, id, user.user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Parent task not found".to_string()))?;
    if parent.user_id != user.user_id {
        return Err(ApiError::NotFound("Parent task not found".to_string()));
    }
    let rows = sqlx::query(
        "SELECT id FROM tasks WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let mut children: std::collections::HashMap<Uuid, ()> = std::collections::HashMap::new();
    for row in &rows {
        let child_id: Uuid = row.try_get("id").map_err(db_error)?;
        children.insert(child_id, ());
    }
    let mut ordered: Vec<Value> = Vec::new();
    for (rank, raw) in body.ordered_ids.iter().enumerate() {
        let child_id = match Uuid::parse_str(raw) {
            Ok(parsed) if children.contains_key(&parsed) => parsed,
            _ => continue,
        };
        sqlx::query("UPDATE tasks SET sort_order = $2 WHERE id = $1")
            .bind(child_id)
            .bind(rank as i32)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        ordered.push(json!({ "id": child_id.to_string(), "sort_order": rank }));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "ok", "subtasks": ordered })))
}

async fn description_to_subtasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let parent = task::find_task(&mut *tx, id, user.user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?;
    if parent.user_id != user.user_id {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    let items = split_bullets(parent.description.as_deref());
    let mut created: Vec<Value> = Vec::new();
    for (rank, title) in items.iter().enumerate() {
        let trimmed: String = title.chars().take(500).collect();
        let sid = insert_subtask(
            &mut *tx,
            user.user_id,
            id,
            &trimmed,
            None,
            parent.priority,
            rank as i32,
        )
        .await
        .map_err(db_error)?;
        created.push(json!({ "id": sid.to_string(), "title": trimmed, "status": "todo" }));
    }
    sqlx::query("UPDATE tasks SET description = NULL, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "ok", "description": Value::Null, "subtasks": created })))
}

async fn subtasks_to_description(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let parent = task::find_task(&mut *tx, id, user.user_id, false)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?;
    if parent.user_id != user.user_id {
        return Err(ApiError::NotFound("Task not found".to_string()));
    }
    let rows = sqlx::query(
        "SELECT id, title FROM tasks WHERE parent_task_id = $1 AND user_id = $2 \
         AND deleted_at IS NULL ORDER BY sort_order, created_at",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    if rows.is_empty() {
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(json!({ "status": "ok", "description": Value::Null })));
    }
    let mut child_ids: Vec<Uuid> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    for row in &rows {
        let child_id: Uuid = row.try_get("id").map_err(db_error)?;
        let title: String = row.try_get("title").map_err(db_error)?;
        child_ids.push(child_id);
        lines.push(format!("- {title}"));
    }
    let description = lines.join("\n");
    sqlx::query("DELETE FROM tasks WHERE id = ANY($1) AND user_id = $2")
        .bind(&child_ids)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("UPDATE tasks SET description = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(&description)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "ok", "description": description })))
}

async fn breakdown_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&task_id)?;
    // Load the parent in a short transaction, then release it before the
    // (optional) LLM call so no pooled connection is held across the network.
    let (parent_title, parent_description, parent_priority) = {
        let mut tx = state.pool.begin().await.map_err(db_error)?;
        db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
        let parent = task::find_task(&mut *tx, id, user.user_id, false)
            .await
            .map_err(db_error)?
            .ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?;
        if parent.user_id != user.user_id {
            return Err(ApiError::NotFound("Task not found".to_string()));
        }
        tx.commit().await.map_err(db_error)?;
        (parent.title, parent.description, parent.priority)
    };
    let mut titles =
        llm_breakdown_titles(&state, user.user_id, &parent_title, parent_description.as_deref()).await;
    if titles.is_empty() {
        titles = breakdown_titles(parent_description.as_deref());
    }

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let mut start = next_sort_order(&mut *tx, id).await.map_err(db_error)?;
    let mut created: Vec<Value> = Vec::new();
    for title in &titles {
        let cleaned = title.trim();
        if cleaned.is_empty() {
            continue;
        }
        let trimmed: String = cleaned.chars().take(500).collect();
        let sid = insert_subtask(
            &mut *tx,
            user.user_id,
            id,
            &trimmed,
            None,
            parent_priority,
            start,
        )
        .await
        .map_err(db_error)?;
        start += 1;
        created.push(json!({ "id": sid.to_string(), "title": trimmed, "status": "todo" }));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "ok", "subtasks": created })))
}

/// Load a subtask whose parent matches the `task_id` path segment, mirroring
/// Python's string comparison (`str(subtask.parent_task_id) != task_id`).
async fn find_owned_subtask(
    conn: &mut PgConnection,
    user_id: Uuid,
    task_id: &str,
    subtask_id: &str,
) -> Result<Option<Task>, ApiError> {
    let sid = task::require_uuid(subtask_id)?;
    let subtask = task::find_task(conn, sid, user_id, false).await.map_err(db_error)?;
    Ok(subtask.filter(|t| t.parent_task_id.map(|p| p.to_string()).as_deref() == Some(task_id)))
}

async fn update_subtask(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((task_id, subtask_id)): Path<(String, String)>,
    Json(req): Json<UpdateTaskRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let patch = validate_update(req)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let mut subtask = find_owned_subtask(&mut *tx, user.user_id, &task_id, &subtask_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Subtask not found".to_string()))?;
    apply_patch(&mut *tx, user.user_id, &mut subtask, &patch).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({
        "id": subtask.id.to_string(),
        "title": subtask.title,
        "status": subtask.status,
    })))
}

async fn delete_subtask(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((task_id, subtask_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let subtask = find_owned_subtask(&mut *tx, user.user_id, &task_id, &subtask_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Subtask not found".to_string()))?;
    apply_delete(&mut *tx, subtask.id, user.user_id, true)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted", "id": subtask.id.to_string() })))
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

    fn auth_header(token: &str) -> (String, String) {
        ("authorization".to_string(), format!("Bearer {token}"))
    }

    async fn call(app: Router, method: &str, uri: &str, token: &str, body: Option<Value>) -> axum::response::Response {
        let (hk, hv) = auth_header(token);
        let mut builder = Request::builder().method(method).uri(uri).header(hk, hv);
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
    async fn create_list_update_delete_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-tasks-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", Some("Task Tester"))
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        // create
        let res = call(
            app.clone(),
            "POST",
            "/api/tasks",
            &token,
            Some(json!({ "title": "First", "priority": 1, "start_date": "2026-01-05", "due_date": "2026-01-06" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        assert_eq!(created["title"], "First");
        assert_eq!(created["priority"], 1);
        assert_eq!(created["status"], "backlog");
        let task_id = created["id"].as_str().unwrap().to_string();

        // list
        let res = call(app.clone(), "GET", "/api/tasks", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let listed = body_json(res).await;
        assert!(listed.as_array().unwrap().iter().any(|t| t["id"] == task_id));

        // update (clear the start time slot explicitly)
        let res = call(
            app.clone(),
            "PATCH",
            &format!("/api/tasks/{task_id}"),
            &token,
            Some(json!({ "title": "Renamed", "status": "done" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let updated = body_json(res).await;
        assert_eq!(updated["title"], "Renamed");
        assert_eq!(updated["status"], "done");

        // delete (soft) then it disappears from the active list
        let since = Utc::now();
        let res = call(app.clone(), "DELETE", &format!("/api/tasks/{task_id}"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let res = call(app.clone(), "GET", "/api/tasks", &token, None).await;
        let listed = body_json(res).await;
        assert!(!listed.as_array().unwrap().iter().any(|t| t["id"] == task_id));

        // The tombstone must surface in the incremental (updated_since) feed so
        // other devices drop the task too: soft-delete has to bump updated_at,
        // not just deleted_at, or nothing past the cursor ever reports it.
        let since_iso = since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let res = call(
            app.clone(),
            "GET",
            &format!("/api/tasks?updated_since={since_iso}&include_deleted=true"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let changes = body_json(res).await;
        assert!(
            changes
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == task_id && t["deleted_at"].is_string()),
            "soft-deleted task must appear as a tombstone in the updated_since feed"
        );

        // trash lists it and restore brings it back
        let res = call(app.clone(), "GET", "/api/tasks/trash", &token, None).await;
        let trashed = body_json(res).await;
        assert!(trashed.as_array().unwrap().iter().any(|t| t["id"] == task_id));
        let res =
            call(app.clone(), "POST", &format!("/api/tasks/{task_id}/restore"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);

        // cleanup
        let _ = call(app.clone(), "DELETE", &format!("/api/tasks/{task_id}/permanent"), &token, None).await;
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn invalid_dates_are_rejected() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-tasks-invalid-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        let res = call(
            app,
            "POST",
            "/api/tasks",
            &token,
            Some(json!({ "title": "Bad", "due_date": "01/02/2026" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn subtask_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-subtasks-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        // parent task with a bulleted description
        let res = call(
            app.clone(),
            "POST",
            "/api/tasks",
            &token,
            Some(json!({ "title": "Parent", "description": "- one\n- two" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let parent_id = body_json(res).await["id"].as_str().unwrap().to_string();

        // create a subtask
        let res = call(
            app.clone(),
            "POST",
            &format!("/api/tasks/{parent_id}/subtasks"),
            &token,
            Some(json!({ "title": "Child A" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        assert_eq!(created["title"], "Child A");
        assert_eq!(created["status"], "todo");
        let child_id = created["id"].as_str().unwrap().to_string();

        // list
        let res = call(app.clone(), "GET", &format!("/api/tasks/{parent_id}/subtasks"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await.as_array().unwrap().len(), 1);

        // reorder
        let res = call(
            app.clone(),
            "POST",
            &format!("/api/tasks/{parent_id}/subtasks/reorder"),
            &token,
            Some(json!({ "ordered_ids": [child_id] })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        // collapse subtasks back into the description (hard-deletes the child)
        let res = call(
            app.clone(),
            "POST",
            &format!("/api/tasks/{parent_id}/subtasks-to-description"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["description"], "- Child A");
        let res = call(app.clone(), "GET", &format!("/api/tasks/{parent_id}/subtasks"), &token, None).await;
        assert_eq!(body_json(res).await.as_array().unwrap().len(), 0);

        // description -> subtasks (splits the "- Child A" bullet, clears description)
        let res = call(
            app.clone(),
            "POST",
            &format!("/api/tasks/{parent_id}/description-to-subtasks"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let converted = body_json(res).await;
        assert_eq!(converted["description"], Value::Null);
        assert_eq!(converted["subtasks"].as_array().unwrap().len(), 1);

        // breakdown with no description falls back to the generic list
        let res = call(app.clone(), "POST", &format!("/api/tasks/{parent_id}/breakdown"), &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["subtasks"].as_array().unwrap().len(), 5);

        // update + delete a subtask
        let res = call(app.clone(), "GET", &format!("/api/tasks/{parent_id}/subtasks"), &token, None).await;
        let all = body_json(res).await;
        let any_id = all.as_array().unwrap()[0]["id"].as_str().unwrap().to_string();
        let res = call(
            app.clone(),
            "PATCH",
            &format!("/api/tasks/{parent_id}/subtasks/{any_id}"),
            &token,
            Some(json!({ "status": "done" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "done");
        let res = call(
            app.clone(),
            "DELETE",
            &format!("/api/tasks/{parent_id}/subtasks/{any_id}"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "deleted");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn recurring_template_materializes_occurrences() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-recurring-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token =
            crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
                .unwrap();
        let app = router().with_state(state.clone());

        let today = chrono::Utc::now().date_naive();
        let res = call(
            app.clone(),
            "POST",
            "/api/tasks",
            &token,
            Some(json!({
                "title": "Daily standup",
                "start_date": today.to_string(),
                "recurrence_rule": "FREQ=DAILY",
            })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        let template_id = created["id"].as_str().unwrap().to_string();

        let children: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE parent_task_id = $1")
            .bind(Uuid::parse_str(&template_id).unwrap())
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert!(children > 0, "expected materialized occurrences, got {children}");

        // Re-running the sweep creates nothing new (idempotent) and reports 0.
        let res = call(
            app.clone(),
            "POST",
            "/api/tasks/expand-recurring",
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["expanded"], 0);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn purge_trash_deletes_old_rows_and_descendants() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-trash-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();

        let mut tx = state.pool.begin().await.unwrap();
        db::set_rls_user(&mut *tx, user.id, "").await.unwrap();

        // A parent trashed 30 days ago and a subtask under it (not itself old)
        // must both be purged, while a recently-trashed task survives.
        let old_parent: Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (user_id, title, status, priority, is_all_day, sort_order, is_archived, deleted_at) \
             VALUES ($1, 'old parent', 'backlog', 3, false, 0, false, now() - INTERVAL '30 days') RETURNING id",
        )
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let old_child: Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (user_id, title, parent_task_id, status, priority, is_all_day, sort_order, is_archived, deleted_at) \
             VALUES ($1, 'old child', $2, 'backlog', 3, false, 0, false, now() - INTERVAL '30 days') RETURNING id",
        )
        .bind(user.id)
        .bind(old_parent)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let recent: Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (user_id, title, status, priority, is_all_day, sort_order, is_archived, deleted_at) \
             VALUES ($1, 'recent trash', 'backlog', 3, false, 0, false, now() - INTERVAL '1 day') RETURNING id",
        )
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();

        let purged = purge_trash(&mut *tx, Some(user.id), TRASH_RETENTION_DAYS).await.unwrap();
        assert_eq!(purged, 2, "old parent + descendant must be purged");
        tx.commit().await.unwrap();

        let remaining: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM tasks WHERE user_id = $1")
            .bind(user.id)
            .fetch_all(&state.pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec![recent], "recent trash must survive");

        let _ = old_child;
        sqlx::query("DELETE FROM tasks WHERE user_id = $1").bind(user.id).execute(&state.pool).await.unwrap();
        sqlx::query("DELETE FROM users WHERE id = $1").bind(user.id).execute(&state.pool).await.unwrap();
    }

    /// One priority scale end-to-end: the API accepts only the 3 app tiers
    /// (1=high, 2=medium, 3=low), a create with no priority lands on the
    /// intended default (medium, 2), and a picked high survives the round trip.
    #[tokio::test]
    async fn priority_is_a_single_three_tier_scale_with_medium_default() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-prio-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        // No priority -> medium (2), matching the UI/timeline default.
        let res = call(app.clone(), "POST", "/api/tasks", &token, Some(json!({ "title": "Default" }))).await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        assert_eq!(created["priority"], 2);
        let default_id = created["id"].as_str().unwrap().to_string();

        // Explicit high (1) persists.
        let res = call(app.clone(), "POST", "/api/tasks", &token, Some(json!({ "title": "High", "priority": 1 }))).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["priority"], 1);

        // Out-of-scale values are rejected with the 3-tier message.
        let res = call(app.clone(), "POST", "/api/tasks", &token, Some(json!({ "title": "Bad", "priority": 5 }))).await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let err = body_json(res).await;
        assert_eq!(err["detail"], "Priority must be between 1 and 3");

        // The patch path normalizes into the same scale and rejects out-of-range.
        let res = call(
            app.clone(),
            "PATCH",
            &format!("/api/tasks/{default_id}"),
            &token,
            Some(json!({ "priority": 3 })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["priority"], 3);

        sqlx::query("DELETE FROM tasks WHERE user_id = $1").bind(user.id).execute(&state.pool).await.unwrap();
        sqlx::query("DELETE FROM users WHERE id = $1").bind(user.id).execute(&state.pool).await.unwrap();
    }
}
