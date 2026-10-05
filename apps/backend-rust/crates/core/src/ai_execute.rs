//! Tool execution engine for the in-app AI agent.
//!
//! Mirrors the Python `execute_tool_calls` in `app/services/ai_service.py`: it
//! takes the `tool_calls` the model returned, executes each core tool against
//! the database under the caller's RLS identity, and returns the `role: "tool"`
//! messages to feed back to the model. Payload shapes match the Python backend
//! so the agent behaves identically after the Rust cutover.
//!
//! This unit covers the 47 CORE tools (tasks, tags, lists, subtasks, watchlist
//! and habits). EE tools (finance, countdown, quadrant, focus, GitHub, Slack,
//! workflow, OpenClaw) are registered elsewhere and are out of scope here.

use axum::http::HeaderMap;
use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, QueryBuilder, Row};
use uuid::Uuid;

use crate::board_sections;
use crate::error::ApiError;
use crate::task::{self, Task, COLUMNS};
use crate::{db, habits, tags, tasks, watchlist, AppState};

/// Cap on how many search-result tasks are handed to the model in one result.
pub(crate) const TOOL_SEARCH_MAX: i64 = 250;
/// Cap on the serialized length of a single tool result.
pub(crate) const TOOL_RESULT_MAX_CHARS: usize = 12000;
/// Headroom for the truncation marker fields.
pub(crate) const TOOL_LIST_BUDGET: usize = TOOL_RESULT_MAX_CHARS - 400;
/// Hard cap on tool calls executed per round.
pub(crate) const MAX_TOOL_CALLS_PER_ROUND: usize = 20;

const INBOX_ALIASES: [&str; 5] = ["inbox", "unscheduled", "no date", "no dates", "someday"];

const GENERIC_SUGGESTIONS: [&str; 5] = [
    "Define scope and requirements",
    "Break down into smaller steps",
    "Set milestones and deadlines",
    "Assign resources",
    "Track progress and adjust",
];

pub type ToolResult = Result<Vec<String>, ApiError>;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Execute a round of core tool calls, returning one `role: "tool"` message per
/// executed call (some tools emit more than one). Content is always a JSON
/// string, matching the Python backend.
#[allow(dead_code)]
pub(crate) async fn execute_tool_calls(
    state: &AppState,
    user_id: Uuid,
    tool_calls: &[Value],
) -> Vec<Value> {
    execute_tool_calls_outcome(state, user_id, tool_calls).await.0
}

/// Outcome-aware variant of [`execute_tool_calls`]. The returned bool is true
/// when at least one mutating tool call actually committed (a payload with no
/// `error`), so the turn runner can tell a real side effect from a failed call
/// that the model might still narrate as success. Each successful mutation also
/// publishes the per-user change event an HTTP mutation would, so `GET
/// /api/events` fans it out to the same tab, other tabs and other devices.
pub(crate) async fn execute_tool_calls_outcome(
    state: &AppState,
    user_id: Uuid,
    tool_calls: &[Value],
) -> (Vec<Value>, bool) {
    let truncated = tool_calls.len() > MAX_TOOL_CALLS_PER_ROUND;
    let calls = if truncated {
        &tool_calls[..MAX_TOOL_CALLS_PER_ROUND]
    } else {
        tool_calls
    };

    let mut results: Vec<Value> = Vec::new();
    let mut action_succeeded = false;
    let ee_names = crate::ai_tools::ee_tool_names();

    for tc in calls {
        let call_id = tc.get("id").cloned().unwrap_or(Value::Null);
        let fn_obj = tc.get("function");
        let name = fn_obj
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        let args_raw = fn_obj
            .and_then(|f| f.get("arguments"))
            .and_then(|a| a.as_str())
            .unwrap_or("{}");
        let args: Value = match serde_json::from_str::<Value>(args_raw) {
            Ok(v) if v.is_object() => v,
            Ok(_) => {
                // Python calls `args.get(...)` on the parsed value; a non-dict
                // raises and is reported as a generic handler failure.
                let payload = obj_str(&json!({
                    "error": format!("The operation failed (tool: {name})"),
                    "retryable": false,
                }));
                results.push(tool_message(call_id, Value::String(payload)));
                continue;
            }
            Err(_) => {
                results.push(tool_message(
                    call_id,
                    Value::String("Invalid arguments".to_string()),
                ));
                continue;
            }
        };

        let resource = crate::ai_tools::mutation_resource(name);
        // Core mutating tools are mapped precisely; EE mutating tools are not
        // known to core, so an EE tool name counts as a write too. Read-only
        // EE tools still publish a harmless generic refresh signal.
        let is_write = resource.is_some() || ee_names.iter().any(|n| n == name);
        match dispatch(state, user_id, name, &args).await {
            Ok(payloads) => {
                let committed = payloads.iter().any(|p| !payload_is_error(p));
                if committed {
                    if let Some(res) = resource {
                        state.events.publish(user_id, res);
                    } else if is_write {
                        // EE tools are mapped by the extension crate; a generic
                        // signal still lets the client refresh every view.
                        state.events.publish(user_id, "sync");
                    }
                }
                if committed && is_write {
                    action_succeeded = true;
                }
                for payload in payloads {
                    results.push(tool_message(call_id.clone(), Value::String(payload)));
                }
            }
            Err(err) => {
                tracing::warn!(tool = name, error = %err, "tool call failed");
                let payload = obj_str(&json!({
                    "error": format!("The operation failed (tool: {name})"),
                    "retryable": false,
                }));
                results.push(tool_message(call_id, Value::String(payload)));
            }
        }
    }

    for r in &mut results {
        if let Some(Value::String(s)) = r.get_mut("content") {
            if s.chars().count() > TOOL_RESULT_MAX_CHARS {
                let cut: String = s.chars().take(TOOL_RESULT_MAX_CHARS).collect();
                *s = format!("{cut}\n...(truncated)");
            }
        }
    }

    if truncated {
        let last_id = calls
            .last()
            .and_then(|c| c.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        let payload = obj_str(&json!({
            "error": format!(
                "Tool-call cap reached ({MAX_TOOL_CALLS_PER_ROUND}). Stop calling tools now and summarize what was done for the user. No further tool calls were executed."
            ),
            "retryable": false,
        }));
        results.push(tool_message(last_id, Value::String(payload)));
    }

    (results, action_succeeded)
}

/// True when a tool result payload carries a non-null `error` field. Non-JSON
/// payloads (the "Invalid arguments" fallback) count as failures.
fn payload_is_error(payload: &str) -> bool {
    match serde_json::from_str::<Value>(payload) {
        Ok(Value::Object(obj)) => obj.get("error").map(|e| !e.is_null()).unwrap_or(false),
        _ => true,
    }
}

fn tool_message(call_id: Value, content: Value) -> Value {
    json!({ "tool_call_id": call_id, "role": "tool", "content": content })
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async fn dispatch(state: &AppState, user_id: Uuid, name: &str, args: &Value) -> ToolResult {
    match name {
        "search_tasks" => tool_search_tasks(state, user_id, args).await,
        "create_task" => tool_create_task(state, user_id, args).await,
        "update_task" => tool_update_task(state, user_id, args).await,
        "delete_task" => tool_delete_task(state, user_id, args).await,
        "batch_delete_tasks" => tool_batch_delete_tasks(state, user_id, args).await,
        "delete_matching_tasks" => tool_delete_matching_tasks(state, user_id, args).await,
        "get_task_details" => tool_get_task_details(state, user_id, args).await,
        "link_tasks" => tool_link_tasks(state, user_id, args).await,
        "check_calendar" => tool_check_calendar(state, user_id, args).await,
        "suggest_subtasks" => tool_suggest_subtasks(state, user_id, args).await,
        "detect_conflicts" => tool_detect_conflicts(state, user_id, args).await,
        "reschedule_task" => tool_reschedule_task(state, user_id, args).await,
        "list_tasks_by_date_range" => tool_list_tasks_by_date_range(state, user_id, args).await,
        "suggest_best_time" => tool_suggest_best_time(state, user_id, args).await,
        "get_upcoming_deadlines" => tool_get_upcoming_deadlines(state, user_id, args).await,
        "batch_create_tasks" => tool_batch_create_tasks(state, user_id, args).await,
        "add_event" => tool_add_event(state, user_id, args).await,
        "cancel_task_by_keywords" => tool_cancel_task_by_keywords(state, user_id, args).await,
        "get_subtasks" => tool_get_subtasks(state, user_id, args).await,
        "create_subtask" => tool_create_subtask(state, user_id, args).await,
        "update_subtask" => tool_update_subtask(state, user_id, args).await,
        "delete_subtask" => tool_delete_subtask(state, user_id, args).await,
        "reorder_subtasks" => tool_reorder_subtasks(state, user_id, args).await,
        "convert_description_to_subtasks" => {
            tool_convert_description_to_subtasks(state, user_id, args).await
        }
        "convert_subtasks_to_description" => {
            tool_convert_subtasks_to_description(state, user_id, args).await
        }
        "complete_task" => tool_complete_task(state, user_id, args).await,
        "duplicate_task" => tool_duplicate_task(state, user_id, args).await,
        "list_tags" => tool_list_tags(state, user_id).await,
        "add_tag_to_task" => tool_add_tag_to_task(state, user_id, args).await,
        "get_task_stats" => tool_get_task_stats(state, user_id).await,
        "restore_task" => tool_restore_task(state, user_id, args).await,
        "create_list" => tool_create_list(state, user_id, args).await,
        "list_lists" => tool_list_lists(state, user_id).await,
        "rename_list" => tool_rename_list(state, user_id, args).await,
        "delete_list" => tool_delete_list(state, user_id, args).await,
        "organize_timeline_into_sections" => {
            let force = arg_bool(args, "force");
            let provider = arg_str(args, "provider").map(|s| s.to_string());
            let explicit_id = arg_str(args, "list_id")
                .filter(|s| !s.is_empty())
                .and_then(|s| Uuid::parse_str(s).ok());
            // Scope resolution: an explicit list_id wins, then a `list_name`,
            // else None which organizes EVERY dated task (the unfiltered
            // timeline). A named list organizes only that list's own scope.
            let list_id = if explicit_id.is_some() {
                explicit_id
            } else if let Some(name) = arg_str(args, "list_name").filter(|s| !s.trim().is_empty()) {
                let mut tx = begin(state, user_id).await?;
                let resolved = resolve_list_id_by_name(&mut *tx, user_id, name)
                    .await
                    .map_err(db_err)?;
                tx.commit().await.map_err(db_err)?;
                resolved
            } else {
                None
            };
            match board_sections::svc_organize_timeline(
                state,
                user_id,
                provider,
                force,
                list_id,
                &HeaderMap::new(),
            )
            .await
            {
                Ok(value) => ok1(obj_str(&value)),
                Err(err) => Err(err),
            }
        }
        "search_titles" => tool_search_titles(state, args).await,
        "list_watchlist" => tool_list_watchlist(state, user_id, args).await,
        "add_watchlist_item" => tool_add_watchlist_item(state, user_id, args).await,
        "update_watchlist_item" => tool_update_watchlist_item(state, user_id, args).await,
        "remove_watchlist_item" => tool_remove_watchlist_item(state, user_id, args).await,
        "list_habits" => tool_list_habits(state, user_id).await,
        "create_habit" => tool_create_habit(state, user_id, args).await,
        "update_habit" => tool_update_habit(state, user_id, args).await,
        "delete_habit" => tool_delete_habit(state, user_id, args).await,
        "toggle_habit_log" => tool_toggle_habit_log(state, user_id, args).await,
        "get_habit_logs" => tool_get_habit_logs(state, user_id, args).await,
        _ => {
            if let Some(result) = crate::ai_tools::ee_dispatch(state, user_id, name, args).await {
                return result;
            }
            ok1(obj_str(&json!({
                "error": format!("Unknown tool: {name} (If you still have trouble, please open a new chat.)"),
            })))
        }
    }
}

// ---------------------------------------------------------------------------
// Small argument/format helpers
// ---------------------------------------------------------------------------

fn obj_str(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string())
}

fn ok1(payload: String) -> ToolResult {
    Ok(vec![payload])
}

fn ok_obj(v: Value) -> ToolResult {
    ok1(obj_str(&v))
}

fn db_err(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

async fn begin(
    state: &AppState,
    user_id: Uuid,
) -> Result<sqlx::Transaction<'_, sqlx::Postgres>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_err)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_err)?;
    Ok(tx)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

/// Parse a `YYYY-MM-DD` date argument, returning `None` on junk.
fn parse_date_arg(value: Option<&str>) -> Option<NaiveDate> {
    task::parse_date(value)
}

/// Tolerantly parse a clock time: "14:00", "14:00:00", "2pm" -> 14:00, "9" -> 09:00.
fn parse_time_arg(value: Option<&str>) -> Option<NaiveTime> {
    let raw = value?;
    let compact: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| *c != ' ')
        .collect();
    if compact.is_empty() {
        return None;
    }
    let re = regex::Regex::new(r"^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(am|pm)?$").ok()?;
    let caps = re.captures(&compact)?;
    let mut hour: u32 = caps.get(1)?.as_str().parse().ok()?;
    let minute: u32 = caps.get(2).map(|m| m.as_str().parse().ok()).unwrap_or(Some(0))?;
    let second: u32 = caps.get(3).map(|m| m.as_str().parse().ok()).unwrap_or(Some(0))?;
    let ampm = caps.get(4).map(|m| m.as_str());
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    if let Some(ap) = ampm {
        if hour < 1 || hour > 12 {
            return None;
        }
        if ap == "pm" && hour != 12 {
            hour += 12;
        } else if ap == "am" && hour == 12 {
            hour = 0;
        }
    }
    NaiveTime::from_hms_opt(hour, minute, second)
}

/// Tolerantly parse a task/list id: whitespace and hyphens are stripped and the
/// remaining 32 hex chars must form a valid UUID.
fn safe_uuid(value: &Value) -> Option<Uuid> {
    if value.is_null() {
        return None;
    }
    let raw = match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    safe_uuid_str(&raw)
}

fn safe_uuid_str(raw: &str) -> Option<Uuid> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if compact.len() != 32 {
        return None;
    }
    Uuid::parse_str(&compact).ok()
}

