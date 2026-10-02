//! MCP server at `/api/mcp` (Streamable HTTP JSON-RPC).
//!
//! Mirrors the Python `app/services/mcp_server.py` contract: a stateless
//! Streamable HTTP endpoint that exposes the core task, watchlist and habit
//! tools to external AI clients (VS Code, Cursor, Claude, Kilo). Auth is a
//! Personal Access Token (`Authorization: Bearer prysm_live_...`); the EE build
//! installs an OAuth access-token verifier and a Premium entitlement check via
//! the registration hooks below. Community has no entitlement provider, so MCP
//! is free there.
//!
//! Responses use the SSE framing (`event: message`) that FastMCP emits by
//! default, and the server is stateless (no `mcp-session-id`).

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use chrono::NaiveDate;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::ApiError;
use crate::task;
use crate::{db, habits, tags, tasks, watchlist, AppState};

const SERVER_NAME: &str = "Prysm Note";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 4] =
    ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

// ---------------------------------------------------------------------------
// EE registration hooks (core never depends on ee)
// ---------------------------------------------------------------------------

/// Claims extracted from an EE-issued OAuth access JWT by the EE verifier.
pub struct VerifiedOauth {
    pub user_id: Uuid,
    pub token_version: i64,
}

/// Verifies an OAuth access JWT and returns its claims, or `None` if invalid.
pub type OauthVerifyFn = fn(&str, &crate::config::Settings) -> Option<VerifiedOauth>;

static OAUTH_VERIFIER: OnceLock<OauthVerifyFn> = OnceLock::new();

/// Install the EE OAuth access-token verifier. Called from the EE extension.
pub fn register_oauth_verifier(verifier: OauthVerifyFn) {
    let _ = OAUTH_VERIFIER.set(verifier);
}

/// Premium entitlement check. Defaults to allowed (community has no premium).
pub trait McpEntitlement: Send + Sync {
    fn is_premium<'a>(
        &'a self,
        pool: &'a PgPool,
        user_id: Uuid,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

static ENTITLEMENT: OnceLock<Box<dyn McpEntitlement>> = OnceLock::new();

/// Install the EE Premium entitlement check. Called from the EE extension.
pub fn register_entitlement(entitlement: Box<dyn McpEntitlement>) {
    let _ = ENTITLEMENT.set(entitlement);
}

fn entitlement() -> Option<&'static dyn McpEntitlement> {
    ENTITLEMENT.get().map(|b| b.as_ref())
}

/// Private-build (EE) MCP tools. Registered by the EE extension so core never
/// depends on `ee`. A group returns `None` from [`McpEeTools::call`] when the
/// tool name is not one it owns, so several groups can share one registrar.
pub type McpEeFuture<'a> =
    Pin<Box<dyn Future<Output = Option<Result<Value, ApiError>>> + Send + 'a>>;

pub trait McpEeTools: Send + Sync {
    /// Extra tool definitions appended to `tools/list`.
    fn tool_definitions(&self) -> Vec<Value>;

    /// Run an EE tool. `None` means "not my tool" (fall through to Unknown).
    fn call<'a>(
        &'a self,
        state: &'a AppState,
        user_id: Uuid,
        name: &'a str,
        args: &'a Value,
    ) -> McpEeFuture<'a>;
}

static EE_TOOLS: OnceLock<Box<dyn McpEeTools>> = OnceLock::new();

/// Install the EE MCP tool group. Called from the EE extension.
pub fn register_ee_tools(tools: Box<dyn McpEeTools>) {
    let _ = EE_TOOLS.set(tools);
}

fn ee_tools() -> Option<&'static dyn McpEeTools> {
    EE_TOOLS.get().map(|b| b.as_ref())
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// The `/api/mcp` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/mcp", get(get_mcp).post(post_mcp).delete(delete_mcp))
        .route("/api/mcp/", get(get_mcp).post(post_mcp).delete(delete_mcp))
        .route(
            "/api/mcp/.well-known/oauth-protected-resource",
            get(protected_resource),
        )
}

async fn get_mcp() -> Response {
    method_not_supported()
}

async fn delete_mcp() -> Response {
    method_not_supported()
}

