//! Teams, membership, invites and shared task access.
//!
//! Mirrors `apps/backend/app/routers/teams.py`. RLS on the team tables already
//! scopes rows to the caller, so the handlers set `app.user_id`/`app.user_email`
//! and rely on the policies plus explicit membership checks for authorization.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::ratelimit::RateLimiter;
use crate::task::{self, Task};
use crate::{db, AppState};

const INVITE_LIMIT: u32 = 20;
const INVITE_WINDOW_SECS: u64 = 3600;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/teams", get(list_teams).post(create_team))
        .route("/api/teams/", get(list_teams).post(create_team))
        .route("/api/teams/invites/{token}", get(get_invite))
        .route("/api/teams/invites/{token}/accept", post(accept_invite))
        .route("/api/teams/invites/{token}/decline", post(decline_invite))
        .route(
            "/api/teams/{team_id}",
            get(get_team_detail).patch(update_team).delete(delete_team),
        )
        .route("/api/teams/{team_id}/members", post(invite_member))
        .route(
            "/api/teams/{team_id}/members/{user_id}",
            patch(update_member_role).delete(remove_member),
        )
        .route("/api/teams/{team_id}/projects", post(create_project))
        .route(
            "/api/teams/{team_id}/projects/{project_id}",
            delete(delete_project),
        )
        .route("/api/teams/{team_id}/share-task", post(share_task))
        .route(
            "/api/teams/{team_id}/share-task/{task_id}",
            delete(unshare_task),
        )
        .route("/api/teams/{team_id}/tasks", get(team_tasks))
}

fn invite_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::from_env("rl:team_invites"))
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

/// Sets `app.user_id` and then `app.user_email` so the invite policy can match
/// the caller by email. Returns the caller's email.
async fn set_rls_for(conn: &mut PgConnection, user_id: Uuid) -> Result<String, ApiError> {
    db::set_rls_user(&mut *conn, user_id, "")
        .await
        .map_err(db_error)?;
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db_error)?;
    let email = email.unwrap_or_default();
    db::set_rls_user(&mut *conn, user_id, &email)
        .await
        .map_err(db_error)?;
    Ok(email)
}

fn validate_name(raw: &str, what: &str) -> Result<String, ApiError> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > 100 {
        return Err(ApiError::Unprocessable(format!(
            "{what} must be 1-100 characters"
        )));
    }
    Ok(value.to_string())
}

fn validate_role(raw: &str) -> Result<String, ApiError> {
    match raw {
        "owner" | "admin" | "member" => Ok(raw.to_string()),
        _ => Err(ApiError::Unprocessable(
            "Role must be owner, admin or member".to_string(),
        )),
    }
}

fn default_member_role() -> String {
    "member".to_string()
}

#[derive(Deserialize)]
struct CreateTeamRequest {
    name: String,
}

#[derive(Deserialize)]
struct InviteMemberRequest {
    email: String,
    #[serde(default = "default_member_role")]
    role: String,
}

#[derive(Deserialize)]
struct CreateProjectRequest {
    name: String,
}

#[derive(Deserialize)]
struct UpdateRoleRequest {
    role: String,
}

#[derive(Deserialize)]
struct ShareTaskRequest {
    task_id: String,
}

struct TeamRow {
    id: Uuid,
    name: String,
    owner_id: Uuid,
    created_at: DateTime<Utc>,
}

struct InviteRow {
    id: Uuid,
    team_id: Uuid,
    email: String,
    role: String,
}

async fn load_team(conn: &mut PgConnection, team_id: Uuid) -> Result<TeamRow, ApiError> {
    let row = sqlx::query("SELECT id, name, owner_id, created_at FROM teams WHERE id = $1")
        .bind(team_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db_error)?;
    let Some(row) = row else {
        return Err(ApiError::NotFound("Team not found".to_string()));
    };
    Ok(TeamRow {
        id: row.get("id"),
        name: row.get("name"),
        owner_id: row.get("owner_id"),
        created_at: row.get("created_at"),
    })
}