fn is_inbox_alias(name: Option<&str>) -> bool {
    match name {
        Some(n) => {
            let t = n.trim().to_lowercase();
            !t.is_empty() && INBOX_ALIASES.contains(&t.as_str())
        }
        None => false,
    }
}

fn desc_snippet(desc: Option<&str>) -> Value {
    let s: String = desc.unwrap_or("").chars().take(160).collect();
    if s.is_empty() {
        Value::Null
    } else {
        Value::String(s)
    }
}

/// Serialize a payload embedding a list, trimming whole entries so it always
/// fits the budget and stays valid JSON. Adds `truncated`/`omitted` when cut.
fn bounded_list_payload(
    fields: Map<String, Value>,
    list_key: &str,
    items: Vec<Value>,
    budget: usize,
) -> String {
    let mut full = fields.clone();
    full.insert(list_key.to_string(), Value::Array(items.clone()));
    let serialized = serde_json::to_string(&Value::Object(full)).unwrap_or_default();
    if serialized.len() <= budget {
        return serialized;
    }

    let mut base = fields;
    base.remove(list_key);
    let mut empty = base.clone();
    empty.insert(list_key.to_string(), Value::Array(vec![]));
    let mut used = serde_json::to_string(&Value::Object(empty))
        .map(|s| s.len())
        .unwrap_or(0);

    let mut kept: Vec<Value> = Vec::new();
    for item in &items {
        let item_size = serde_json::to_string(item).map(|s| s.len()).unwrap_or(0) + 2;
        if used + item_size > budget {
            break;
        }
        kept.push(item.clone());
        used += item_size;
    }

    let omitted = items.len() - kept.len();
    let mut trimmed = base;
    trimmed.insert(list_key.to_string(), Value::Array(kept));
    trimmed.insert("truncated".to_string(), Value::Bool(true));
    trimmed.insert("omitted".to_string(), json!(omitted));
    serde_json::to_string(&Value::Object(trimmed)).unwrap_or_default()
}

async fn resolve_list_id_by_name(
    conn: &mut PgConnection,
    user_id: Uuid,
    name: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let needle = name.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(None);
    }
    let rows = sqlx::query("SELECT id, name FROM lists WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&mut *conn)
        .await?;
    let mut substring: Option<Uuid> = None;
    for row in &rows {
        let id: Uuid = row.try_get("id")?;
        let n: String = row.try_get("name")?;
        let normalized = n.trim().to_lowercase();
        if normalized == needle {
            return Ok(Some(id));
        }
        if substring.is_none() && normalized.contains(&needle) {
            substring = Some(id);
        }
    }
    Ok(substring)
}

/// Push the shared search scope filters onto a query builder.
fn push_scope(
    qb: &mut QueryBuilder<'_, sqlx::Postgres>,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
    priority_min: Option<i64>,
    priority_max: Option<i64>,
    resolved_list: Option<Uuid>,
    undated: bool,
    include_subtasks: bool,
) {
    if let Some(df) = date_from {
        qb.push(" AND start_date >= ").push_bind(df);
    }
    if let Some(dt) = date_to {
        qb.push(" AND start_date <= ").push_bind(dt);
    }
    if let Some(m) = priority_min {
        qb.push(" AND priority >= ").push_bind(m);
    }
    if let Some(m) = priority_max {
        qb.push(" AND priority <= ").push_bind(m);
    }
    if let Some(l) = resolved_list {
        qb.push(" AND list_id = ").push_bind(l);
    }
    if undated {
        qb.push(" AND start_date IS NULL AND due_date IS NULL");
    }
    if !include_subtasks {
        qb.push(" AND parent_task_id IS NULL");
    }
}