fn method_not_supported() -> Response {
    Response::builder()
        .status(StatusCode::METHOD_NOT_ALLOWED)
        .header(header::ALLOW, "POST")
        .body(Body::empty())
        .unwrap()
}

/// RFC 9728 protected-resource metadata (unauthenticated).
async fn protected_resource(State(state): State<AppState>) -> Response {
    let origin = state.settings.app_origin.trim_end_matches('/');
    let body = json!({
        "resource": format!("{origin}/api/mcp"),
        "authorization_servers": [format!("{origin}/api/ee/mcp-oauth")],
        "scopes_supported": ["tasks", "watchlist", "habits"],
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(body.to_string()))
        .unwrap()
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Uuid, Response> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let token = match raw {
        Some(v) if v.len() > 7 && v[..7].eq_ignore_ascii_case("bearer ") => v[7..].trim(),
        _ => return Err(unauthorized(state)),
    };
    if token.is_empty() {
        return Err(unauthorized(state));
    }

    let user_id = if token.starts_with(crate::api_token::TOKEN_PREFIX) {
        match crate::api_token::lookup_token_system(&state.pool, token).await {
            Ok(Some(row)) => row.user_id,
            _ => return Err(unauthorized(state)),
        }
    } else {
        let Some(verify) = OAUTH_VERIFIER.get().copied() else {
            return Err(unauthorized(state));
        };
        let Some(claims) = verify(token, &state.settings) else {
            return Err(unauthorized(state));
        };
        if !token_version_matches(&state.pool, claims.user_id, claims.token_version).await {
            return Err(unauthorized(state));
        }
        claims.user_id
    };

    if let Some(ent) = entitlement() {
        if !ent.is_premium(&state.pool, user_id).await {
            return Err(paid_required(state));
        }
    }

    Ok(user_id)
}

async fn token_version_matches(pool: &PgPool, user_id: Uuid, expected: i64) -> bool {
    let row = sqlx::query_scalar::<_, i32>("SELECT token_version FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await;
    matches!(row, Ok(Some(tv)) if i64::from(tv) == expected)
}

fn protected_resource_url(state: &AppState) -> String {
    format!(
        "{}/api/mcp/.well-known/oauth-protected-resource",
        state.settings.app_origin.trim_end_matches('/')
    )
}

fn auth_challenge(state: &AppState, status: StatusCode, message: &str) -> Response {
    let body = json!({ "error": message }).to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::WWW_AUTHENTICATE,
            format!("Bearer resource_metadata=\"{}\"", protected_resource_url(state)),
        )
        .body(Body::from(body))
        .unwrap()
}

fn unauthorized(state: &AppState) -> Response {
    auth_challenge(
        state,
        StatusCode::UNAUTHORIZED,
        "Missing, invalid or expired bearer token",
    )
}

fn paid_required(state: &AppState) -> Response {
    auth_challenge(
        state,
        StatusCode::PAYMENT_REQUIRED,
        "MCP requires an active Premium subscription",
    )
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

fn sse(payload: Value) -> Response {
    let body = format!("event: message\ndata: {payload}\n\n");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from(body))
        .unwrap()
}

fn accepted() -> Response {
    Response::builder()
        .status(StatusCode::ACCEPTED)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::empty())
        .unwrap()
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn post_mcp(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let user_id = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(resp) => return resp,
    };

    let payload: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return sse(rpc_err(&Value::Null, -32700, "Parse error")),
    };

    if let Some(items) = payload.as_array() {
        if items.is_empty() {
            return sse(rpc_err(&Value::Null, -32600, "Invalid Request"));
        }
        let mut out = Vec::new();
        for item in items {
            if let Some(resp) = handle_message(&state, user_id, item).await {
                out.push(resp);
            }
        }
        if out.is_empty() {
            return accepted();
        }
        return sse(Value::Array(out));
    }

    match handle_message(&state, user_id, &payload).await {
        Some(resp) => sse(resp),
        None => accepted(),
    }
}