async fn membership_role(
    conn: &mut PgConnection,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db_error)
}

async fn require_membership(
    conn: &mut PgConnection,
    team_id: Uuid,
    user_id: Uuid,
    roles: &[&str],
) -> Result<String, ApiError> {
    match membership_role(conn, team_id, user_id).await? {
        Some(role) if roles.contains(&role.as_str()) => Ok(role),
        _ => Err(ApiError::Forbidden("Not allowed".to_string())),
    }
}

async fn serialize_team(
    conn: &mut PgConnection,
    team: &TeamRow,
    my_role: Option<&str>,
) -> Result<Value, ApiError> {
    let member_rows = sqlx::query(
        "SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY created_at",
    )
    .bind(team.id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;
    let member_ids: Vec<Uuid> = member_rows.iter().map(|r| r.get("user_id")).collect();
    let emails: HashMap<Uuid, String> = if member_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query("SELECT id, email FROM users WHERE id = ANY($1)")
            .bind(&member_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db_error)?
            .into_iter()
            .map(|r| (r.get::<Uuid, _>("id"), r.get::<String, _>("email")))
            .collect()
    };
    let members: Vec<Value> = member_rows
        .iter()
        .map(|r| {
            let user_id: Uuid = r.get("user_id");
            json!({
                "user_id": user_id.to_string(),
                "email": emails.get(&user_id),
                "role": r.get::<String, _>("role"),
            })
        })
        .collect();

    let project_rows =
        sqlx::query("SELECT id, name FROM team_projects WHERE team_id = $1 ORDER BY created_at")
            .bind(team.id)
            .fetch_all(&mut *conn)
            .await
            .map_err(db_error)?;
    let projects: Vec<Value> = project_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id").to_string(),
                "name": r.get::<String, _>("name"),
            })
        })
        .collect();

    let mut data = json!({
        "id": team.id.to_string(),
        "name": team.name,
        "owner_id": team.owner_id.to_string(),
        "members": members,
        "projects": projects,
        "created_at": team.created_at.to_rfc3339(),
    });
    if let Some(role) = my_role {
        data["my_role"] = json!(role);
    }
    Ok(data)
}

async fn load_pending_invite(
    conn: &mut PgConnection,
    token: &str,
    user_email: &str,
) -> Result<InviteRow, ApiError> {
    let row =
        sqlx::query("SELECT id, team_id, email, role, status FROM team_invites WHERE token = $1")
            .bind(token)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db_error)?;
    let Some(row) = row else {
        return Err(ApiError::NotFound("Invite not found or used".to_string()));
    };
    let status: String = row.get("status");
    if status != "pending" {
        return Err(ApiError::NotFound("Invite not found or used".to_string()));
    }
    let email: String = row.get("email");
    if email.to_lowercase() != user_email.to_lowercase() {
        return Err(ApiError::Forbidden(
            "Invite is for a different email".to_string(),
        ));
    }
    Ok(InviteRow {
        id: row.get("id"),
        team_id: row.get("team_id"),
        email,
        role: row.get("role"),
    })
}

async fn list_teams(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    let email = set_rls_for(&mut *tx, user.user_id).await?;

    let rows = sqlx::query(
        "SELECT t.id, t.name, t.owner_id, t.created_at, m.role \
         FROM teams t JOIN team_members m ON m.team_id = t.id \
         WHERE m.user_id = $1 ORDER BY t.created_at DESC",
    )
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;

    let mut teams = Vec::with_capacity(rows.len());
    for row in &rows {
        let team = TeamRow {
            id: row.get("id"),
            name: row.get("name"),
            owner_id: row.get("owner_id"),
            created_at: row.get("created_at"),
        };
        let role: String = row.get("role");
        teams.push(serialize_team(&mut *tx, &team, Some(&role)).await?);
    }

    let inv_rows = sqlx::query(
        "SELECT token, team_id, email, role FROM team_invites WHERE status = 'pending'",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    let mut invites = Vec::new();
    for row in &inv_rows {
        let invite_email: String = row.get("email");
        if invite_email.to_lowercase() != email.to_lowercase() {
            continue;
        }
        let team_id: Uuid = row.get("team_id");
        let team_name: Option<String> = sqlx::query_scalar("SELECT name FROM teams WHERE id = $1")
            .bind(team_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
        invites.push(json!({
            "token": row.get::<String, _>("token"),
            "team_id": team_id.to_string(),
            "team_name": team_name.unwrap_or_else(|| "Team".to_string()),
            "role": row.get::<String, _>("role"),
        }));
    }

    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "teams": teams, "invites": invites })))
}