/// Select the user's live tasks matching a scope, mirroring Python
/// `_scoped_tasks`. Returns the tasks, any unmatched list name and whether the
/// undated (Inbox) filter was applied.
#[allow(clippy::too_many_arguments)]
async fn scoped_tasks(
    conn: &mut PgConnection,
    user_id: Uuid,
    query: Option<&str>,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
    list_id: Option<&str>,
    list_name: Option<&str>,
    undated: bool,
    limit: i64,
    include_subtasks: bool,
) -> Result<(Vec<Task>, Option<String>, bool), sqlx::Error> {
    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("SELECT ");
    qb.push(COLUMNS);
    qb.push(" FROM tasks WHERE user_id = ").push_bind(user_id);
    qb.push(" AND deleted_at IS NULL");
    if !include_subtasks {
        qb.push(" AND parent_task_id IS NULL");
    }
    let needle = query.map(|q| q.trim().to_string()).unwrap_or_default();
    if !needle.is_empty() {
        let like = format!("%{needle}%");
        qb.push(" AND (title ILIKE ").push_bind(like.clone());
        qb.push(" OR description ILIKE ").push_bind(like).push(")");
    }
    if date_from.is_some() || date_to.is_some() {
        let start = date_from.or(date_to);
        let end = date_to.or(date_from);
        qb.push(" AND (");
        qb.push("(start_date >= ")
            .push_bind(start)
            .push(" AND start_date <= ")
            .push_bind(end)
            .push(")");
        qb.push(" OR (due_date >= ")
            .push_bind(start)
            .push(" AND due_date <= ")
            .push_bind(end)
            .push(")");
        qb.push(" OR (start_date <= ")
            .push_bind(start)
            .push(" AND due_date >= ")
            .push_bind(end)
            .push(")");
        qb.push(")");
    }

    let mut resolved = list_id.and_then(safe_uuid_str);
    let mut unmatched_name: Option<String> = None;
    if resolved.is_none() {
        if let Some(lname) = list_name {
            if !lname.is_empty() {
                resolved = resolve_list_id_by_name(&mut *conn, user_id, lname).await?;
                if resolved.is_none() {
                    unmatched_name = Some(lname.to_string());
                }
            }
        }
    }
    let mut applied_undated = false;
    if let Some(lid) = resolved {
        qb.push(" AND list_id = ").push_bind(lid);
    } else if undated || is_inbox_alias(unmatched_name.as_deref()) {
        qb.push(" AND start_date IS NULL AND due_date IS NULL");
        applied_undated = true;
        unmatched_name = None;
    }

    qb.push(" ORDER BY created_at DESC, id DESC LIMIT ")
        .push_bind(limit);
    let rows = qb.build().fetch_all(&mut *conn).await?;
    let tasks = rows
        .iter()
        .map(Task::from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((tasks, unmatched_name, applied_undated))
}

/// Soft-delete the given roots and their descendants (recursive), returning the
/// number of rows affected.
async fn soft_delete_ids(
    conn: &mut PgConnection,
    user_id: Uuid,
    ids: &[Uuid],
) -> Result<u64, sqlx::Error> {
    if ids.is_empty() {
        return Ok(0);
    }
    let sql = "WITH RECURSIVE tree AS ( \
                 SELECT id FROM tasks WHERE user_id = $1 AND id = ANY($2) \
                 UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id \
               ) UPDATE tasks SET deleted_at = now(), updated_at = now() \
               WHERE id IN (SELECT id FROM tree)";
    let result = sqlx::query(sql)
        .bind(user_id)
        .bind(ids)
        .execute(&mut *conn)
        .await?;
    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

async fn tool_search_tasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let query = arg_str(args, "query").unwrap_or("").to_string();
    let date_from = arg_str(args, "date_from");
    let date_to = arg_str(args, "date_to");
    let priority_min = arg_i64(args, "priority_min");
    let priority_max = arg_i64(args, "priority_max");
    let list_arg = arg_str(args, "list_id");
    let list_name = arg_str(args, "list_name");
    let mut undated = arg_bool(args, "undated");
    let include_subtasks = arg_bool(args, "include_subtasks");
    let q_lower = query.trim().to_lowercase();

    let found_tasks: Vec<Task> = if q_lower.is_empty() {
        let mut tx = begin(state, user_id).await?;
        let (scoped, _unmatched, _applied) = scoped_tasks(
            &mut *tx,
            user_id,
            None,
            parse_date_arg(date_from),
            parse_date_arg(date_to),
            list_arg,
            list_name,
            undated,
            TOOL_SEARCH_MAX,
            include_subtasks,
        )
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        scoped
            .into_iter()
            .filter(|t| {
                priority_min.map_or(true, |m| (t.priority as i64) >= m)
                    && priority_max.map_or(true, |m| (t.priority as i64) <= m)
            })
            .collect()
    } else {
        let mut resolved_list = list_arg.and_then(safe_uuid_str);
        let mut tx = begin(state, user_id).await?;
        if resolved_list.is_none() {
            if let Some(lname) = list_name {
                resolved_list = resolve_list_id_by_name(&mut *tx, user_id, lname)
                    .await
                    .map_err(db_err)?;
                if resolved_list.is_none() && is_inbox_alias(Some(lname)) {
                    undated = true;
                }
            }
        }
        match ranked_search(
            &mut *tx,
            user_id,
            &q_lower,
            parse_date_arg(date_from),
            parse_date_arg(date_to),
            priority_min,
            priority_max,
            resolved_list,
            undated,
            include_subtasks,
        )
        .await
        {
            Ok(rows) => {
                tx.commit().await.map_err(db_err)?;
                rows
            }
            Err(_) => {
                // A failed pg_trgm statement aborts the transaction, so the
                // SQLite/LIKE fallback must run on a fresh one.
                tx.rollback().await.ok();
                let mut tx2 = begin(state, user_id).await?;
                let rows = ilike_search(
                    &mut *tx2,
                    user_id,
                    &query,
                    parse_date_arg(date_from),
                    parse_date_arg(date_to),
                    priority_min,
                    priority_max,
                    resolved_list,
                    undated,
                    include_subtasks,
                )
                .await
                .map_err(db_err)?;
                tx2.commit().await.map_err(db_err)?;
                rows
            }
        }
    };

    let found: Vec<Value> = found_tasks
        .iter()
        .map(|t| {
            json!({
                "id": t.id.to_string(),
                "title": t.title,
                "status": t.status,
                "priority": t.priority,
                "start_date": t.start_date.map(|d| d.to_string()),
                "due_date": t.due_date.map(|d| d.to_string()),
                "description": desc_snippet(t.description.as_deref()),
            })
        })
        .collect();
    let mut fields = Map::new();
    fields.insert("found".to_string(), json!(found.len()));
    ok1(bounded_list_payload(fields, "tasks", found, TOOL_LIST_BUDGET))
}

#[allow(clippy::too_many_arguments)]
async fn ranked_search(
    conn: &mut PgConnection,
    user_id: Uuid,
    q_lower: &str,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
    priority_min: Option<i64>,
    priority_max: Option<i64>,
    resolved_list: Option<Uuid>,
    undated: bool,
    include_subtasks: bool,
) -> Result<Vec<Task>, sqlx::Error> {
    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("SELECT ");
    qb.push(COLUMNS);
    qb.push(" FROM tasks WHERE user_id = ").push_bind(user_id);
    qb.push(" AND deleted_at IS NULL AND (lower(title) % ")
        .push_bind(q_lower);
    qb.push(" OR lower(coalesce(description, '')) % ")
        .push_bind(q_lower)
        .push(")");
    push_scope(
        &mut qb,
        date_from,
        date_to,
        priority_min,
        priority_max,
        resolved_list,
        undated,
        include_subtasks,
    );
    qb.push(" ORDER BY GREATEST(similarity(lower(title), ")
        .push_bind(q_lower);
    qb.push("), similarity(lower(coalesce(description, '')), ")
        .push_bind(q_lower);
    qb.push(")) DESC LIMIT ").push_bind(TOOL_SEARCH_MAX);
    let rows = qb.build().fetch_all(&mut *conn).await?;
    rows.iter().map(Task::from_row).collect()
}

#[allow(clippy::too_many_arguments)]
async fn ilike_search(
    conn: &mut PgConnection,
    user_id: Uuid,
    query: &str,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
    priority_min: Option<i64>,
    priority_max: Option<i64>,
    resolved_list: Option<Uuid>,
    undated: bool,
    include_subtasks: bool,
) -> Result<Vec<Task>, sqlx::Error> {
    let like = format!("%{query}%");
    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("SELECT ");
    qb.push(COLUMNS);
    qb.push(" FROM tasks WHERE user_id = ").push_bind(user_id);
    qb.push(" AND deleted_at IS NULL AND (title ILIKE ")
        .push_bind(like.clone());
    qb.push(" OR description ILIKE ").push_bind(like).push(")");
    push_scope(
        &mut qb,
        date_from,
        date_to,
        priority_min,
        priority_max,
        resolved_list,
        undated,
        include_subtasks,
    );
    qb.push(" LIMIT ").push_bind(TOOL_SEARCH_MAX);
    let rows = qb.build().fetch_all(&mut *conn).await?;
    rows.iter().map(Task::from_row).collect()
}

/// Normalize a date argument to `YYYY-MM-DD`, dropping junk. The create service
/// validates strictly, so a stray "tomorrow" must not abort the whole insert
/// (Python's `_parse_date` returned None for the same reason).
fn norm_date_arg(args: &Value, key: &str) -> Option<String> {
    parse_date_arg(arg_str(args, key)).map(|d| d.format("%Y-%m-%d").to_string())
}

/// Normalize a clock argument to `HH:MM:SS`, accepting convenience forms
/// ("2pm", "14:00", "9"). The model is told HH:MM, but it often emits "2pm";
/// passing that straight to the strict service 422s and drops the whole task.
fn norm_time_arg(args: &Value, key: &str) -> Option<String> {
    parse_time_arg(arg_str(args, key)).map(|t| t.format("%H:%M:%S").to_string())
}

fn build_create_request(
    args: &Value,
    title: &str,
    forced_priority: Option<i64>,
) -> tasks::CreateTaskRequest {
    let priority = forced_priority.or_else(|| arg_i64(args, "priority")).unwrap_or(2);
    tasks::CreateTaskRequest {
        title: title.to_string(),
        parent_task_id: None,
        board_section_id: None,
        description: arg_str(args, "description").map(|s| s.to_string()),
        status: "backlog".to_string(),
        priority: task::normalize_priority(Some(priority)) as i64,
        start_date: norm_date_arg(args, "start_date"),
        due_date: norm_date_arg(args, "due_date"),
        start_time: norm_time_arg(args, "start_time"),
        end_time: norm_time_arg(args, "end_time"),
        recurrence_rule: arg_str(args, "recurrence_rule").map(|s| s.to_string()),
        recurrence_end_date: norm_date_arg(args, "recurrence_end_date"),
        estimated_minutes: arg_i64(args, "estimated_minutes").map(|v| v as i32),
        tag_ids: None,
        list_id: args.get("list_id").and_then(safe_uuid),
        reminder_enabled: arg_bool(args, "reminder_enabled"),
    }
}

async fn create_task_conflicts(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    ts: NaiveDate,
    te: NaiveDate,
    new_prio: i16,
) -> Result<Vec<Value>, ApiError> {
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT id, title, priority, start_date, due_date FROM tasks \
         WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND (start_date = $3 OR due_date = $4 \
              OR (start_date <= $4 AND due_date >= $3) \
              OR (start_date <= $4 AND due_date IS NULL) \
              OR (due_date >= $3 AND start_date IS NULL)) \
         ORDER BY priority ASC, start_date LIMIT 10",
    )
    .bind(user_id)
    .bind(task_id)
    .bind(ts)
    .bind(te)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    let mut out = Vec::new();
    for r in &rows {
        let id: Uuid = r.try_get("id").map_err(db_err)?;
        if id == task_id {
            continue;
        }
        let prio: i16 = r.try_get("priority").map_err(db_err)?;
        out.push(json!({
            "id": id.to_string(),
            "title": r.try_get::<String, _>("title").map_err(db_err)?,
            "priority": prio,
            "start_date": r.try_get::<Option<NaiveDate>, _>("start_date").map_err(db_err)?.map(|d| d.to_string()),
            "due_date": r.try_get::<Option<NaiveDate>, _>("due_date").map_err(db_err)?.map(|d| d.to_string()),
            "outranks_new": task::normalize_priority(Some(prio as i64)) < new_prio,
        }));
    }
    Ok(out)
}

async fn tool_create_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let title = arg_str(args, "title").unwrap_or("Untitled").to_string();
    let mut payloads: Vec<String> = Vec::new();

    {
        let mut tx = begin(state, user_id).await?;
        let snippet: String = title.chars().take(30).collect();
        let pattern = format!("%{snippet}%");
        let dup = sqlx::query(
            "SELECT id, title, status::text AS status FROM tasks \
             WHERE user_id = $1 AND deleted_at IS NULL AND title ILIKE $2 \
             AND status::text NOT IN ('done', 'cancelled') LIMIT 3",
        )
        .bind(user_id)
        .bind(&pattern)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        if !dup.is_empty() {
            let similar: Vec<Value> = dup
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get::<Uuid, _>("id").to_string(),
                        "title": r.get::<String, _>("title"),
                        "status": r.get::<String, _>("status"),
                    })
                })
                .collect();
            payloads.push(obj_str(&json!({
                "warning": "duplicate_check",
                "message": format!(
                    "Found {} similar existing task(s). Created the new task, but you may want to review duplicates.",
                    similar.len()
                ),
                "similar_tasks": similar,
            })));
        }
    }

    let req = build_create_request(args, &title, None);
    let created = tasks::svc_create_task(state, user_id, req).await?;
    let task_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok());
    let ts = parse_date_arg(created.get("start_date").and_then(|v| v.as_str()));
    let te = parse_date_arg(created.get("due_date").and_then(|v| v.as_str()));
    let new_prio = task::normalize_priority(Some(
        created.get("priority").and_then(|v| v.as_i64()).unwrap_or(2),
    ));

    let mut created_payload = json!({
        "created": true,
        "task": {
            "id": created.get("id").cloned().unwrap_or(Value::Null),
            "title": created.get("title").cloned().unwrap_or(Value::Null),
        },
    });

    if let (Some(tid), Some(ts)) = (task_id, ts) {
        let te = te.unwrap_or(ts);
        let conflicts = create_task_conflicts(state, user_id, tid, ts, te, new_prio).await?;
        if !conflicts.is_empty() {
            created_payload["conflict_warning"] = json!({
                "conflict_count": conflicts.len(),
                "message": "This task overlaps existing task(s) on the same day. If a conflicting task has HIGHER priority (priority 1 = high, which includes medical/health), you MUST warn the user in your reply with the date and conflicting title(s).",
                "conflicts": conflicts,
            });
        }
    }
    payloads.push(obj_str(&created_payload));
    Ok(payloads)
}

async fn tool_update_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw_id = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_uuid) = safe_uuid(&raw_id) else {
        return ok_obj(json!({ "error": "Invalid task_id format", "task_id": raw_id }));
    };
    let fields = args
        .get("fields")
        .and_then(|f| f.as_object())
        .cloned()
        .unwrap_or_default();

    let mut tx = begin(state, user_id).await?;
    let Some(mut t) = task::find_task(&mut *tx, task_uuid, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };

    let mut payloads: Vec<String> = Vec::new();
    for (key, value) in &fields {
        match key.as_str() {
            "title" => {
                if let Some(s) = value.as_str() {
                    t.title = s.to_string();
                }
            }
            "description" => {
                t.description = value.as_str().map(|s| s.to_string());
            }
            "status" => {
                if let Some(s) = value.as_str() {
                    t.status = s.to_string();
                }
            }
            "priority" => {
                t.priority = task::normalize_priority(value.as_i64());
            }
            "start_date" => {
                t.start_date = parse_date_arg(value.as_str());
            }
            "due_date" => {
                t.due_date = parse_date_arg(value.as_str());
            }
            "start_time" => {
                t.start_time = parse_time_arg(value.as_str());
            }
            "end_time" => {
                t.end_time = parse_time_arg(value.as_str());
            }
            "list_id" => {
                if !value.is_null() {
                    let Some(list_uuid) = safe_uuid(value) else {
                        payloads.push(obj_str(&json!({ "error": "List not found" })));
                        continue;
                    };
                    let owned = sqlx::query_scalar::<_, i32>(
                        "SELECT 1 FROM lists WHERE id = $1 AND user_id = $2",
                    )
                    .bind(list_uuid)
                    .bind(user_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(db_err)?;
                    if owned.is_none() {
                        payloads.push(obj_str(&json!({ "error": "List not found" })));
                        continue;
                    }
                    t.list_id = Some(list_uuid);
                } else {
                    t.list_id = None;
                }
            }
            _ => {}
        }
    }

    let completed = fields.get("status").and_then(|v| v.as_str()) == Some("done");
    tasks::persist_task(&mut *tx, &t).await.map_err(db_err)?;
    if completed {
        sqlx::query("UPDATE tasks SET completed_at = now() WHERE id = $1 AND user_id = $2")
            .bind(t.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    payloads.push(obj_str(&json!({ "updated": true, "task_id": raw_id })));
    Ok(payloads)
}

async fn tool_delete_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw_id = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_uuid) = safe_uuid(&raw_id) else {
        return ok_obj(json!({ "error": "Invalid task_id format", "task_id": raw_id }));
    };
    let mut tx = begin(state, user_id).await?;
    let exists = task::find_task(&mut *tx, task_uuid, user_id, false)
        .await
        .map_err(db_err)?;
    if exists.is_none() {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    }
    soft_delete_ids(&mut *tx, user_id, &[task_uuid])
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "deleted": true,
        "task_id": raw_id,
        "note": "Moved to Trash (restorable for 14 days)",
    }))
}