async fn handle_message(state: &AppState, user_id: Uuid, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    if method.starts_with("notifications/") {
        return None;
    }

    let resp = match method {
        "initialize" => rpc_ok(&id, initialize_result(&params)),
        "ping" => rpc_ok(&id, json!({})),
        "tools/list" => rpc_ok(&id, json!({ "tools": tools_list() })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name.is_empty() {
                rpc_err(&id, -32602, "Invalid params: name is required")
            } else {
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                match call_tool(state, user_id, name, &args).await {
                    Ok(v) => {
                        // MCP mutations bypass the HTTP event middleware, so
                        // publish here to keep SSE clients in sync (same as the
                        // in-app AI tool path).
                        if let Some(resource) = crate::ai_tools::mutation_resource(name) {
                            state.events.publish(user_id, resource);
                        }
                        rpc_ok(&id, tool_success(v))
                    }
                    Err(e) => rpc_ok(&id, tool_error(&e)),
                }
            }
        }
        _ => rpc_err(&id, -32601, "Method not found"),
    };
    Some(resp)
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let protocol = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested.to_string()
    } else {
        LATEST_PROTOCOL_VERSION.to_string()
    };
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
    })
}

fn tool_success(value: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": value.to_string() }],
        "isError": false,
    })
}

fn tool_error(message: &str) -> Value {
    let body = json!({ "error": message }).to_string();
    json!({
        "content": [{ "type": "text", "text": body }],
        "isError": true,
    })
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn tools_list() -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "search_tasks",
            "description": "Search tasks by title/description. Use when the user asks to find tasks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "default": 20 },
                },
                "required": ["query"],
            },
        }),
        json!({
            "name": "create_task",
            "description": "Create a new task. Pass start_date/due_date as YYYY-MM-DD. Returns the created task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "description": { "type": "string" },
                    "start_date": { "type": "string" },
                    "due_date": { "type": "string" },
                    "priority": { "type": "integer", "default": 2 },
                    "status": { "type": "string", "default": "backlog" },
                    "recurrence_rule": { "type": "string" },
                    "recurrence_end_date": { "type": "string" },
                },
                "required": ["title"],
            },
        }),
        json!({
            "name": "get_task_details",
            "description": "Fetch full details of a single task, including tags and subtasks.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"],
            },
        }),
        json!({
            "name": "update_task",
            "description": "Update fields on an existing task. Only include fields that changed. Use status='done' to complete a task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "title": { "type": "string" },
                    "description": { "type": "string" },
                    "status": { "type": "string" },
                    "priority": { "type": "integer" },
                    "start_date": { "type": "string" },
                    "due_date": { "type": "string" },
                    "recurrence_rule": { "type": "string" },
                    "recurrence_end_date": { "type": "string" },
                    "is_archived": { "type": "boolean" },
                },
                "required": ["task_id"],
            },
        }),
        json!({
            "name": "complete_task",
            "description": "Mark a task as done/completed. Use when the user says a task is finished.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"],
            },
        }),
        json!({
            "name": "delete_task",
            "description": "Permanently delete a task. DESTRUCTIVE: only call after the user explicitly confirms which task to delete.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"],
            },
        }),
        json!({
            "name": "list_tasks_by_date_range",
            "description": "List open tasks overlapping a date range (YYYY-MM-DD to YYYY-MM-DD). Use to check what is already scheduled.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "date_from": { "type": "string" },
                    "date_to": { "type": "string" },
                },
                "required": ["date_from", "date_to"],
            },
        }),
        json!({
            "name": "check_calendar",
            "description": "Return how many open tasks are scheduled on each day in a range (calendar density / conflict check).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "date_from": { "type": "string" },
                    "date_to": { "type": "string" },
                },
                "required": ["date_from", "date_to"],
            },
        }),
        json!({
            "name": "list_tags",
            "description": "List the user's tags.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "add_tag_to_task",
            "description": "Attach a tag to a task, creating the tag if needed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "tag_name": { "type": "string" },
                },
                "required": ["task_id", "tag_name"],
            },
        }),
        json!({
            "name": "search_titles",
            "description": "Search movies and TV shows by title (TMDB). Returns matches with tmdb_id, media_type, title, release_year and poster_url.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
            },
        }),
        json!({
            "name": "list_watchlist",
            "description": "List the user's watchlist items, optionally filtered by status (plan_to_watch, watching, watched).",
            "inputSchema": {
                "type": "object",
                "properties": { "status": { "type": "string" } },
            },
        }),
        json!({
            "name": "add_watchlist_item",
            "description": "Add a movie or TV show to the watchlist using tmdb_id and media_type from search_titles. rating is 1-10.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tmdb_id": { "type": "integer" },
                    "media_type": { "type": "string" },
                    "title": { "type": "string" },
                    "release_year": { "type": "integer" },
                    "poster_path": { "type": "string" },
                    "status": { "type": "string" },
                    "rating": { "type": "integer" },
                    "notes": { "type": "string" },
                },
                "required": ["tmdb_id", "media_type"],
            },
        }),
        json!({
            "name": "update_watchlist_item",
            "description": "Update a watchlist item (status, rating 1-10, notes, watched_at YYYY-MM-DD).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": { "type": "string" },
                    "status": { "type": "string" },
                    "rating": { "type": "integer" },
                    "notes": { "type": "string" },
                    "watched_at": { "type": "string" },
                },
                "required": ["item_id"],
            },
        }),
        json!({
            "name": "remove_watchlist_item",
            "description": "Permanently remove a watchlist item. DESTRUCTIVE: require explicit user confirmation before calling.",
            "inputSchema": {
                "type": "object",
                "properties": { "item_id": { "type": "string" } },
                "required": ["item_id"],
            },
        }),
        json!({
            "name": "list_habits",
            "description": "List the user's habits with current streak.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "create_habit",
            "description": "Create a new habit. title, frequency (daily/weekly/monthly), optional target_count and color.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "frequency": { "type": "string", "default": "daily" },
                    "target_count": { "type": "integer", "default": 1 },
                    "color": { "type": "string" },
                },
                "required": ["title"],
            },
        }),
        json!({
            "name": "update_habit",
            "description": "Update a habit. habit_id required, plus any of title, frequency, target_count, color.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "habit_id": { "type": "string" },
                    "title": { "type": "string" },
                    "frequency": { "type": "string" },
                    "target_count": { "type": "integer" },
                    "color": { "type": "string" },
                },
                "required": ["habit_id"],
            },
        }),
        json!({
            "name": "delete_habit",
            "description": "Permanently delete a habit and its log history. DESTRUCTIVE: require explicit user confirmation.",
            "inputSchema": {
                "type": "object",
                "properties": { "habit_id": { "type": "string" } },
                "required": ["habit_id"],
            },
        }),
        json!({
            "name": "toggle_habit_log",
            "description": "Log (or unlog) today's completion for a habit. Returns logged, streak and date.",
            "inputSchema": {
                "type": "object",
                "properties": { "habit_id": { "type": "string" } },
                "required": ["habit_id"],
            },
        }),
        json!({
            "name": "get_habit_logs",
            "description": "List log dates for a habit, optionally filtered by from/to YYYY-MM-DD.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "habit_id": { "type": "string" },
                    "from_date": { "type": "string" },
                    "to_date": { "type": "string" },
                },
                "required": ["habit_id"],
            },
        }),
    ];
    if let Some(ee) = ee_tools() {
        tools.extend(ee.tool_definitions());
    }
    tools
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async fn call_tool(
    state: &AppState,
    user_id: Uuid,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "search_tasks" => search_tasks(state, user_id, args).await,
        "create_task" => {
            let mut v = args.clone();
            if v.get("priority").is_none() {
                v["priority"] = json!(2);
            }
            let req: tasks::CreateTaskRequest = parse_args(&v)?;
            let full = tasks::svc_create_task(state, user_id, req)
                .await
                .map_err(api_err_msg)?;
            Ok(json!({ "created": true, "task": brief_from_value(&full) }))
        }
        "get_task_details" => get_task_details(state, user_id, args).await,
        "update_task" => {
            let id = parse_uuid(arg_str(args, "task_id")?, "task_id")?;
            let req: tasks::UpdateTaskRequest = parse_args(args)?;
            let full = tasks::svc_update_task(state, user_id, id, req)
                .await
                .map_err(api_err_msg)?;
            Ok(json!({ "updated": true, "task": brief_from_value(&full) }))
        }
        "complete_task" => {
            let raw = arg_str(args, "task_id")?;
            let id = parse_uuid(raw, "task_id")?;
            let req = tasks::UpdateTaskRequest {
                status: Some("done".to_string()),
                ..Default::default()
            };
            tasks::svc_update_task(state, user_id, id, req)
                .await
                .map_err(api_err_msg)?;
            Ok(json!({ "completed": true, "task_id": raw, "status": "done" }))
        }
        "delete_task" => {
            let raw = arg_str(args, "task_id")?;
            let id = parse_uuid(raw, "task_id")?;
            tasks::svc_delete_task_permanent(state, user_id, id)
                .await
                .map_err(api_err_msg)?;
            Ok(json!({ "deleted": true, "task_id": raw }))
        }
        "list_tasks_by_date_range" => list_tasks_by_date_range(state, user_id, args).await,
        "check_calendar" => check_calendar(state, user_id, args).await,
        "list_tags" => {
            let arr = tags::svc_list_tags(state, user_id)
                .await
                .map_err(api_err_msg)?;
            let list = arr.as_array().cloned().unwrap_or_default();
            Ok(json!({ "count": list.len(), "tags": list }))
        }
        "add_tag_to_task" => {
            let id = parse_uuid(arg_str(args, "task_id")?, "task_id")?;
            let tag_name = arg_str(args, "tag_name")?;
            tags::svc_add_tag_to_task(state, user_id, id, tag_name.to_string())
                .await
                .map_err(api_err_msg)
        }
        "search_titles" => {
            let query = arg_str(args, "query")?;
            watchlist::svc_search_titles(state, query.to_string())
                .await
                .map_err(api_err_msg)
        }
        "list_watchlist" => {
            let status = args
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            watchlist::svc_list_watchlist(state, user_id, status)
                .await
                .map_err(api_err_msg)
        }
        "add_watchlist_item" => {
            let req: watchlist::WatchlistAddRequest = parse_args(args)?;
            watchlist::svc_add_watchlist_item(state, user_id, req)
                .await
                .map_err(api_err_msg)
        }
        "update_watchlist_item" => {
            let id = parse_uuid(arg_str(args, "item_id")?, "item_id")?;
            watchlist::svc_update_watchlist_item(state, user_id, id, args.clone())
                .await
                .map_err(api_err_msg)
        }
        "remove_watchlist_item" => {
            let raw = arg_str(args, "item_id")?;
            let id = parse_uuid(raw, "item_id")?;
            watchlist::svc_remove_watchlist_item(state, user_id, id)
                .await
                .map_err(api_err_msg)?;
            Ok(json!({ "removed": true, "item_id": raw }))
        }
        "list_habits" => habits::svc_list_habits(state, user_id)
            .await
            .map_err(api_err_msg),
        "create_habit" => {
            let req: habits::CreateHabitRequest = parse_args(args)?;
            habits::svc_create_habit(state, user_id, req)
                .await
                .map_err(api_err_msg)
        }
        "update_habit" => {
            let id = parse_uuid(arg_str(args, "habit_id")?, "habit_id")?;
            let req: habits::UpdateHabitRequest = parse_args(args)?;
            habits::svc_update_habit(state, user_id, id, req)
                .await
                .map_err(api_err_msg)
        }
        "delete_habit" => {
            let raw = arg_str(args, "habit_id")?;
            let id = parse_uuid(raw, "habit_id")?;
            habits::svc_delete_habit(state, user_id, id)
                .await
                .map_err(api_err_msg)?;
            Ok(json!({ "deleted": true, "habit_id": raw }))
        }
        "toggle_habit_log" => {
            let id = parse_uuid(arg_str(args, "habit_id")?, "habit_id")?;
            habits::svc_toggle_habit_log(state, user_id, id)
                .await
                .map_err(api_err_msg)
        }
        "get_habit_logs" => {
            let id = parse_uuid(arg_str(args, "habit_id")?, "habit_id")?;
            let from = args
                .get("from_date")
                .and_then(|v| v.as_str())
                .map(|s| parse_date(s, "from_date"))
                .transpose()?;
            let to = args
                .get("to_date")
                .and_then(|v| v.as_str())
                .map(|s| parse_date(s, "to_date"))
                .transpose()?;
            habits::svc_get_habit_logs(state, user_id, id, from, to)
                .await
                .map_err(api_err_msg)
        }
        _ => {
            if let Some(ee) = ee_tools() {
                if let Some(result) = ee.call(state, user_id, name, args).await {
                    return result.map_err(api_err_msg);
                }
            }
            Err(format!("Unknown tool: {name}"))
        }
    }
}