async fn create_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateTeamRequest>,
) -> Result<Json<Value>, ApiError> {
    let name = validate_name(&req.name, "Team name")?;
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    let team_id: Uuid =
        sqlx::query_scalar("INSERT INTO teams (owner_id, name) VALUES ($1, $2) RETURNING id")
            .bind(user.user_id)
            .bind(&name)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(team_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    let team = load_team(&mut *tx, team_id).await?;
    let data = serialize_team(&mut *tx, &team, Some("owner")).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(data))
}

async fn get_team_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    let team = load_team(&mut *tx, team_id).await?;
    let role = membership_role(&mut *tx, team_id, user.user_id).await?;
    let Some(role) = role else {
        return Err(ApiError::Forbidden("Not a member".to_string()));
    };
    let data = serialize_team(&mut *tx, &team, Some(&role)).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(data))
}

async fn update_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    Json(req): Json<CreateTeamRequest>,
) -> Result<Json<Value>, ApiError> {
    let name = validate_name(&req.name, "Team name")?;
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(&mut *tx, team_id, user.user_id, &["owner", "admin"]).await?;
    sqlx::query("UPDATE teams SET name = $1, updated_at = now() WHERE id = $2")
        .bind(&name)
        .bind(team_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    let team = load_team(&mut *tx, team_id).await?;
    let data = serialize_team(&mut *tx, &team, None).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(data))
}

async fn delete_team(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(&mut *tx, team_id, user.user_id, &["owner"]).await?;
    sqlx::query("DELETE FROM teams WHERE id = $1")
        .bind(team_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn invite_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    Json(req): Json<InviteMemberRequest>,
) -> Result<Json<Value>, ApiError> {
    let email = req.email.trim().to_lowercase();
    let role = validate_role(&req.role)?;
    let original_email = req.email.clone();
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    let team = load_team(&mut *tx, team_id).await?;
    require_membership(&mut *tx, team_id, user.user_id, &["owner", "admin"]).await?;

    let count = invite_limiter()
        .count(
            &user.user_id.to_string(),
            Duration::from_secs(INVITE_WINDOW_SECS),
        )
        .await;
    if count > INVITE_LIMIT {
        return Err(ApiError::TooManyRequests(
            "Too many invites - try again later".to_string(),
        ));
    }

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM team_invites WHERE team_id = $1 AND lower(email) = lower($2) AND status = 'pending'",
    )
    .bind(team_id)
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    if existing.is_some() {
        return Err(ApiError::BadRequest("Invite already pending".to_string()));
    }

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO team_invites (team_id, invited_by, email, role, token, status) VALUES ($1, $2, $3, $4, $5, 'pending')",
    )
    .bind(team_id)
    .bind(user.user_id)
    .bind(&email)
    .bind(&role)
    .bind(&token)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let settings = state.settings.clone();
    let subject = format!("You're invited to join {} on Prysm Note", team.name);
    let body = format!(
        "Join the '{}' team: {}/settings?tab=collaborate&invite={}\n\nIf you don't have an account yet, register first, then open the same link.",
        team.name, settings.app_origin, token
    );
    let to = email.clone();
    tokio::spawn(async move {
        crate::email::send_email(&settings, &to, &subject, &body, None).await;
    });

    Ok(Json(
        json!({ "status": "invited", "email": original_email }),
    ))
}