async fn tool_batch_delete_tasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw_ids: Vec<Value> = match args.get("task_ids").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr.clone(),
        _ => return ok_obj(json!({ "error": "task_ids must be a non-empty list" })),
    };

    let mut valid_ids: Vec<Uuid> = Vec::new();
    let mut invalid: Vec<Value> = Vec::new();
    for tid in &raw_ids {
        match safe_uuid(tid) {
            Some(u) => valid_ids.push(u),
            None => invalid.push(json!({ "task_id": tid.clone(), "reason": "invalid_id" })),
        }
    }

    let mut tx = begin(state, user_id).await?;
    let owned: Vec<Uuid> = if valid_ids.is_empty() {
        Vec::new()
    } else {
        let rows = sqlx::query(
            "SELECT id FROM tasks WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2)",
        )
        .bind(user_id)
        .bind(&valid_ids)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        rows.iter().map(|r| r.get::<Uuid, _>("id")).collect()
    };
    if !owned.is_empty() {
        soft_delete_ids(&mut *tx, user_id, &owned).await.map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;

    let owned_set: std::collections::HashSet<Uuid> = owned.into_iter().collect();
    let deleted_ids: Vec<String> = valid_ids
        .iter()
        .filter(|id| owned_set.contains(id))
        .map(|id| id.to_string())
        .collect();
    let mut failed: Vec<Value> = invalid;
    for id in &valid_ids {
        if !owned_set.contains(id) {
            failed.push(json!({ "task_id": id.to_string(), "reason": "not_found" }));
        }
    }
    ok_obj(json!({
        "requested": raw_ids.len(),
        "deleted_count": deleted_ids.len(),
        "failed_count": failed.len(),
        "deleted_ids": deleted_ids,
        "failed_ids": failed,
        "note": "Tasks were moved to the Trash (restorable for 14 days).",
    }))
}

async fn tool_delete_matching_tasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let query = arg_str(args, "query");
    let date_from = arg_str(args, "date_from");
    let date_to = arg_str(args, "date_to");
    let list_arg = arg_str(args, "list_id");
    let list_name = arg_str(args, "list_name");
    let undated = arg_bool(args, "undated");

    let has_scope = query.map(|q| !q.trim().is_empty()).unwrap_or(false)
        || date_from.is_some()
        || date_to.is_some()
        || list_arg.map(|s| !s.is_empty()).unwrap_or(false)
        || list_name.map(|s| !s.is_empty()).unwrap_or(false)
        || undated;
    if !has_scope {
        return ok_obj(json!({
            "error": "Refusing to delete: no scope given. Pass a query, a date range, list_id/list_name, or undated=true."
        }));
    }

    let mut tx = begin(state, user_id).await?;
    let (scoped, unmatched_name, _applied) = scoped_tasks(
        &mut *tx,
        user_id,
        query,
        parse_date_arg(date_from),
        parse_date_arg(date_to),
        list_arg,
        list_name,
        undated,
        TOOL_SEARCH_MAX,
        false,
    )
    .await
    .map_err(db_err)?;
    if let Some(name) = unmatched_name {
        tx.rollback().await.ok();
        return ok_obj(json!({
            "error": format!("No list named '{name}' was found, so nothing was deleted."),
            "deleted_count": 0,
        }));
    }

    let targets: Vec<Task> = scoped
        .into_iter()
        .filter(|t| t.parent_task_id.is_none())
        .collect();
    let ids: Vec<Uuid> = targets.iter().map(|t| t.id).collect();
    let deleted = if ids.is_empty() {
        0usize
    } else {
        soft_delete_ids(&mut *tx, user_id, &ids).await.map_err(db_err)?;
        ids.len()
    };
    tx.commit().await.map_err(db_err)?;

    let mut note = "Tasks were moved to the Trash (restorable for 14 days).".to_string();
    if (ids.len() as i64) >= TOOL_SEARCH_MAX {
        note.push_str(" More matches may remain: call delete_matching_tasks again with the same scope.");
    }
    let titles: Vec<Value> = targets
        .iter()
        .take(50)
        .map(|t| {
            json!({
                "title": t.title,
                "start_date": t.start_date.map(|d| d.to_string()),
            })
        })
        .collect();
    ok_obj(json!({
        "deleted_count": deleted,
        "failed_count": ids.len().saturating_sub(deleted),
        "deleted_titles": titles,
        "note": note,
    }))
}

async fn tool_get_task_details(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "task_id").unwrap_or("");
    let Ok(task_id) = Uuid::parse_str(raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(t) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let mut tag_map = task::tags_for(&mut *tx, &[task_id]).await.map_err(db_err)?;
    let tag_values = tag_map.remove(&task_id).unwrap_or_default();
    let link_rows = sqlx::query(
        "SELECT id, source_task_id, target_task_id, link_type::text AS link_type \
         FROM task_links WHERE user_id = $1 AND (source_task_id = $2 OR target_task_id = $2)",
    )
    .bind(user_id)
    .bind(task_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    let links: Vec<Value> = link_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "source_id": r.get::<Uuid, _>("source_task_id").to_string(),
                "target_id": r.get::<Uuid, _>("target_task_id").to_string(),
                "link_type": r.get::<String, _>("link_type"),
            })
        })
        .collect();
    let subtask_rows = sqlx::query(
        "SELECT id, title, status::text AS status FROM tasks \
         WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY sort_order",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    let subtasks: Vec<Value> = subtask_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "title": r.get::<String, _>("title"),
                "status": r.get::<String, _>("status"),
            })
        })
        .collect();
    tx.commit().await.map_err(db_err)?;

    ok_obj(json!({
        "id": t.id.to_string(),
        "title": t.title,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "start_date": t.start_date.map(|d| d.to_string()),
        "due_date": t.due_date.map(|d| d.to_string()),
        "tags": tag_values,
        "links": links,
        "subtasks": subtasks,
    }))
}

async fn tool_link_tasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let source_raw = args.get("source_id").cloned().unwrap_or(Value::Null);
    let target_raw = args.get("target_id").cloned().unwrap_or(Value::Null);
    let link_type = arg_str(args, "link_type").unwrap_or("related").to_string();
    let (Some(source_id), Some(target_id)) = (safe_uuid(&source_raw), safe_uuid(&target_raw)) else {
        return ok_obj(json!({ "error": "One or both tasks not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    let source_ok = task::find_task(&mut *tx, source_id, user_id, false)
        .await
        .map_err(db_err)?
        .is_some();
    let target_ok = task::find_task(&mut *tx, target_id, user_id, false)
        .await
        .map_err(db_err)?
        .is_some();
    if !source_ok || !target_ok {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "One or both tasks not found" }));
    }
    let row = sqlx::query(
        "INSERT INTO task_links (user_id, source_task_id, target_task_id, link_type) \
         VALUES ($1, $2, $3, $4::task_link_type) RETURNING id",
    )
    .bind(user_id)
    .bind(source_id)
    .bind(target_id)
    .bind(&link_type)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    let link_id: Uuid = row.get("id");
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "created": true,
        "link": {
            "id": link_id.to_string(),
            "source_id": source_raw,
            "target_id": target_raw,
            "link_type": link_type,
        },
    }))
}

async fn tool_check_calendar(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let date_from = parse_date_arg(arg_str(args, "date_from"));
    let date_to = parse_date_arg(arg_str(args, "date_to"));
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT start_date::text AS day, COUNT(*) AS count FROM tasks \
         WHERE user_id = $1 AND deleted_at IS NULL AND start_date IS NOT NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND start_date >= $2 AND start_date <= $3 \
         GROUP BY start_date ORDER BY start_date",
    )
    .bind(user_id)
    .bind(date_from)
    .bind(date_to)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    let density: Vec<Value> = rows
        .iter()
        .map(|r| json!({ "date": r.get::<String, _>("day"), "count": r.get::<i64, _>("count") }))
        .collect();
    ok_obj(json!({
        "date_from": date_from.map(|d| d.to_string()),
        "date_to": date_to.map(|d| d.to_string()),
        "density": density,
    }))
}

async fn tool_suggest_subtasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(t) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    tx.commit().await.map_err(db_err)?;
    let suggestions: Vec<Value> = GENERIC_SUGGESTIONS.iter().map(|s| json!(s)).collect();
    ok_obj(json!({ "task_id": raw, "title": t.title, "suggestions": suggestions }))
}

async fn tool_detect_conflicts(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found or has no date range" }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(t) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found or has no date range" }));
    };
    let (Some(ts), Some(te)) = (t.start_date, t.due_date) else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found or has no date range" }));
    };
    let rows = sqlx::query(
        "SELECT id, title, priority, start_date, due_date FROM tasks \
         WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND ((start_date <= $4 AND due_date >= $3) \
              OR (start_date <= $4 AND due_date IS NULL) \
              OR (due_date >= $3 AND start_date IS NULL)) \
         ORDER BY priority ASC",
    )
    .bind(user_id)
    .bind(task_id)
    .bind(ts)
    .bind(te)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;

    let new_tier = task::normalize_priority(Some(t.priority as i64));
    let mut conflicts: Vec<Value> = Vec::new();
    let mut resolutions: Vec<Value> = Vec::new();
    for r in &rows {
        let id: Uuid = r.get("id");
        let prio: i16 = r.get("priority");
        let title: String = r.get("title");
        conflicts.push(json!({
            "id": id.to_string(),
            "title": title,
            "priority": prio,
            "start_date": r.get::<Option<NaiveDate>, _>("start_date").map(|d| d.to_string()),
            "due_date": r.get::<Option<NaiveDate>, _>("due_date").map(|d| d.to_string()),
        }));
        let ct_tier = task::normalize_priority(Some(prio as i64));
        let (action, reason) = if ct_tier < new_tier {
            (
                "suggest_move_new_task",
                format!("Existing task has higher priority ({ct_tier}) than new task ({new_tier})"),
            )
        } else if ct_tier == new_tier {
            ("conflict_warning", "Same priority - user should decide".to_string())
        } else {
            (
                "suggest_reschedule",
                format!("Lower priority ({ct_tier}) than new task ({new_tier})"),
            )
        };
        resolutions.push(json!({
            "action": action,
            "task_id": id.to_string(),
            "task_title": title,
            "reason": reason,
        }));
    }
    ok_obj(json!({
        "task_id": raw,
        "task_title": t.title,
        "task_priority": t.priority,
        "start_date": ts.to_string(),
        "due_date": te.to_string(),
        "conflict_count": conflicts.len(),
        "conflicts": conflicts,
        "suggested_resolutions": resolutions,
    }))
}