async fn search_tasks(state: &AppState, user_id: Uuid, args: &Value) -> Result<Value, String> {
    let query = arg_str(args, "query")?;
    let limit = args
        .get("limit")
        .and_then(|l| l.as_i64())
        .unwrap_or(20)
        .clamp(1, 100);
    let mut tx = begin(state, user_id).await?;
    let rows = task::search_tasks(&mut *tx, user_id, query, limit)
        .await
        .map_err(db_msg)?;
    let tasks: Vec<Value> = rows
        .iter()
        .map(|(t, rank)| {
            let mut b = brief(t);
            b["rank"] = json!((rank * 1000.0).round() / 1000.0);
            b
        })
        .collect();
    tx.commit().await.map_err(db_msg)?;
    Ok(json!({ "count": tasks.len(), "tasks": tasks }))
}

async fn get_task_details(state: &AppState, user_id: Uuid, args: &Value) -> Result<Value, String> {
    let raw = arg_str(args, "task_id")?;
    let id = match Uuid::parse_str(raw) {
        Ok(u) => u,
        Err(_) => return Ok(json!({ "error": "Invalid task_id format" })),
    };
    let mut tx = begin(state, user_id).await?;
    let Some(t) = task::find_task(&mut *tx, id, user_id, false)
        .await
        .map_err(db_msg)?
    else {
        return Ok(json!({ "error": "Task not found" }));
    };
    let mut tags_map = task::tags_for(&mut *tx, &[id]).await.map_err(db_msg)?;
    let tag_values = tags_map.remove(&id).unwrap_or_default();
    let subtask_rows = sqlx::query(
        "SELECT id, title, status::text AS status FROM tasks \
         WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL \
         ORDER BY sort_order, created_at",
    )
    .bind(id)
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_msg)?;
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
    tx.commit().await.map_err(db_msg)?;

    let mut b = brief(&t);
    if let Some(obj) = b.as_object_mut() {
        obj.insert("tags".to_string(), json!(tag_values));
        obj.insert("subtasks".to_string(), json!(subtasks));
        obj.insert("recurrence_rule".to_string(), json!(t.recurrence_rule));
        obj.insert(
            "recurrence_end_date".to_string(),
            json!(t.recurrence_end_date.map(|d| d.to_string())),
        );
        obj.insert("estimated_minutes".to_string(), json!(t.estimated_minutes));
    }
    Ok(b)
}

