//! Task model, serialization and shared query helpers.
//!
//! Mirrors the Python `models/task.py` + `services/task_service.py` semantics
//! that are user-visible: the `tasks` row shape, the `{"detail": ...}` error
//! contract, ISO date/time parsing and the priority/status coercions. Team
//! sharing (`task_shares`) is honoured on read/access queries via
//! [`access_condition`]; writes that mutate a task's parent, board section or
//! list stay owner-scoped. Recurring expansion and background embeddings live
//! elsewhere.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::error::ApiError;

/// Default list created on demand for a user with no explicit list.
pub const DEFAULT_LIST_NAME: &str = "My Tasks";

/// Valid task statuses, matching the Postgres `task_status` enum values.
pub const STATUSES: [&str; 5] = ["backlog", "todo", "in_progress", "done", "cancelled"];

/// Column projection shared by every task query. `status` is cast to text so it
/// maps to a `String` instead of a Postgres enum type.
pub const COLUMNS: &str = "id, user_id, parent_task_id, board_section_id, board_order, \
     title, description, status::text AS status, priority, start_date, due_date, \
     start_time, end_time, is_all_day, estimated_minutes, recurrence_rule, \
     recurrence_end_date, sort_order, is_archived, reminder_enabled, list_id, \
     deleted_at, completed_at, created_at, updated_at";

/// A row of the `tasks` table.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: Uuid,
    pub user_id: Uuid,
    pub parent_task_id: Option<Uuid>,
    pub board_section_id: Option<Uuid>,
    pub board_order: Option<i32>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: i16,
    pub start_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    pub start_time: Option<NaiveTime>,
    pub end_time: Option<NaiveTime>,
    pub is_all_day: bool,
    pub estimated_minutes: Option<i32>,
    pub recurrence_rule: Option<String>,
    pub recurrence_end_date: Option<NaiveDate>,
    pub sort_order: i32,
    pub is_archived: bool,
    pub reminder_enabled: bool,
    pub list_id: Option<Uuid>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