async fn tool_reschedule_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let new_start = arg_str(args, "new_start_date");
    let new_due = arg_str(args, "new_due_date");
    let reason = arg_str(args, "reason").unwrap_or("").to_string();

    let mut tx = begin(state, user_id).await?;
    let Some(mut t) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    if new_start.is_some() {
        t.start_date = parse_date_arg(new_start);
    }
    if new_due.is_some() {
        t.due_date = parse_date_arg(new_due);
    }
    tasks::persist_task(&mut *tx, &t).await.map_err(db_err)?;

    let mut conflict_info: Value = Value::Null;
    if let (Some(ts), Some(te)) = (t.start_date, t.due_date) {
        let rows = sqlx::query(
            "SELECT id, title, priority FROM tasks \
             WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL \
             AND status::text NOT IN ('done', 'cancelled') \
             AND (start_date <= $4 AND due_date >= $3)",
        )
        .bind(user_id)
        .bind(task_id)
        .bind(ts)
        .bind(te)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        if !rows.is_empty() {
            let conflicts: Vec<Value> = rows
                .iter()
                .take(5)
                .map(|r| {
                    json!({
                        "id": r.get::<Uuid, _>("id").to_string(),
                        "title": r.get::<String, _>("title"),
                        "priority": r.get::<i16, _>("priority"),
                    })
                })
                .collect();
            conflict_info = json!({ "conflict_count": rows.len(), "conflicts": conflicts });
        }
    }
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "rescheduled": true,
        "task_id": raw,
        "new_start_date": t.start_date.map(|d| d.to_string()),
        "new_due_date": t.due_date.map(|d| d.to_string()),
        "reason": reason,
        "conflicts": conflict_info,
    }))
}

async fn tool_list_tasks_by_date_range(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> ToolResult {
    let date_from = parse_date_arg(arg_str(args, "date_from"));
    let date_to = parse_date_arg(arg_str(args, "date_to"));
    let list_arg = arg_str(args, "list_id").and_then(safe_uuid_str);

    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT id, title, priority, status::text AS status, start_date, due_date, description \
         FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND ((start_date >= $2 AND start_date <= $3) \
              OR (due_date >= $2 AND due_date <= $3) \
              OR (start_date <= $2 AND due_date >= $3)) \
         AND ($4::uuid IS NULL OR list_id = $4) \
         ORDER BY start_date",
    )
    .bind(user_id)
    .bind(date_from)
    .bind(date_to)
    .bind(list_arg)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;

    let tasks: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "title": r.get::<String, _>("title"),
                "priority": r.get::<i16, _>("priority"),
                "status": r.get::<String, _>("status"),
                "start_date": r.get::<Option<NaiveDate>, _>("start_date").map(|d| d.to_string()),
                "due_date": r.get::<Option<NaiveDate>, _>("due_date").map(|d| d.to_string()),
                "description": desc_snippet(r.get::<Option<String>, _>("description").as_deref()),
            })
        })
        .collect();
    let mut fields = Map::new();
    fields.insert(
        "date_from".to_string(),
        date_from.map(|d| json!(d.to_string())).unwrap_or(Value::Null),
    );
    fields.insert(
        "date_to".to_string(),
        date_to.map(|d| json!(d.to_string())).unwrap_or(Value::Null),
    );
    fields.insert("count".to_string(), json!(tasks.len()));
    ok1(bounded_list_payload(fields, "tasks", tasks, TOOL_LIST_BUDGET))
}

async fn tool_suggest_best_time(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let desired_date = parse_date_arg(arg_str(args, "desired_date"));
    let duration_hours = args.get("duration_hours").cloned().unwrap_or(json!(1));
    let min_priority = arg_i64(args, "min_priority_to_consider").unwrap_or(2);

    let allowed: Vec<i16> = (1i16..=3)
        .filter(|p| (*p as i64) <= min_priority)
        .collect();
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT priority FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND start_date = $2 AND status::text NOT IN ('done', 'cancelled') \
         AND priority = ANY($3) ORDER BY priority ASC",
    )
    .bind(user_id)
    .bind(desired_date)
    .bind(&allowed)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;

    let day_count = rows.len();
    let mut suggestions: Vec<String> = Vec::new();
    if day_count <= 3 {
        suggestions.push("morning slot (9am-12pm)".to_string());
        suggestions.push("afternoon slot (1pm-5pm)".to_string());
    } else if day_count <= 5 {
        suggestions.push("early morning (7am-9am)".to_string());
        suggestions.push("late afternoon (4pm-6pm)".to_string());
    } else {
        suggestions.push("day is crowded - consider adjacent dates".to_string());
        let tomorrow = Utc::now().date_naive() + Duration::days(1);
        suggestions.push(format!("suggest checking {} instead", tomorrow));
    }
    ok_obj(json!({
        "desired_date": desired_date.map(|d| d.to_string()),
        "duration_hours": duration_hours,
        "tasks_that_day": day_count,
        "suggestions": suggestions,
    }))
}

async fn tool_get_upcoming_deadlines(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> ToolResult {
    let days_ahead = arg_i64(args, "days_ahead").unwrap_or(7);
    let today = Utc::now().date_naive();
    let end = today + Duration::days(days_ahead);
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT id, title, priority, due_date, status::text AS status FROM tasks \
         WHERE user_id = $1 AND deleted_at IS NULL AND due_date IS NOT NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND due_date >= $2 AND due_date <= $3 ORDER BY due_date, priority ASC",
    )
    .bind(user_id)
    .bind(today)
    .bind(end)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    let deadlines: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "title": r.get::<String, _>("title"),
                "priority": r.get::<i16, _>("priority"),
                "due_date": r.get::<NaiveDate, _>("due_date").to_string(),
                "status": r.get::<String, _>("status"),
            })
        })
        .collect();
    ok_obj(json!({
        "days_ahead": days_ahead,
        "count": deadlines.len(),
        "deadlines": deadlines,
    }))
}

async fn tool_batch_create_tasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let batch = args
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if batch.len() > 50 {
        return ok_obj(json!({ "error": "Too many tasks in one batch (max 50)" }));
    }
    let mut created: Vec<Value> = Vec::new();
    for item in &batch {
        let raw_title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled");
        let mut title: String = raw_title.trim().chars().take(500).collect();
        if title.is_empty() {
            title = "Untitled".to_string();
        }
        let req = build_create_request(item, &title, None);
        let value = tasks::svc_create_task(state, user_id, req).await?;
        created.push(json!({
            "id": value.get("id").cloned().unwrap_or(Value::Null),
            "title": value.get("title").cloned().unwrap_or(Value::Null),
        }));
    }
    ok_obj(json!({ "created_count": created.len(), "tasks": created }))
}

async fn tool_add_event(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let title = arg_str(args, "title").unwrap_or("Untitled").to_string();
    let req = build_create_request(args, &title, Some(2));
    let created = tasks::svc_create_task(state, user_id, req).await?;
    let task_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok());
    let ts = parse_date_arg(created.get("start_date").and_then(|v| v.as_str()));
    let te = parse_date_arg(created.get("due_date").and_then(|v| v.as_str()));
    let new_prio = task::normalize_priority(Some(
        created.get("priority").and_then(|v| v.as_i64()).unwrap_or(2),
    ));

    let mut payload = json!({
        "created": true,
        "task": {
            "id": created.get("id").cloned().unwrap_or(Value::Null),
            "title": created.get("title").cloned().unwrap_or(Value::Null),
            "start_date": created.get("start_date").cloned().unwrap_or(Value::Null),
        },
    });
    if let (Some(tid), Some(ts)) = (task_id, ts) {
        let te = te.unwrap_or(ts);
        let mut tx = begin(state, user_id).await?;
        let rows = sqlx::query(
            "SELECT id, title, priority, start_date FROM tasks \
             WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL \
             AND status::text NOT IN ('done', 'cancelled') \
             AND (start_date = $3 OR due_date = $4 \
                  OR (start_date <= $4 AND due_date >= $3) \
                  OR (start_date <= $4 AND due_date IS NULL) \
                  OR (due_date >= $3 AND start_date IS NULL)) \
             ORDER BY priority ASC LIMIT 10",
        )
        .bind(user_id)
        .bind(tid)
        .bind(ts)
        .bind(te)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        let mut conflicts: Vec<Value> = Vec::new();
        for r in &rows {
            let id: Uuid = r.get("id");
            if id == tid {
                continue;
            }
            let prio: i16 = r.get("priority");
            conflicts.push(json!({
                "id": id.to_string(),
                "title": r.get::<String, _>("title"),
                "priority": prio,
                "start_date": r.get::<Option<NaiveDate>, _>("start_date").map(|d| d.to_string()),
                "outranks_new": task::normalize_priority(Some(prio as i64)) < new_prio,
            }));
        }
        if !conflicts.is_empty() {
            payload["conflict_warning"] = json!({
                "conflict_count": conflicts.len(),
                "message": "This event overlaps existing tasks. If a conflicting task has higher priority (1 = high/medical), warn the user in your reply with the date and conflicting title(s).",
                "conflicts": conflicts,
            });
        }
    }
    ok_obj(payload)
}

async fn tool_cancel_task_by_keywords(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> ToolResult {
    let query = arg_str(args, "query").unwrap_or("").trim().to_string();
    let date_arg = parse_date_arg(arg_str(args, "date"));
    let mut cancelled: Vec<Value> = Vec::new();
    if !query.is_empty() {
        let pattern = format!("%{query}%");
        let mut tx = begin(state, user_id).await?;
        let rows = sqlx::query(
            "SELECT id, title, start_date FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
             AND status::text NOT IN ('done', 'cancelled') \
             AND lower(title) LIKE lower($2) \
             AND ($3::date IS NULL OR start_date = $3) \
             ORDER BY start_date LIMIT 20",
        )
        .bind(user_id)
        .bind(&pattern)
        .bind(date_arg)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        for r in &rows {
            let id: Uuid = r.get("id");
            sqlx::query(
                "UPDATE tasks SET status = 'cancelled'::task_status, updated_at = now() WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
            cancelled.push(json!({
                "id": id.to_string(),
                "title": r.get::<String, _>("title"),
                "start_date": r.get::<Option<NaiveDate>, _>("start_date").map(|d| d.to_string()),
            }));
        }
        tx.commit().await.map_err(db_err)?;
    }
    ok_obj(json!({
        "cancelled_count": cancelled.len(),
        "cancelled": cancelled,
        "note": "Tasks were marked cancelled, not deleted. If cancelled_count == 0, no open task matched - ask the user which task they mean.",
    }))
}

async fn tool_get_subtasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(parent) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let rows = sqlx::query(
        "SELECT id, title, status::text AS status, priority, sort_order, description FROM tasks \
         WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY sort_order",
    )
    .bind(parent.id)
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    let subtasks: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "title": r.get::<String, _>("title"),
                "status": r.get::<String, _>("status"),
                "priority": r.get::<i16, _>("priority"),
                "sort_order": r.get::<i32, _>("sort_order"),
                "description": r.get::<Option<String>, _>("description"),
            })
        })
        .collect();
    ok_obj(json!({ "task_id": raw, "count": subtasks.len(), "subtasks": subtasks }))
}

async fn tool_create_subtask(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let title = arg_str(args, "title").unwrap_or("").to_string();
    let description = arg_str(args, "description").map(|s| s.to_string());

    let mut tx = begin(state, user_id).await?;
    let Some(parent) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let sort_order: i32 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE parent_task_id = $1")
            .bind(parent.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_err)?;
    let row = sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, title, description, status, priority, sort_order) \
         VALUES ($1, $2, $3, $4, 'todo'::task_status, $5, $6) RETURNING id",
    )
    .bind(user_id)
    .bind(parent.id)
    .bind(&title)
    .bind(&description)
    .bind(parent.priority)
    .bind(sort_order)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    let child_id: Uuid = row.get("id");
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "created": true,
        "subtask": { "id": child_id.to_string(), "title": title, "status": "todo" },
    }))
}