async fn list_tasks_by_date_range(
    state: &AppState,
    user_id: Uuid,
    args: &Value,
) -> Result<Value, String> {
    let from = parse_date(arg_str(args, "date_from")?, "date_from")?;
    let to = parse_date(arg_str(args, "date_to")?, "date_to")?;
    let mut tx = begin(state, user_id).await?;
    let sql = format!(
        "SELECT {columns} FROM tasks WHERE user_id = $1 AND deleted_at IS NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND ((start_date BETWEEN $2 AND $3) OR (due_date BETWEEN $2 AND $3)) \
         ORDER BY start_date NULLS LAST, due_date",
        columns = task::COLUMNS
    );
    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(from)
        .bind(to)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_msg)?;
    let tasks: Vec<Value> = rows
        .iter()
        .filter_map(|r| task::Task::from_row(r).ok())
        .map(|t| brief(&t))
        .collect();
    tx.commit().await.map_err(db_msg)?;
    Ok(json!({
        "date_from": from.to_string(),
        "date_to": to.to_string(),
        "count": tasks.len(),
        "tasks": tasks,
    }))
}

async fn check_calendar(state: &AppState, user_id: Uuid, args: &Value) -> Result<Value, String> {
    let from = parse_date(arg_str(args, "date_from")?, "date_from")?;
    let to = parse_date(arg_str(args, "date_to")?, "date_to")?;
    let mut tx = begin(state, user_id).await?;
    let rows = sqlx::query(
        "SELECT start_date::text AS day, COUNT(*) AS count FROM tasks \
         WHERE user_id = $1 AND deleted_at IS NULL \
         AND status::text NOT IN ('done', 'cancelled') \
         AND start_date IS NOT NULL AND start_date BETWEEN $2 AND $3 \
         GROUP BY start_date ORDER BY start_date",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_msg)?;
    let density: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "date": r.get::<String, _>("day"),
                "count": r.get::<i64, _>("count"),
            })
        })
        .collect();
    tx.commit().await.map_err(db_msg)?;
    Ok(json!({
        "date_from": from.to_string(),
        "date_to": to.to_string(),
        "density": density,
    }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn begin(
    state: &AppState,
    user_id: Uuid,
) -> Result<sqlx::Transaction<'_, sqlx::Postgres>, String> {
    let mut tx = state.pool.begin().await.map_err(db_msg)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_msg)?;
    Ok(tx)
}