impl Task {
    /// Map a projected row (using [`COLUMNS`]) to a [`Task`].
    pub fn from_row(row: &PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            user_id: row.try_get("user_id")?,
            parent_task_id: row.try_get("parent_task_id")?,
            board_section_id: row.try_get("board_section_id")?,
            board_order: row.try_get("board_order")?,
            title: row.try_get("title")?,
            description: row.try_get("description")?,
            status: row.try_get("status")?,
            priority: row.try_get("priority")?,
            start_date: row.try_get("start_date")?,
            due_date: row.try_get("due_date")?,
            start_time: row.try_get("start_time")?,
            end_time: row.try_get("end_time")?,
            is_all_day: row.try_get("is_all_day")?,
            estimated_minutes: row.try_get("estimated_minutes")?,
            recurrence_rule: row.try_get("recurrence_rule")?,
            recurrence_end_date: row.try_get("recurrence_end_date")?,
            sort_order: row.try_get("sort_order")?,
            is_archived: row.try_get("is_archived")?,
            reminder_enabled: row.try_get("reminder_enabled")?,
            list_id: row.try_get("list_id")?,
            deleted_at: row.try_get("deleted_at")?,
            completed_at: row.try_get("completed_at")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

/// Serialize a task exactly like Python `_serialize_task` (dates ISO, times
/// `HH:MM`, uuids as strings, status as its enum value, tags attached).
pub fn task_json(task: &Task, tags: Option<&[serde_json::Value]>) -> serde_json::Value {
    serde_json::json!({
        "id": task.id.to_string(),
        "user_id": task.user_id.to_string(),
        "parent_task_id": task.parent_task_id.map(|u| u.to_string()),
        "board_section_id": task.board_section_id.map(|u| u.to_string()),
        "board_order": task.board_order,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "start_date": task.start_date.map(|d| d.to_string()),
        "due_date": task.due_date.map(|d| d.to_string()),
        "start_time": task.start_time.map(|t| t.format("%H:%M").to_string()),
        "end_time": task.end_time.map(|t| t.format("%H:%M").to_string()),
        "is_all_day": task.is_all_day,
        "estimated_minutes": task.estimated_minutes,
        "recurrence_rule": task.recurrence_rule,
        "recurrence_end_date": task.recurrence_end_date.map(|d| d.to_string()),
        "sort_order": task.sort_order,
        "is_archived": task.is_archived,
        "reminder_enabled": task.reminder_enabled,
        "list_id": task.list_id.map(|u| u.to_string()),
        "deleted_at": task.deleted_at.map(|dt| dt.to_rfc3339()),
        "completed_at": task.completed_at.map(|dt| dt.to_rfc3339()),
        "created_at": task.created_at.map(|dt| dt.to_rfc3339()),
        "updated_at": task.updated_at.map(|dt| dt.to_rfc3339()),
        "tags": tags.map(|t| t.to_vec()).unwrap_or_default(),
    })
}

/// Normalize a request priority to the 3 app tiers (1 high, 2 medium, 3 low).
pub fn normalize_priority(priority: Option<i64>) -> i16 {
    match priority {
        None => 2,
        Some(v) if v <= 0 => 2,
        Some(v) if v <= 1 => 1,
        Some(v) if v == 2 => 2,
        Some(_) => 3,
    }
}

/// Parse a `YYYY-MM-DD` date, returning `None` on malformed input.
pub fn parse_date(value: Option<&str>) -> Option<NaiveDate> {
    value.and_then(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok())
}

/// Parse an `HH:MM` (or `HH:MM:SS`) time, returning `None` on malformed input.
pub fn parse_time(value: Option<&str>) -> Option<NaiveTime> {
    let raw = value?;
    let normalized = if raw.len() == 5 { format!("{raw}:00") } else { raw.to_string() };
    NaiveTime::parse_from_str(&normalized, "%H:%M:%S")
        .or_else(|_| NaiveTime::parse_from_str(raw, "%H:%M"))
        .ok()
}

/// Whether a string is a valid task status.
pub fn valid_status(status: &str) -> bool {
    STATUSES.contains(&status)
}

/// The 422 message used when a status is invalid (matches Python ordering).
pub fn invalid_status_message() -> String {
    "Invalid status. Must be one of: backlog, cancelled, done, in_progress, todo".to_string()
}

/// Parse a path/query/body id, mapping malformed values to the Python 404.
pub fn require_uuid(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::NotFound("Invalid id".to_string()))
}

/// Validate that a task's date/time order is coherent (Python `validate_task_order`).
pub fn validate_order(
    start_date: Option<NaiveDate>,
    due_date: Option<NaiveDate>,
    start_time: Option<NaiveTime>,
    end_time: Option<NaiveTime>,
) -> Result<(), ApiError> {
    if let (Some(start), Some(due)) = (start_date, due_date) {
        if due < start {
            return Err(ApiError::Unprocessable(
                "End date must be on or after the start date".to_string(),
            ));
        }
    }
    if let (Some(start), Some(end)) = (start_time, end_time) {
        let same_day = match (start_date, due_date) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        };
        if same_day && end <= start {
            return Err(ApiError::Unprocessable(
                "End time must be after the start time".to_string(),
            ));
        }
    }
    Ok(())
}

/// Resolve (or lazily create) the user's default list.
pub async fn default_list_id(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM lists WHERE user_id = $1 AND name = $2 \
         ORDER BY position, created_at LIMIT 1",
    )
    .bind(user_id)
    .bind(DEFAULT_LIST_NAME)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let next: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM lists WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query_scalar(
        "INSERT INTO lists (user_id, name, position) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user_id)
    .bind(DEFAULT_LIST_NAME)
    .bind(next)
    .fetch_one(&mut *conn)
    .await
}

/// SQL predicate granting a user access to a task: their own tasks plus any
/// task shared with a team they belong to (Python `task_access_condition`).
/// `p` is the placeholder index the user id is bound to.
pub fn access_condition(p: usize) -> String {
    format!(
        "(user_id = ${p} OR id IN (SELECT ts.task_id FROM task_shares ts \
         JOIN team_members tm ON tm.team_id = ts.team_id WHERE tm.user_id = ${p}))"
    )
}