async fn tool_update_subtask(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw_parent = args.get("task_id").cloned().unwrap_or(Value::Null);
    let raw_child = args.get("subtask_id").cloned().unwrap_or(Value::Null);
    let (Some(parent_id), Some(child_id)) = (safe_uuid(&raw_parent), safe_uuid(&raw_child)) else {
        return ok_obj(json!({ "error": "Subtask not found" }));
    };
    let fields = args
        .get("fields")
        .and_then(|f| f.as_object())
        .cloned()
        .unwrap_or_default();

    let mut tx = begin(state, user_id).await?;
    if task::find_task(&mut *tx, parent_id, user_id, false)
        .await
        .map_err(db_err)?
        .is_none()
    {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    }
    let Some(mut child) = task::find_task(&mut *tx, child_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Subtask not found" }));
    };
    if child.parent_task_id != Some(parent_id) {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Subtask not found" }));
    }
    for (key, value) in &fields {
        match key.as_str() {
            "title" => {
                if let Some(s) = value.as_str() {
                    child.title = s.to_string();
                }
            }
            "description" => {
                child.description = value.as_str().map(|s| s.to_string());
            }
            "status" => {
                if let Some(s) = value.as_str() {
                    child.status = s.to_string();
                }
            }
            "priority" => {
                child.priority = task::normalize_priority(value.as_i64());
            }
            _ => {}
        }
    }
    tasks::persist_task(&mut *tx, &child).await.map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "updated": true,
        "subtask": {
            "id": child.id.to_string(),
            "title": child.title,
            "status": child.status,
            "priority": child.priority,
        },
    }))
}

async fn tool_delete_subtask(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw_parent = args.get("task_id").cloned().unwrap_or(Value::Null);
    let raw_child = args.get("subtask_id").cloned().unwrap_or(Value::Null);
    let (Some(parent_id), Some(child_id)) = (safe_uuid(&raw_parent), safe_uuid(&raw_child)) else {
        return ok_obj(json!({ "error": "Subtask not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    if task::find_task(&mut *tx, parent_id, user_id, false)
        .await
        .map_err(db_err)?
        .is_none()
    {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    }
    let Some(child) = task::find_task(&mut *tx, child_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Subtask not found" }));
    };
    if child.parent_task_id != Some(parent_id) {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Subtask not found" }));
    }
    sqlx::query("DELETE FROM tasks WHERE id = $1 AND user_id = $2")
        .bind(child.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "deleted": true, "subtask_id": raw_child }))
}

async fn tool_reorder_subtasks(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let ordered_raw: Vec<Value> = args
        .get("ordered_ids")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut tx = begin(state, user_id).await?;
    if task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
        .is_none()
    {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    }
    let rows = sqlx::query(
        "SELECT id FROM tasks WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    let children: std::collections::HashSet<Uuid> =
        rows.iter().map(|r| r.get::<Uuid, _>("id")).collect();

    let mut ordered: Vec<Value> = Vec::new();
    for (rank, raw_child) in ordered_raw.iter().enumerate() {
        let Some(child_id) = safe_uuid(raw_child) else {
            continue;
        };
        if !children.contains(&child_id) {
            continue;
        }
        sqlx::query("UPDATE tasks SET sort_order = $2 WHERE id = $1")
            .bind(child_id)
            .bind(rank as i32)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        ordered.push(json!({ "id": child_id.to_string(), "sort_order": rank }));
    }
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "reordered": true, "subtasks": ordered }))
}

async fn tool_convert_description_to_subtasks(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(parent) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let items = tasks::split_bullets(parent.description.as_deref());
    let mut created: Vec<Value> = Vec::new();
    for (rank, title) in items.iter().enumerate() {
        let trimmed: String = title.chars().take(500).collect();
        let row = sqlx::query(
            "INSERT INTO tasks (user_id, parent_task_id, title, status, priority, sort_order) \
             VALUES ($1, $2, $3, 'todo'::task_status, $4, $5) RETURNING id",
        )
        .bind(user_id)
        .bind(parent.id)
        .bind(&trimmed)
        .bind(parent.priority)
        .bind(rank as i32)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
        created.push(json!({ "id": row.get::<Uuid, _>("id").to_string(), "title": trimmed }));
    }
    sqlx::query("UPDATE tasks SET description = NULL, updated_at = now() WHERE id = $1")
        .bind(parent.id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "converted": true,
        "subtask_count": created.len(),
        "subtasks": created,
    }))
}

async fn tool_convert_subtasks_to_description(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let mut tx = begin(state, user_id).await?;
    if task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
        .is_none()
    {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    }
    let rows = sqlx::query(
        "SELECT id, title FROM tasks WHERE parent_task_id = $1 AND user_id = $2 \
         AND deleted_at IS NULL ORDER BY sort_order, created_at",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    let description: Option<String> = if rows.is_empty() {
        None
    } else {
        Some(
            rows.iter()
                .map(|r| format!("- {}", r.get::<String, _>("title")))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    if !rows.is_empty() {
        let child_ids: Vec<Uuid> = rows.iter().map(|r| r.get::<Uuid, _>("id")).collect();
        sqlx::query("DELETE FROM tasks WHERE id = ANY($1) AND user_id = $2")
            .bind(&child_ids)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        sqlx::query("UPDATE tasks SET description = $2, updated_at = now() WHERE id = $1")
            .bind(task_id)
            .bind(&description)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "converted": true, "description": description }))
}

async fn tool_complete_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Invalid task_id format", "task_id": raw }));
    };
    let mut tx = begin(state, user_id).await?;
    let exists = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?;
    if exists.is_none() {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    }
    sqlx::query(
        "UPDATE tasks SET status = 'done'::task_status, completed_at = now(), updated_at = now() \
         WHERE id = $1 AND user_id = $2",
    )
    .bind(task_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "completed": true, "task_id": raw, "status": "done" }))
}

async fn tool_duplicate_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Invalid task_id format", "task_id": raw }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(t) = task::find_task(&mut *tx, task_id, user_id, false)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found" }));
    };
    let row = sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, title, description, status, priority, \
         start_date, due_date, start_time, end_time, is_all_day, estimated_minutes, \
         recurrence_rule, recurrence_end_date, sort_order, is_archived, list_id) \
         VALUES ($1, $2, $3, $4, 'todo'::task_status, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, $15) \
         RETURNING id",
    )
    .bind(user_id)
    .bind(t.parent_task_id)
    .bind(&t.title)
    .bind(&t.description)
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
    .bind(t.list_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    let new_id: Uuid = row.get("id");
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "created": true, "task": { "id": new_id.to_string(), "title": t.title } }))
}

async fn tool_list_tags(state: &AppState, user_id: Uuid) -> ToolResult {
    let arr = tags::svc_list_tags(state, user_id).await?;
    let list = arr.as_array().cloned().unwrap_or_default();
    ok_obj(json!({ "count": list.len(), "tags": list }))
}

async fn tool_add_tag_to_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Invalid task_id format", "task_id": raw }));
    };
    let tag_name = arg_str(args, "tag_name").unwrap_or("").trim().to_string();
    if tag_name.is_empty() {
        return ok_obj(json!({ "error": "tag_name is required" }));
    }
    match tags::svc_add_tag_to_task(state, user_id, task_id, tag_name).await {
        Ok(tag) => ok_obj(json!({
            "added": true,
            "task_id": raw,
            "tag": {
                "id": tag.get("id").cloned().unwrap_or(Value::Null),
                "name": tag.get("name").cloned().unwrap_or(Value::Null),
            },
        })),
        Err(ApiError::NotFound(_)) => ok_obj(json!({ "error": "Task not found" })),
        Err(other) => Err(other),
    }
}

async fn tool_get_task_stats(state: &AppState, user_id: Uuid) -> ToolResult {
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT status::text AS status, COUNT(*) AS count FROM tasks \
         WHERE user_id = $1 AND deleted_at IS NULL GROUP BY status",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    let mut stats = Map::new();
    let mut total: i64 = 0;
    for r in &rows {
        let status: String = r.get("status");
        let count: i64 = r.get("count");
        total += count;
        stats.insert(status, json!(count));
    }
    ok_obj(json!({ "stats": stats, "total": total }))
}

async fn tool_restore_task(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = args.get("task_id").cloned().unwrap_or(Value::Null);
    let Some(task_id) = safe_uuid(&raw) else {
        return ok_obj(json!({ "error": "Invalid task_id format", "task_id": raw }));
    };
    let mut tx = begin(state, user_id).await?;
    let Some(t) = task::find_task(&mut *tx, task_id, user_id, true)
        .await
        .map_err(db_err)?
    else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "Task not found in trash" }));
    };
    let sql = "WITH RECURSIVE tree AS ( \
                 SELECT id FROM tasks WHERE id = $1 AND user_id = $2 \
                 UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id \
               ) UPDATE tasks SET deleted_at = NULL, updated_at = now() WHERE id IN (SELECT id FROM tree)";
    sqlx::query(sql)
        .bind(t.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "restored": true, "task_id": raw }))
}

async fn tool_create_list(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let name: String = arg_str(args, "name")
        .unwrap_or("")
        .trim()
        .chars()
        .take(200)
        .collect();
    if name.is_empty() {
        return ok_obj(json!({ "error": "List name is required" }));
    }
    let mut tx = begin(state, user_id).await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lists WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    if count >= 200 {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "List limit reached (200)" }));
    }
    let max_pos: Option<i32> = sqlx::query_scalar("SELECT MAX(position) FROM lists WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    let row = sqlx::query(
        "INSERT INTO lists (user_id, name, position) VALUES ($1, $2, $3) RETURNING id, name",
    )
    .bind(user_id)
    .bind(&name)
    .bind(max_pos.unwrap_or(0) + 1)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    let list_id: Uuid = row.get("id");
    let list_name: String = row.get("name");
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "created": true, "list": { "id": list_id.to_string(), "name": list_name } }))
}

async fn tool_list_lists(state: &AppState, user_id: Uuid) -> ToolResult {
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT id, name, position FROM lists WHERE user_id = $1 ORDER BY position, created_at",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    let lists: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "name": r.get::<String, _>("name"),
                "position": r.get::<i32, _>("position"),
            })
        })
        .collect();
    ok_obj(json!({ "count": lists.len(), "lists": lists }))
}

async fn tool_rename_list(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let name: String = arg_str(args, "name")
        .unwrap_or("")
        .trim()
        .chars()
        .take(200)
        .collect();
    if name.is_empty() {
        return ok_obj(json!({ "error": "List name is required" }));
    }
    let raw_id = args.get("list_id").cloned().unwrap_or(Value::Null);
    let Some(list_id) = safe_uuid(&raw_id) else {
        return ok_obj(json!({ "error": "Invalid list_id format", "list_id": raw_id }));
    };
    let mut tx = begin(state, user_id).await?;
    let row = sqlx::query("SELECT name FROM lists WHERE id = $1 AND user_id = $2")
        .bind(list_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
    let Some(row) = row else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "List not found" }));
    };
    let current: String = row.get("name");
    if current == task::DEFAULT_LIST_NAME {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "The default 'My Tasks' list cannot be renamed." }));
    }
    sqlx::query("UPDATE lists SET name = $1, updated_at = now() WHERE id = $2")
        .bind(&name)
        .bind(list_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({ "renamed": true, "list": { "id": list_id.to_string(), "name": name } }))
}