fn db_msg(err: sqlx::Error) -> String {
    format!("database error: {err}")
}

fn api_err_msg(err: ApiError) -> String {
    match err {
        ApiError::BadRequest(m)
        | ApiError::Unauthorized(m)
        | ApiError::Forbidden(m)
        | ApiError::NotFound(m)
        | ApiError::Conflict(m)
        | ApiError::TooManyRequests(m)
        | ApiError::PaymentRequired(m)
        | ApiError::BadGateway(m)
        | ApiError::ServiceUnavailable(m)
        | ApiError::Unprocessable(m)
        | ApiError::PayloadTooLarge(m)
        | ApiError::Internal(m) => m,
    }
}

fn parse_args<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {e}"))
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

fn parse_uuid(raw: &str, label: &str) -> Result<Uuid, String> {
    Uuid::parse_str(raw).map_err(|_| format!("Invalid {label} format"))
}

fn parse_date(raw: &str, label: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| format!("Invalid {label}: expected YYYY-MM-DD"))
}

fn brief(t: &task::Task) -> Value {
    json!({
        "id": t.id.to_string(),
        "title": t.title,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "start_date": t.start_date.map(|d| d.to_string()),
        "due_date": t.due_date.map(|d| d.to_string()),
        "is_archived": t.is_archived,
    })
}