/// Fetch a task by id (honours team sharing); `include_trashed` also returns soft-deleted rows.
pub async fn find_task(
    conn: &mut PgConnection,
    id: Uuid,
    user_id: Uuid,
    include_trashed: bool,
) -> Result<Option<Task>, sqlx::Error> {
    let access = access_condition(2);
    let sql = if include_trashed {
        format!("SELECT {COLUMNS} FROM tasks WHERE id = $1 AND {access}")
    } else {
        format!("SELECT {COLUMNS} FROM tasks WHERE id = $1 AND {access} AND deleted_at IS NULL")
    };
    let row = sqlx::query(&sql)
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(Task::from_row).transpose()
}

/// Load `{task_id: [{id, name, color}]}` for the given tasks in one query.
pub async fn tags_for(
    conn: &mut PgConnection,
    task_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, Vec<serde_json::Value>>, sqlx::Error> {
    let mut map: BTreeMap<Uuid, Vec<serde_json::Value>> = BTreeMap::new();
    if task_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT tt.task_id, t.id, t.name, t.color FROM task_tags tt \
         JOIN tags t ON t.id = tt.tag_id WHERE tt.task_id = ANY($1)",
    )
    .bind(task_ids)
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        let task_id: Uuid = row.try_get("task_id")?;
        let id: Uuid = row.try_get("id")?;
        let name: String = row.try_get("name")?;
        let color: Option<String> = row.try_get("color")?;
        map.entry(task_id)
            .or_default()
            .push(serde_json::json!({ "id": id.to_string(), "name": name, "color": color }));
    }
    Ok(map)
}

/// Search tasks by similarity, falling back to a substring match when the
/// `pg_trgm` extension/operators are unavailable (Python `search_tasks`).
///
/// Parity with the Python reference: the query is lowercased and trimmed, the
/// rank is the greatest similarity across `lower(title)`,
/// `lower(coalesce(description, ''))` and the best matching tag name, the `%`
/// operator gates title/description/tag-name matches, and results come back
/// ordered by descending rank. The fallback path is a bound-parameter ILIKE
/// over title/description/tag-name with rank `0.0` (never a SQL `concat`, so the
/// same SQL is safe on every dialect), sorted by rank descending.
pub async fn search_tasks(
    conn: &mut PgConnection,
    user_id: Uuid,
    query: &str,
    limit: i64,
) -> Result<Vec<(Task, f64)>, sqlx::Error> {
    let q_lower = query.trim().to_lowercase();
    if q_lower.is_empty() {
        return Ok(Vec::new());
    }

    let trgm_access = access_condition(2);
    let trgm_sql = format!(
        "SELECT {COLUMNS}, GREATEST( \
             similarity(lower(title), $1), \
             similarity(lower(coalesce(description, '')), $1), \
             COALESCE((SELECT MAX(similarity(lower(tg.name), $1)) FROM task_tags tt \
                 JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = tasks.id), 0) \
         )::float8 AS rank FROM tasks \
         WHERE {trgm_access} AND deleted_at IS NULL AND ( \
             lower(title) % $1 \
             OR lower(coalesce(description, '')) % $1 \
             OR id IN (SELECT tt.task_id FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id \
                 WHERE lower(tg.name) % $1) \
         ) \
         ORDER BY rank DESC LIMIT $3"
    );
    let trgm = sqlx::query(&trgm_sql)
        .bind(&q_lower)
        .bind(user_id)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await
        .and_then(|rows| {
            rows.iter()
                .map(|row| {
                    let task = Task::from_row(row)?;
                    let rank: f64 = row.try_get("rank")?;
                    Ok((task, rank))
                })
                .collect::<Result<Vec<(Task, f64)>, sqlx::Error>>()
        });
    if let Ok(mut ranked) = trgm {
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        return Ok(ranked);
    }

    let like_access = access_condition(1);
    let like_sql = format!(
        "SELECT {COLUMNS}, 0.0::float8 AS rank FROM tasks \
         WHERE {like_access} AND deleted_at IS NULL AND ( \
             title ILIKE $2 \
             OR description ILIKE $2 \
             OR id IN (SELECT tt.task_id FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id \
                 WHERE tg.name ILIKE $2) \
         ) \
         ORDER BY created_at DESC LIMIT $3"
    );
    let pattern = format!("%{query}%");
    let rows = sqlx::query(&like_sql)
        .bind(user_id)
        .bind(&pattern)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    let mut ranked: Vec<(Task, f64)> = rows
        .iter()
        .map(|row| {
            let task = Task::from_row(row)?;
            let rank: f64 = row.try_get("rank")?;
            Ok((task, rank))
        })
        .collect::<Result<_, sqlx::Error>>()?;
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(ranked)
}