async fn tool_delete_list(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw_id = args.get("list_id").cloned().unwrap_or(Value::Null);
    let Some(list_id) = safe_uuid(&raw_id) else {
        return ok_obj(json!({ "error": "Invalid list_id format", "list_id": raw_id }));
    };
    let mut tx = begin(state, user_id).await?;
    let row = sqlx::query("SELECT name FROM lists WHERE id = $1 AND user_id = $2")
        .bind(list_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
    let Some(row) = row else {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "List not found" }));
    };
    let current: String = row.get("name");
    if current == task::DEFAULT_LIST_NAME {
        tx.rollback().await.ok();
        return ok_obj(json!({ "error": "The default 'My Tasks' list cannot be deleted." }));
    }
    let default_id = task::default_list_id(&mut *tx, user_id).await.map_err(db_err)?;
    sqlx::query("UPDATE tasks SET list_id = $1 WHERE list_id = $2 AND user_id = $3")
        .bind(default_id)
        .bind(list_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM lists WHERE id = $1")
        .bind(list_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    ok_obj(json!({
        "deleted": true,
        "list_id": raw_id,
        "note": "Its tasks were moved to the default 'My Tasks' list.",
    }))
}

// ---------------------------------------------------------------------------
// Watchlist tools
// ---------------------------------------------------------------------------

fn watchlist_tool_error(name: &str, message: &str) -> ToolResult {
    ok_obj(json!({
        "error": format!("{message} (tool: {name}. If you still have trouble, please open a new chat.)"),
    }))
}

async fn tool_search_titles(state: &AppState, args: &Value) -> ToolResult {
    let query = arg_str(args, "query").unwrap_or("").trim().to_string();
    if query.is_empty() {
        return watchlist_tool_error("search_titles", "query is required.");
    }
    let arr = watchlist::svc_search_titles(state, query).await?;
    let items = arr.as_array().cloned().unwrap_or_default();
    let capped: Vec<Value> = items
        .iter()
        .take(8)
        .map(|r| {
            json!({
                "tmdb_id": r.get("tmdb_id").cloned().unwrap_or(Value::Null),
                "media_type": r.get("media_type").cloned().unwrap_or(Value::Null),
                "title": r.get("title").cloned().unwrap_or(Value::Null),
                "release_year": r.get("release_year").cloned().unwrap_or(Value::Null),
                "poster_url": watchlist::poster_url(r.get("poster_path").and_then(|p| p.as_str())),
            })
        })
        .collect();
    ok_obj(json!({ "count": capped.len(), "results": capped }))
}

async fn tool_list_watchlist(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let status = match arg_str(args, "status") {
        Some(s) if ["plan_to_watch", "watching", "watched"].contains(&s) => Some(s.to_string()),
        _ => None,
    };
    let arr = watchlist::svc_list_watchlist(state, user_id, status).await?;
    let items = arr.as_array().cloned().unwrap_or_default();
    ok_obj(json!({ "count": items.len(), "items": items }))
}

async fn tool_add_watchlist_item(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let media_type = arg_str(args, "media_type").unwrap_or("").trim().to_string();
    if !["movie", "tv"].contains(&media_type.as_str()) {
        return watchlist_tool_error("add_watchlist_item", "media_type must be movie or tv");
    }
    let title = arg_str(args, "title").unwrap_or("").trim().to_string();
    let tmdb_id = match args.get("tmdb_id") {
        Some(Value::Null) | None => None,
        Some(v) => match v.as_i64() {
            Some(n) => Some(n),
            None => {
                return watchlist_tool_error(
                    "add_watchlist_item",
                    "tmdb_id must be an integer when provided",
                )
            }
        },
    };
    if tmdb_id.is_none() && title.is_empty() {
        return watchlist_tool_error(
            "add_watchlist_item",
            "title is required when tmdb_id is not provided",
        );
    }
    let payload = watchlist::WatchlistAddRequest {
        tmdb_id,
        media_type,
        title,
        release_year: arg_i64(args, "release_year").map(|v| v as i32),
        poster_path: arg_str(args, "poster_path").map(|s| s.to_string()),
        status: arg_str(args, "status").map(|s| s.to_string()),
        rating: arg_i64(args, "rating").map(|v| v as i16),
        notes: arg_str(args, "notes").map(|s| s.to_string()),
    };
    match watchlist::svc_add_watchlist_item(state, user_id, payload).await {
        Ok(item) => ok_obj(json!({ "created": true, "item": item })),
        Err(ApiError::Conflict(_)) => ok_obj(json!({
            "error": "Already on your watchlist (tool: add_watchlist_item. If you still have trouble, please open a new chat.)",
            "code": 409,
        })),
        Err(ApiError::Unprocessable(msg)) | Err(ApiError::BadRequest(msg)) => {
            watchlist_tool_error("add_watchlist_item", &msg)
        }
        Err(other) => Err(other),
    }
}

async fn tool_update_watchlist_item(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "item_id").unwrap_or("");
    let Ok(item_id) = Uuid::parse_str(raw) else {
        return watchlist_tool_error("update_watchlist_item", "Invalid item_id format");
    };
    let mut body = Map::new();
    for key in ["status", "rating", "notes", "watched_at"] {
        if let Some(v) = args.get(key) {
            body.insert(key.to_string(), v.clone());
        }
    }
    match watchlist::svc_update_watchlist_item(state, user_id, item_id, Value::Object(body)).await {
        Ok(item) => ok_obj(json!({ "updated": true, "item": item })),
        Err(ApiError::NotFound(_)) => {
            watchlist_tool_error("update_watchlist_item", "Watchlist item not found")
        }
        Err(ApiError::Unprocessable(msg)) | Err(ApiError::BadRequest(msg)) => {
            watchlist_tool_error("update_watchlist_item", &msg)
        }
        Err(other) => Err(other),
    }
}

async fn tool_remove_watchlist_item(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "item_id").unwrap_or("");
    let Ok(item_id) = Uuid::parse_str(raw) else {
        return watchlist_tool_error("remove_watchlist_item", "Invalid item_id format");
    };
    match watchlist::svc_remove_watchlist_item(state, user_id, item_id).await {
        Ok(()) => ok_obj(json!({ "deleted": true, "item_id": item_id.to_string() })),
        Err(ApiError::NotFound(_)) => {
            watchlist_tool_error("remove_watchlist_item", "Watchlist item not found")
        }
        Err(other) => Err(other),
    }
}

// ---------------------------------------------------------------------------
// Habit tools
// ---------------------------------------------------------------------------

fn habit_tool_error(name: &str, message: &str) -> ToolResult {
    watchlist_tool_error(name, message)
}

async fn tool_list_habits(state: &AppState, user_id: Uuid) -> ToolResult {
    let arr = habits::svc_list_habits(state, user_id).await?;
    let items = arr.as_array().cloned().unwrap_or_default();
    ok_obj(json!({ "count": items.len(), "habits": items }))
}

async fn tool_create_habit(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let title = arg_str(args, "title").unwrap_or("").trim().to_string();
    if title.is_empty() {
        return habit_tool_error("create_habit", "title is required.");
    }
    if title.chars().count() > 500 {
        return habit_tool_error("create_habit", "title must be at most 500 characters");
    }
    let frequency = arg_str(args, "frequency").unwrap_or("daily").to_string();
    if !["daily", "weekly", "monthly"].contains(&frequency.as_str()) {
        return habit_tool_error("create_habit", "frequency must be daily, weekly or monthly");
    }
    let target_count = arg_i64(args, "target_count").unwrap_or(1).max(1) as i32;
    let color = arg_str(args, "color")
        .map(|c| c.chars().take(7).collect::<String>())
        .filter(|c| !c.is_empty());
    let req = habits::CreateHabitRequest {
        title,
        frequency,
        target_count,
        color,
    };
    let habit = habits::svc_create_habit(state, user_id, req).await?;
    ok_obj(json!({ "created": true, "habit": habit }))
}

async fn tool_update_habit(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "habit_id").unwrap_or("");
    let Ok(habit_id) = Uuid::parse_str(raw) else {
        return habit_tool_error("update_habit", "Invalid habit_id format");
    };
    if let Some(title) = arg_str(args, "title") {
        let title = title.trim();
        if title.is_empty() {
            return habit_tool_error("update_habit", "title cannot be empty");
        }
        if title.chars().count() > 500 {
            return habit_tool_error("update_habit", "title must be at most 500 characters");
        }
    }
    if let Some(freq) = arg_str(args, "frequency") {
        if !["daily", "weekly", "monthly"].contains(&freq) {
            return habit_tool_error("update_habit", "frequency must be daily, weekly or monthly");
        }
    }
    let req = habits::UpdateHabitRequest {
        title: arg_str(args, "title").map(|s| s.trim().to_string()),
        frequency: arg_str(args, "frequency").map(|s| s.to_string()),
        target_count: arg_i64(args, "target_count").map(|v| v.max(1) as i32),
        color: arg_str(args, "color")
            .map(|c| c.chars().take(7).collect::<String>())
            .filter(|c| !c.is_empty()),
    };
    match habits::svc_update_habit(state, user_id, habit_id, req).await {
        Ok(habit) => ok_obj(json!({ "updated": true, "habit": habit })),
        Err(ApiError::NotFound(_)) => habit_tool_error("update_habit", "Habit not found"),
        Err(other) => Err(other),
    }
}

async fn tool_delete_habit(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "habit_id").unwrap_or("");
    let Ok(habit_id) = Uuid::parse_str(raw) else {
        return habit_tool_error("delete_habit", "Invalid habit_id format");
    };
    match habits::svc_delete_habit(state, user_id, habit_id).await {
        Ok(()) => ok_obj(json!({ "deleted": true, "habit_id": habit_id.to_string() })),
        Err(ApiError::NotFound(_)) => habit_tool_error("delete_habit", "Habit not found"),
        Err(other) => Err(other),
    }
}

async fn tool_toggle_habit_log(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "habit_id").unwrap_or("");
    let Ok(habit_id) = Uuid::parse_str(raw) else {
        return habit_tool_error("toggle_habit_log", "Invalid habit_id format");
    };
    match habits::svc_toggle_habit_log(state, user_id, habit_id).await {
        Ok(value) => ok1(obj_str(&value)),
        Err(ApiError::NotFound(_)) => habit_tool_error("toggle_habit_log", "Habit not found"),
        Err(other) => Err(other),
    }
}