fn brief_from_value(v: &Value) -> Value {
    json!({
        "id": v.get("id").cloned().unwrap_or(Value::Null),
        "title": v.get("title").cloned().unwrap_or(Value::Null),
        "description": v.get("description").cloned().unwrap_or(Value::Null),
        "status": v.get("status").cloned().unwrap_or(Value::Null),
        "priority": v.get("priority").cloned().unwrap_or(Value::Null),
        "start_date": v.get("start_date").cloned().unwrap_or(Value::Null),
        "due_date": v.get("due_date").cloned().unwrap_or(Value::Null),
        "is_archived": v.get("is_archived").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    fn lazy_app() -> Router {
        crate::build_router(AppState::lazy(crate::config::Settings::from_env()), None)
    }

    fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let mut settings = crate::config::tests::sample("test");
        settings.database_url = url;
        Some(AppState::lazy(settings))
    }

    /// Pull the JSON-RPC object out of the `event: message` SSE frame.
    fn sse_json(bytes: &[u8]) -> Value {
        let text = String::from_utf8_lossy(bytes);
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                return serde_json::from_str(data).unwrap_or(Value::Null);
            }
        }
        Value::Null
    }

    #[tokio::test]
    async fn protected_resource_metadata_is_public() {
        let res = lazy_app()
            .oneshot(
                Request::builder()
                    .uri("/api/mcp/.well-known/oauth-protected-resource")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["resource"]
            .as_str()
            .unwrap()
            .ends_with("/api/mcp"));
        assert_eq!(body["scopes_supported"], json!(["tasks", "watchlist", "habits"]));
    }

    #[tokio::test]
    async fn missing_bearer_is_unauthorized() {
        let res = lazy_app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert!(res.headers().contains_key(header::WWW_AUTHENTICATE));
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Missing, invalid or expired bearer token");
    }

    #[tokio::test]
    async fn pat_authed_tools_list_and_call() {
        let Some(state) = live_state() else {
            return;
        };
        let email = format!("rust-mcp-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .expect("create user");
        let mut conn = state.pool.acquire().await.expect("conn");
        let (pat, _row) = crate::api_token::create_token(&mut conn, user.id, Some("MCP test"))
            .await
            .expect("create token");
        drop(conn);

        let app = crate::build_router(state.clone(), None);

        let post = |body: Value| {
            let app = app.clone();
            let auth = format!("Bearer {pat}");
            async move {
                let res = app
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri("/api/mcp")
                            .header("content-type", "application/json")
                            .header("authorization", auth)
                            .body(Body::from(body.to_string()))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = res.status();
                let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
                (status, bytes)
            }
        };

        // initialize
        let (status, bytes) = post(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let init = sse_json(&bytes);
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);

        // tools/list
        let (status, bytes) =
            post(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await;
        assert_eq!(status, StatusCode::OK);
        let list = sse_json(&bytes);
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 21);

        // tools/call create_task
        let mut event_rx = state.events.subscribe();
        let (status, bytes) = post(json!({
            "jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"create_task","arguments":{"title":"MCP integration task"}}
        }))
        .await;
        assert_eq!(status, StatusCode::OK);
        let call = sse_json(&bytes);
        assert_eq!(call["result"]["isError"], false);
        let payload: Value = serde_json::from_str(
            call["result"]["content"][0]["text"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(payload["created"], true);
        assert_eq!(payload["task"]["title"], "MCP integration task");
        let task_id = payload["task"]["id"].as_str().unwrap().to_string();

        // An MCP mutation must publish the change event the SSE stream fans out.
        let event = tokio::time::timeout(std::time::Duration::from_millis(500), event_rx.recv())
            .await
            .expect("MCP create must publish a change event")
            .expect("event bus open");
        assert_eq!(event.user_id, user.id);
        assert_eq!(event.resource, "tasks");

        // tools/call get_task_details sees it
        let (status, bytes) = post(json!({
            "jsonrpc":"2.0","id":4,"method":"tools/call",
            "params":{"name":"get_task_details","arguments":{"task_id":task_id}}
        }))
        .await;
        assert_eq!(status, StatusCode::OK);
        let details = sse_json(&bytes);
        let task: Value =
            serde_json::from_str(details["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(task["title"], "MCP integration task");

        for sql in [
            "DELETE FROM tasks WHERE user_id = $1",
            "DELETE FROM api_tokens WHERE user_id = $1",
            "DELETE FROM users WHERE id = $1",
        ] {
            sqlx::query(sql)
                .bind(user.id)
                .execute(&state.pool)
                .await
                .expect("cleanup");
        }
    }

    #[test]
    fn tools_list_has_core_tools() {
        let tools = tools_list();
        assert_eq!(tools.len(), 21);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .collect();
        for expected in [
            "search_tasks",
            "create_task",
            "get_task_details",
            "update_task",
            "complete_task",
            "delete_task",
            "list_tasks_by_date_range",
            "check_calendar",
            "list_tags",
            "add_tag_to_task",
            "search_titles",
            "list_watchlist",
            "add_watchlist_item",
            "update_watchlist_item",
            "remove_watchlist_item",
            "list_habits",
            "create_habit",
            "update_habit",
            "delete_habit",
            "toggle_habit_log",
            "get_habit_logs",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn initialize_negotiates_protocol() {
        let known = initialize_result(&json!({ "protocolVersion": "2025-06-18" }));
        assert_eq!(known["protocolVersion"], "2025-06-18");
        assert_eq!(known["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(known["capabilities"]["tools"]["listChanged"], false);

        let fallback = initialize_result(&json!({ "protocolVersion": "bogus" }));
        assert_eq!(fallback["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }
}