async fn update_member_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((team_id, user_id)): Path<(String, String)>,
    Json(req): Json<UpdateRoleRequest>,
) -> Result<Json<Value>, ApiError> {
    let role = validate_role(&req.role)?;
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let target_id = task::require_uuid(&user_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    let actor_role =
        require_membership(&mut *tx, team_id, user.user_id, &["owner", "admin"]).await?;

    let target_role = membership_role(&mut *tx, team_id, target_id).await?;
    let Some(target_role) = target_role else {
        return Err(ApiError::NotFound("Member not found".to_string()));
    };

    if (role == "owner" || target_role == "owner") && actor_role != "owner" {
        return Err(ApiError::Forbidden(
            "Only the owner can manage the owner role".to_string(),
        ));
    }
    if target_role == "owner" && role != "owner" {
        let owner_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM team_members WHERE team_id = $1 AND role = 'owner'",
        )
        .bind(team_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
        if owner_count <= 1 {
            return Err(ApiError::BadRequest(
                "Cannot demote the last owner".to_string(),
            ));
        }
    }

    sqlx::query("UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3")
        .bind(&role)
        .bind(team_id)
        .bind(target_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "updated" })))
}

async fn remove_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((team_id, user_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let target_id = task::require_uuid(&user_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    let actor_role =
        require_membership(&mut *tx, team_id, user.user_id, &["owner", "admin"]).await?;

    let target_role = membership_role(&mut *tx, team_id, target_id).await?;
    let Some(target_role) = target_role else {
        return Err(ApiError::NotFound("Member not found".to_string()));
    };
    if target_role == "owner" {
        return Err(ApiError::BadRequest("Cannot remove the owner".to_string()));
    }
    if actor_role != "owner" && target_role != "member" {
        return Err(ApiError::Forbidden(
            "Admins can only remove members".to_string(),
        ));
    }

    sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "removed" })))
}

async fn get_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    let email = set_rls_for(&mut *tx, user.user_id).await?;

    let invite = load_pending_invite(&mut *tx, &token, &email).await?;
    let team_name: Option<String> = sqlx::query_scalar("SELECT name FROM teams WHERE id = $1")
        .bind(invite.team_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({
        "team_id": invite.team_id.to_string(),
        "team_name": team_name.unwrap_or_else(|| "Team".to_string()),
        "email": invite.email,
        "role": invite.role,
    })))
}

async fn accept_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    let email = set_rls_for(&mut *tx, user.user_id).await?;

    let invite = load_pending_invite(&mut *tx, &token, &email).await?;
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(invite.team_id)
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if existing.is_none() {
        sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)")
            .bind(invite.team_id)
            .bind(user.user_id)
            .bind(&invite.role)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    sqlx::query("UPDATE team_invites SET status = 'accepted' WHERE id = $1")
        .bind(invite.id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(
        json!({ "status": "joined", "team_id": invite.team_id.to_string() }),
    ))
}

async fn decline_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    let email = set_rls_for(&mut *tx, user.user_id).await?;

    let invite = load_pending_invite(&mut *tx, &token, &email).await?;
    sqlx::query("UPDATE team_invites SET status = 'declined' WHERE id = $1")
        .bind(invite.id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "declined" })))
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    Json(req): Json<CreateProjectRequest>,
) -> Result<Json<Value>, ApiError> {
    let name = validate_name(&req.name, "Project name")?;
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(
        &mut *tx,
        team_id,
        user.user_id,
        &["owner", "admin", "member"],
    )
    .await?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO team_projects (team_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(team_id)
    .bind(&name)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "id": id.to_string(), "name": name })))
}