async fn tool_get_habit_logs(state: &AppState, user_id: Uuid, args: &Value) -> ToolResult {
    let raw = arg_str(args, "habit_id").unwrap_or("");
    let Ok(habit_id) = Uuid::parse_str(raw) else {
        return habit_tool_error("get_habit_logs", "Invalid habit_id format");
    };
    let from = parse_date_arg(arg_str(args, "from"));
    let to = parse_date_arg(arg_str(args, "to"));
    match habits::svc_get_habit_logs(state, user_id, habit_id, from, to).await {
        Ok(value) => {
            let arr = value.as_array().cloned().unwrap_or_default();
            let logs: Vec<Value> = arr
                .iter()
                .map(|l| {
                    json!({
                        "id": l.get("id").cloned().unwrap_or(Value::Null),
                        "completed_at": l.get("completed_at").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            ok_obj(json!({
                "habit_id": habit_id.to_string(),
                "count": logs.len(),
                "logs": logs,
            }))
        }
        Err(ApiError::NotFound(_)) => habit_tool_error("get_habit_logs", "Habit not found"),
        Err(other) => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_time_arg_accepts_convenience_forms() {
        assert_eq!(parse_time_arg(Some("14:00")), NaiveTime::from_hms_opt(14, 0, 0));
        assert_eq!(parse_time_arg(Some("14:00:30")), NaiveTime::from_hms_opt(14, 0, 30));
        assert_eq!(parse_time_arg(Some("2pm")), NaiveTime::from_hms_opt(14, 0, 0));
        assert_eq!(parse_time_arg(Some("9")), NaiveTime::from_hms_opt(9, 0, 0));
        assert_eq!(parse_time_arg(Some("12am")), NaiveTime::from_hms_opt(0, 0, 0));
        assert_eq!(parse_time_arg(Some("12pm")), NaiveTime::from_hms_opt(12, 0, 0));
        assert_eq!(parse_time_arg(Some("7:5")), None);
        assert_eq!(parse_time_arg(Some("24:00")), None);
        assert_eq!(parse_time_arg(Some("13pm")), None);
        assert_eq!(parse_time_arg(Some("")), None);
        assert_eq!(parse_time_arg(None), None);
    }

    #[test]
    fn safe_uuid_accepts_hyphens_and_spaces() {
        let canonical = "550e8400-e29b-41d4-a716-446655440000";
        let expected = Uuid::parse_str(canonical).unwrap();
        assert_eq!(safe_uuid(&json!(canonical)), Some(expected));
        assert_eq!(safe_uuid(&json!("550e8400e29b41d4a716446655440000")), Some(expected));
        assert_eq!(
            safe_uuid(&json!("5 5 0 e 8 4 0 0 - e 2 9 b - 4 1 d 4 - a 7 1 6 - 4 4 6 6 5 5 4 4 0 0 0 0")),
            Some(expected)
        );
        assert_eq!(safe_uuid(&json!("not-a-uuid")), None);
        assert_eq!(safe_uuid(&Value::Null), None);
        assert_eq!(safe_uuid(&json!("")), None);
    }

    #[test]
    fn bounded_list_payload_truncates_whole_entries() {
        let items: Vec<Value> = (0..50)
            .map(|i| json!({ "id": i.to_string(), "title": "x".repeat(200) }))
            .collect();
        let mut fields = Map::new();
        fields.insert("found".to_string(), json!(items.len()));
        let out = bounded_list_payload(fields, "tasks", items.clone(), 1000);
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["truncated"], true);
        assert!(parsed["omitted"].as_u64().unwrap() > 0);
        assert!(parsed["tasks"].as_array().unwrap().len() < items.len());
        assert!(out.len() <= 1000);

        let mut small = Map::new();
        small.insert("found".to_string(), json!(1));
        let full = bounded_list_payload(small, "tasks", vec![json!({ "id": "1" })], 11600);
        let parsed_full: Value = serde_json::from_str(&full).unwrap();
        assert!(parsed_full.get("truncated").is_none());
    }

    #[tokio::test]
    async fn unknown_tool_returns_python_message() {
        let state = AppState::lazy(crate::config::tests::sample("test"));
        let calls = vec![json!({
            "id": "call_1",
            "function": { "name": "nope", "arguments": "{}" },
        })];
        let out = execute_tool_calls(&state, Uuid::new_v4(), &calls).await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "tool");
        assert_eq!(out[0]["tool_call_id"], "call_1");
        let content = out[0]["content"].as_str().unwrap();
        let payload: Value = serde_json::from_str(content).unwrap();
        assert_eq!(
            payload["error"],
            "Unknown tool: nope (If you still have trouble, please open a new chat.)"
        );
    }

    #[tokio::test]
    async fn cap_truncates_and_appends_note() {
        let state = AppState::lazy(crate::config::tests::sample("test"));
        let calls: Vec<Value> = (0..25)
            .map(|i| {
                json!({
                    "id": format!("call_{i}"),
                    "function": { "name": "nope", "arguments": "{}" },
                })
            })
            .collect();
        let out = execute_tool_calls(&state, Uuid::new_v4(), &calls).await;
        assert_eq!(out.len(), MAX_TOOL_CALLS_PER_ROUND + 1);
        let last = out.last().unwrap();
        assert_eq!(last["tool_call_id"], format!("call_{}", MAX_TOOL_CALLS_PER_ROUND - 1));
        let payload: Value = serde_json::from_str(last["content"].as_str().unwrap()).unwrap();
        assert!(payload["error"].as_str().unwrap().contains("Tool-call cap reached (20)"));
    }

    fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let mut settings = crate::config::tests::sample("test");
        settings.database_url = url;
        Some(AppState::lazy(settings))
    }

    fn first_content(out: &[Value]) -> Value {
        let content = out[0]["content"].as_str().expect("content string");
        serde_json::from_str(content).expect("payload json")
    }

    #[tokio::test]
    async fn create_search_and_details_round_trip() {
        let Some(state) = live_state() else {
            return;
        };
        let email = format!("rust-ai-exec-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");

        let create_args = json!({ "title": "AI Rust task", "priority": 1 });
        let created = execute_tool_calls(
            &state,
            user.id,
            &[json!({
                "id": "c1",
                "function": { "name": "create_task", "arguments": serde_json::to_string(&create_args).unwrap() },
            })],
        )
        .await;
        let payload = first_content(&created);
        assert_eq!(payload["created"], true);
        let task_id = payload["task"]["id"].as_str().unwrap().to_string();

        let search_args = json!({ "query": "AI Rust task" });
        let searched = execute_tool_calls(
            &state,
            user.id,
            &[json!({
                "id": "c2",
                "function": { "name": "search_tasks", "arguments": serde_json::to_string(&search_args).unwrap() },
            })],
        )
        .await;
        let search_payload = first_content(&searched);
        assert_eq!(search_payload["found"], 1);
        assert_eq!(search_payload["tasks"][0]["title"], "AI Rust task");

        let detail_args = json!({ "task_id": task_id });
        let detailed = execute_tool_calls(
            &state,
            user.id,
            &[json!({
                "id": "c3",
                "function": { "name": "get_task_details", "arguments": serde_json::to_string(&detail_args).unwrap() },
            })],
        )
        .await;
        let detail_payload = first_content(&detailed);
        assert_eq!(detail_payload["id"], task_id);
        assert_eq!(detail_payload["title"], "AI Rust task");
        assert_eq!(detail_payload["priority"], 1);

        for sql in ["DELETE FROM tasks WHERE user_id = $1", "DELETE FROM lists WHERE user_id = $1", "DELETE FROM users WHERE id = $1"] {
            sqlx::query(sql)
                .bind(user.id)
                .execute(&state.pool)
                .await
                .expect("cleanup");
        }
    }

    #[test]
    fn payload_is_error_only_for_error_objects() {
        assert!(payload_is_error("{\"error\":\"Task not found\"}"));
        assert!(!payload_is_error("{\"created\":true}"));
        // Non-JSON (the "Invalid arguments" fallback) counts as a failure.
        assert!(payload_is_error("Invalid arguments"));
    }

    #[test]
    fn build_create_request_normalizes_clock_and_date_junk() {
        // "2pm" must be coerced to 14:00:00 instead of aborting the insert.
        let req = build_create_request(
            &json!({ "title": "Testing", "start_date": "2026-10-03", "start_time": "2pm" }),
            "Testing",
            None,
        );
        assert_eq!(req.start_date.as_deref(), Some("2026-10-03"));
        assert_eq!(req.start_time.as_deref(), Some("14:00:00"));
        // Junk dates are dropped (like Python), never passed to the strict validator.
        let req = build_create_request(
            &json!({ "title": "Testing", "start_date": "tomorrow", "start_time": "sometime" }),
            "Testing",
            None,
        );
        assert_eq!(req.start_date, None);
        assert_eq!(req.start_time, None);
    }

    /// The exact reported case: "stuff to do tmr at 2pm" then "testing". A
    /// convenience clock time must persist a real task with the right day/time.
    #[tokio::test]
    async fn create_task_with_convenience_clock_time_persists() {
        let Some(state) = live_state() else {
            return;
        };
        let email = format!("rust-ai-clock-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");

        let tomorrow = (Utc::now() + Duration::days(1))
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        let create_args = json!({
            "title": "Testing",
            "start_date": tomorrow,
            "start_time": "2pm",
        });
        let created = execute_tool_calls(
            &state,
            user.id,
            &[json!({
                "id": "c1",
                "function": { "name": "create_task", "arguments": serde_json::to_string(&create_args).unwrap() },
            })],
        )
        .await;
        let payload = first_content(&created);
        assert_eq!(payload["created"], true, "create_task must succeed: {payload}");
        let task_id = Uuid::parse_str(payload["task"]["id"].as_str().unwrap()).unwrap();

        let (stored_date, stored_time): (Option<NaiveDate>, Option<NaiveTime>) =
            sqlx::query_as("SELECT start_date, start_time FROM tasks WHERE id = $1 AND user_id = $2")
                .bind(task_id)
                .bind(user.id)
                .fetch_one(&state.pool)
                .await
                .expect("read back task");
        assert_eq!(stored_date, NaiveDate::parse_from_str(&tomorrow, "%Y-%m-%d").ok());
        assert_eq!(stored_time, NaiveTime::from_hms_opt(14, 0, 0));

        for sql in ["DELETE FROM tasks WHERE user_id = $1", "DELETE FROM lists WHERE user_id = $1", "DELETE FROM users WHERE id = $1"] {
            sqlx::query(sql)
                .bind(user.id)
                .execute(&state.pool)
                .await
                .expect("cleanup");
        }
    }

    /// AI tool mutations run in a background task and must publish the same
    /// per-user change event an HTTP mutation would, so the SSE stream (and
    /// every other tab/device) refreshes without a manual reload.
    #[tokio::test]
    async fn ai_tool_mutation_publishes_change_event() {
        let Some(state) = live_state() else {
            return;
        };
        let email = format!("rust-ai-event-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");

        let mut rx = state.events.subscribe();
        let args = json!({ "title": "Event task" });
        let (_, committed) = execute_tool_calls_outcome(
            &state,
            user.id,
            &[json!({
                "id": "c1",
                "function": { "name": "create_task", "arguments": serde_json::to_string(&args).unwrap() },
            })],
        )
        .await;
        assert!(committed, "a successful create_task must report a committed action");

        let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
            .await
            .expect("a change event must be published")
            .expect("event bus open");
        assert_eq!(event.user_id, user.id);
        assert_eq!(event.resource, "tasks");

        for sql in ["DELETE FROM tasks WHERE user_id = $1", "DELETE FROM lists WHERE user_id = $1", "DELETE FROM users WHERE id = $1"] {
            sqlx::query(sql)
                .bind(user.id)
                .execute(&state.pool)
                .await
                .expect("cleanup");
        }
    }

    /// A failed mutation must not report a committed action, so the turn runner
    /// can force the honest "nothing was saved" reply.
    #[tokio::test]
    async fn failed_mutation_reports_no_committed_action() {
        let Some(state) = live_state() else {
            return;
        };
        let email = format!("rust-ai-fail-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");
        // A whitespace-only title is rejected by validate_create, so create_task
        // fails deterministically and must report no committed action.
        let args = json!({ "title": "   " });
        let (results, committed) = execute_tool_calls_outcome(
            &state,
            user.id,
            &[json!({
                "id": "c1",
                "function": { "name": "create_task", "arguments": serde_json::to_string(&args).unwrap() },
            })],
        )
        .await;
        assert!(!committed);
        let payload = first_content(&results);
        assert!(payload.get("error").is_some());

        for sql in ["DELETE FROM tasks WHERE user_id = $1", "DELETE FROM lists WHERE user_id = $1", "DELETE FROM users WHERE id = $1"] {
            sqlx::query(sql)
                .bind(user.id)
                .execute(&state.pool)
                .await
                .expect("cleanup");
        }
    }
}