/// Move tasks into a board section (or a status bucket), renumbering the
/// sibling `board_order`. Returns the number of moved tasks.
pub async fn move_tasks_to_section(
    conn: &mut PgConnection,
    user_id: Uuid,
    task_ids: &[Uuid],
    section_id: Option<Uuid>,
    section_status: Option<&str>,
    index: i64,
) -> Result<u64, sqlx::Error> {
    // Dedupe while preserving order.
    let mut seen = HashSet::new();
    let moved: Vec<Uuid> = task_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    if moved.is_empty() {
        return Ok(0);
    }

    let access = access_condition(1);
    // Sibling rows currently in the destination bucket, in display order.
    let sibling_sql = if section_id.is_none() {
        format!(
            "SELECT id FROM tasks WHERE {access} AND deleted_at IS NULL \
             AND board_section_id IS NULL AND NOT (id = ANY($2)) \
             ORDER BY board_order ASC NULLS LAST, created_at ASC"
        )
    } else if let Some(status) = section_status {
        let _ = status;
        format!(
            "SELECT id FROM tasks WHERE {access} AND deleted_at IS NULL \
             AND status = $3::task_status AND board_section_id IS NULL AND NOT (id = ANY($2)) \
             ORDER BY board_order ASC NULLS LAST, created_at ASC"
        )
    } else {
        format!(
            "SELECT id FROM tasks WHERE {access} AND deleted_at IS NULL \
             AND board_section_id = $3 AND NOT (id = ANY($2)) \
             ORDER BY board_order ASC NULLS LAST, created_at ASC"
        )
    };
    let mut q = sqlx::query(&sibling_sql).bind(user_id).bind(&moved);
    if section_id.is_none() {
        // no extra bind
    } else if let Some(status) = section_status {
        q = q.bind(status);
    } else {
        q = q.bind(section_id);
    }
    let sibling_rows = q.fetch_all(&mut *conn).await?;
    let mut order: Vec<Uuid> = sibling_rows
        .iter()
        .map(|r| r.try_get::<Uuid, _>("id"))
        .collect::<Result<_, _>>()?;

    let clamped = index.clamp(0, order.len() as i64) as usize;
    order.splice(clamped..clamped, moved.iter().copied());

    // Apply the destination bucket to the moved rows, then renumber everyone.
    if let Some(status) = section_status {
        sqlx::query(&format!(
            "UPDATE tasks SET board_section_id = NULL, status = $3::task_status, updated_at = now() \
             WHERE {access} AND id = ANY($2)"
        ))
        .bind(user_id)
        .bind(&moved)
        .bind(status)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(&format!(
            "UPDATE tasks SET board_section_id = $3, updated_at = now() WHERE {access} AND id = ANY($2)"
        ))
        .bind(user_id)
        .bind(&moved)
        .bind(section_id)
        .execute(&mut *conn)
        .await?;
    }

    for (position, id) in order.iter().enumerate() {
        sqlx::query("UPDATE tasks SET board_order = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(position as i32)
            .execute(&mut *conn)
            .await?;
    }

    Ok(moved.len() as u64)
}