async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((team_id, project_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let project_id = task::require_uuid(&project_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(&mut *tx, team_id, user.user_id, &["owner", "admin"]).await?;
    sqlx::query("DELETE FROM team_projects WHERE id = $1 AND team_id = $2")
        .bind(project_id)
        .bind(team_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn share_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    Json(req): Json<ShareTaskRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let task_id = task::require_uuid(&req.task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(
        &mut *tx,
        team_id,
        user.user_id,
        &["owner", "admin", "member"],
    )
    .await?;

    let task = task::find_task(&mut *tx, task_id, user.user_id, false)
        .await
        .map_err(db_error)?;
    let Some(task) = task else {
        return Err(ApiError::NotFound("Task not found".to_string()));
    };
    if task.user_id != user.user_id {
        return Err(ApiError::Forbidden(
            "Only the task owner can share it".to_string(),
        ));
    }

    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM task_shares WHERE task_id = $1 AND team_id = $2")
            .bind(task_id)
            .bind(team_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if existing.is_some() {
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(json!({ "status": "already_shared" })));
    }

    sqlx::query("INSERT INTO task_shares (task_id, team_id, shared_by) VALUES ($1, $2, $3)")
        .bind(task_id)
        .bind(team_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(
        json!({ "status": "shared", "task_id": task_id.to_string() }),
    ))
}

async fn unshare_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((team_id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let task_id = task::require_uuid(&task_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(
        &mut *tx,
        team_id,
        user.user_id,
        &["owner", "admin", "member"],
    )
    .await?;
    sqlx::query("DELETE FROM task_shares WHERE task_id = $1 AND team_id = $2")
        .bind(task_id)
        .bind(team_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "unshared" })))
}

async fn team_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let team_id = task::require_uuid(&team_id)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    set_rls_for(&mut *tx, user.user_id).await?;

    load_team(&mut *tx, team_id).await?;
    require_membership(
        &mut *tx,
        team_id,
        user.user_id,
        &["owner", "admin", "member"],
    )
    .await?;

    let sql = format!(
        "SELECT {} FROM tasks WHERE id IN (SELECT task_id FROM task_shares WHERE team_id = $1) \
         AND deleted_at IS NULL ORDER BY created_at DESC",
        task::COLUMNS
    );
    let rows = sqlx::query(&sql)
        .bind(team_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let task = Task::from_row(row).map_err(db_error)?;
        out.push(
            crate::tasks::serialize_one(&mut *tx, &task)
                .await
                .map_err(db_error)?,
        );
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Array(out)))
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
            .body(
                body.map(|b| Body::from(b.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap();
        app.oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn make_user(state: &AppState, label: &str) -> (Uuid, String, String) {
        let email = format!("rust-teams-{label}-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token =
            crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
                .unwrap();
        (user.id, email, token)
    }

    async fn cleanup(state: &AppState, users: &[Uuid]) {
        for table in [
            "DELETE FROM task_shares WHERE shared_by = ANY($1) OR task_id IN (SELECT id FROM tasks WHERE user_id = ANY($1))",
            "DELETE FROM team_invites WHERE invited_by = ANY($1)",
            "DELETE FROM team_members WHERE user_id = ANY($1)",
            "DELETE FROM team_projects WHERE team_id IN (SELECT id FROM teams WHERE owner_id = ANY($1))",
            "DELETE FROM teams WHERE owner_id = ANY($1)",
            "DELETE FROM tasks WHERE user_id = ANY($1)",
        ] {
            let _ = sqlx::query(table).bind(users).execute(&state.pool).await;
        }
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(users)
            .execute(&state.pool)
            .await;
    }

    #[tokio::test]
    async fn create_list_and_my_role() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, token) = make_user(&state, "owner").await;
        let app = router().with_state(state.clone());

        let res = call(
            app.clone(),
            "POST",
            "/api/teams",
            &token,
            Some(json!({ "name": "Acme" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let team = body_json(res).await;
        assert_eq!(team["name"], "Acme");
        assert_eq!(team["owner_id"], owner_id.to_string());
        assert_eq!(team["members"].as_array().unwrap().len(), 1);
        assert_eq!(team["members"][0]["role"], "owner");
        let team_id = team["id"].as_str().unwrap().to_string();

        let res = call(app.clone(), "GET", "/api/teams", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let listed = body_json(res).await;
        assert!(listed["teams"].is_array());
        assert!(listed["invites"].is_array());
        let mine = listed["teams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == team_id)
            .expect("team in list");
        assert_eq!(mine["my_role"], "owner");

        cleanup(&state, &[owner_id]).await;
    }

    #[tokio::test]
    async fn invite_accept_flow() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, owner_token) = make_user(&state, "owner").await;
        let (invitee_id, invited_email, invitee_token) = make_user(&state, "invitee").await;
        let app = router().with_state(state.clone());

        let res = call(
            app.clone(),
            "POST",
            "/api/teams",
            &owner_token,
            Some(json!({ "name": "Crew" })),
        )
        .await;
        let team = body_json(res).await;
        let team_id = team["id"].as_str().unwrap().to_string();

        let res = call(
            app.clone(),
            "POST",
            &format!("/api/teams/{team_id}/members"),
            &owner_token,
            Some(json!({ "email": invited_email, "role": "member" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "invited");

        // The invitee sees the pending invite and can accept it.
        let res = call(app.clone(), "GET", "/api/teams", &invitee_token, None).await;
        let invitee_view = body_json(res).await;
        let invites = invitee_view["invites"].as_array().unwrap();
        assert_eq!(invites.len(), 1);
        let invite_token = invites[0]["token"].as_str().unwrap().to_string();
        assert_eq!(invites[0]["team_id"], team_id);

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/teams/invites/{invite_token}"),
            &invitee_token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        let res = call(
            app.clone(),
            "POST",
            &format!("/api/teams/invites/{invite_token}/accept"),
            &invitee_token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "joined");

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/teams/{team_id}"),
            &owner_token,
            None,
        )
        .await;
        let detail = body_json(res).await;
        assert_eq!(detail["members"].as_array().unwrap().len(), 2);

        cleanup(&state, &[owner_id, invitee_id]).await;
    }

    #[tokio::test]
    async fn share_task_and_list_team_tasks() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, token) = make_user(&state, "sharer").await;
        let app = router()
            .merge(crate::tasks::router())
            .with_state(state.clone());

        let res = call(
            app.clone(),
            "POST",
            "/api/teams",
            &token,
            Some(json!({ "name": "Shared" })),
        )
        .await;
        let team_id = body_json(res).await["id"].as_str().unwrap().to_string();

        let res = call(
            app.clone(),
            "POST",
            "/api/tasks",
            &token,
            Some(json!({ "title": "Shared task" })),
        )
        .await;
        let task_id = body_json(res).await["id"].as_str().unwrap().to_string();

        let res = call(
            app.clone(),
            "POST",
            &format!("/api/teams/{team_id}/share-task"),
            &token,
            Some(json!({ "task_id": task_id })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "shared");

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/teams/{team_id}/tasks"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let tasks = body_json(res).await;
        assert!(tasks
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["title"] == "Shared task"));

        cleanup(&state, &[owner_id]).await;
    }

    #[tokio::test]
    async fn share_only_own_task() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, token) = make_user(&state, "owneronly").await;
        let app = router().with_state(state.clone());

        let res = call(
            app.clone(),
            "POST",
            "/api/teams",
            &token,
            Some(json!({ "name": "Mine" })),
        )
        .await;
        let team_id = body_json(res).await["id"].as_str().unwrap().to_string();

        let res = call(
            app.clone(),
            "POST",
            &format!("/api/teams/{team_id}/share-task"),
            &token,
            Some(json!({ "task_id": Uuid::new_v4().to_string() })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        cleanup(&state, &[owner_id]).await;
    }

    #[tokio::test]
    async fn team_tasks_exclude_trashed() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, token) = make_user(&state, "trasher").await;
        let app = router()
            .merge(crate::tasks::router())
            .with_state(state.clone());

        let team_id = body_json(
            call(
                app.clone(),
                "POST",
                "/api/teams",
                &token,
                Some(json!({ "name": "Trash" })),
            )
            .await,
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_string();

        let task_id = body_json(
            call(
                app.clone(),
                "POST",
                "/api/tasks",
                &token,
                Some(json!({ "title": "Trashed share" })),
            )
            .await,
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_string();

        call(
            app.clone(),
            "POST",
            &format!("/api/teams/{team_id}/share-task"),
            &token,
            Some(json!({ "task_id": task_id })),
        )
        .await;

        call(
            app.clone(),
            "DELETE",
            &format!("/api/tasks/{task_id}"),
            &token,
            None,
        )
        .await;

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/teams/{team_id}/tasks"),
            &token,
            None,
        )
        .await;
        let tasks = body_json(res).await;
        assert!(tasks.as_array().unwrap().is_empty());

        call(
            app.clone(),
            "POST",
            &format!("/api/tasks/{task_id}/restore"),
            &token,
            None,
        )
        .await;

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/teams/{team_id}/tasks"),
            &token,
            None,
        )
        .await;
        let tasks = body_json(res).await;
        assert!(tasks
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["title"] == "Trashed share"));

        cleanup(&state, &[owner_id]).await;
    }

    #[tokio::test]
    async fn list_teams_filters_invites_by_email() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, owner_token) = make_user(&state, "inviter").await;
        let (invitee_id, invited_email, invitee_token) = make_user(&state, "invitee").await;
        let (other_id, _other_email, other_token) = make_user(&state, "other").await;
        let app = router().with_state(state.clone());

        let team_id = body_json(
            call(
                app.clone(),
                "POST",
                "/api/teams",
                &owner_token,
                Some(json!({ "name": "Selective" })),
            )
            .await,
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_string();

        call(
            app.clone(),
            "POST",
            &format!("/api/teams/{team_id}/members"),
            &owner_token,
            Some(json!({ "email": invited_email, "role": "member" })),
        )
        .await;

        let invitee_view =
            body_json(call(app.clone(), "GET", "/api/teams", &invitee_token, None).await).await;
        assert_eq!(invitee_view["invites"].as_array().unwrap().len(), 1);

        let other_view =
            body_json(call(app.clone(), "GET", "/api/teams", &other_token, None).await).await;
        assert!(other_view["invites"].as_array().unwrap().is_empty());

        cleanup(&state, &[owner_id, invitee_id, other_id]).await;
    }

    #[tokio::test]
    async fn shared_task_visible_to_member() {
        let Some(state) = live_state().await else {
            return;
        };
        let (owner_id, _owner_email, owner_token) = make_user(&state, "sowner").await;
        let (member_id, member_email, member_token) = make_user(&state, "smember").await;
        let app = router()
            .merge(crate::tasks::router())
            .with_state(state.clone());

        let team_id = body_json(
            call(
                app.clone(),
                "POST",
                "/api/teams",
                &owner_token,
                Some(json!({ "name": "Visible" })),
            )
            .await,
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_string();

        let invite_token = {
            call(
                app.clone(),
                "POST",
                &format!("/api/teams/{team_id}/members"),
                &owner_token,
                Some(json!({ "email": member_email, "role": "member" })),
            )
            .await;
            let invites =
                body_json(call(app.clone(), "GET", "/api/teams", &member_token, None).await).await;
            invites["invites"][0]["token"].as_str().unwrap().to_string()
        };

        call(
            app.clone(),
            "POST",
            &format!("/api/teams/invites/{invite_token}/accept"),
            &member_token,
            None,
        )
        .await;

        let task_id = body_json(
            call(
                app.clone(),
                "POST",
                "/api/tasks",
                &owner_token,
                Some(json!({ "title": "Team visible" })),
            )
            .await,
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_string();

        call(
            app.clone(),
            "POST",
            &format!("/api/teams/{team_id}/share-task"),
            &owner_token,
            Some(json!({ "task_id": task_id })),
        )
        .await;

        let res = call(app.clone(), "GET", "/api/tasks", &member_token, None).await;
        let tasks = body_json(res).await;
        assert!(tasks
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["title"] == "Team visible"));

        cleanup(&state, &[owner_id, member_id]).await;
    }
}
