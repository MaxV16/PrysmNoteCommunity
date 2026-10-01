//! `GET /api/search` - core (ungated) text and semantic search.
//!
//! Mirrors Python `routers/search.py`: `q` is required and must be non-empty
//! (422 otherwise), `mode` defaults to `text`. Text mode delegates to
//! [`crate::task::search_tasks`] (typo-tolerant trigram ranking with a substring
//! fallback); semantic mode embeds the query with the user's own BYOK key and
//! ranks stored task embeddings, degrading gracefully when no key is configured
//! or the provider fails. Results are shaped exactly like the Python response
//! (`rank` for text, `similarity` for semantic, both rounded to 3 decimals).
//!
//! Both `/api/search` and `/api/search/` are registered: axum does not
//! auto-redirect trailing slashes the way FastAPI's router prefix does.

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::{api_key, db, embedding, task, AppState};

/// The `/api/search` sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/search", get(search))
        .route("/api/search/", get(search))
}

#[derive(Deserialize)]
struct SearchParams {
    q: Option<String>,
    #[serde(default)]
    mode: Option<String>,
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let q = params.q.unwrap_or_default();
    if q.is_empty() {
        return Err(ApiError::Unprocessable(
            "q must be at least 1 character".to_string(),
        ));
    }
    let mode = params.mode.unwrap_or_else(|| "text".to_string());

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;

    if mode == "semantic" {
        let out = semantic_search(&state, user.user_id, &mut tx, &q).await?;
        tx.commit().await.map_err(db_error)?;
        return Ok(out);
    }

    let hits = task::search_tasks(&mut *tx, user.user_id, &q, 20)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let results: Vec<Value> = hits
        .into_iter()
        .map(|(task, rank)| {
            json!({
                "id": task.id.to_string(),
                "title": task.title,
                "status": task.status,
                "start_date": task.start_date.map(|d| d.to_string()),
                "due_date": task.due_date.map(|d| d.to_string()),
                "rank": round3(rank),
            })
        })
        .collect();
    Ok(Json(json!({ "mode": "text", "results": results })))
}

/// Semantic branch: read the user's embedding key on the RLS-scoped connection,
/// embed the query and rank the stored task embeddings.
async fn semantic_search(
    state: &AppState,
    user_id: uuid::Uuid,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    q: &str,
) -> Result<Json<Value>, ApiError> {
    let key = api_key::get_active_for_user_conn(&mut **tx, user_id)
        .await
        .map_err(db_error)?;
    let Some(client) = key
        .as_ref()
        .and_then(|k| embedding::client_from_key(k, &state.settings.encryption_key))
    else {
        return Ok(Json(json!({
            "mode": "semantic",
            "error": "No API key configured for embeddings",
            "results": [],
        })));
    };

    let Ok(query_embedding) = client.embed(q).await else {
        return Ok(Json(json!({
            "mode": "semantic",
            "error": "Embedding generation failed",
            "results": [],
        })));
    };

    let similar = embedding::search_similar(&mut **tx, &query_embedding, user_id, 10)
        .await
        .map_err(db_error)?;

    let results: Vec<Value> = similar
        .into_iter()
        .map(|(task, score)| {
            json!({
                "id": task.id.to_string(),
                "title": task.title,
                "status": task.status,
                "start_date": task.start_date.map(|d| d.to_string()),
                "due_date": task.due_date.map(|d| d.to_string()),
                "similarity": round3(score),
            })
        })
        .collect();
    Ok(Json(json!({ "mode": "semantic", "results": results })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn round3_matches_python_round() {
        assert_eq!(round3(0.12345), 0.123);
        assert_eq!(round3(0.9996), 1.0);
        assert_eq!(round3(0.0), 0.0);
        assert_eq!(round3(0.5), 0.5);
    }

    async fn live_state() -> Option<AppState> {
        let database_url = std::env::var("DATABASE_URL").ok()?;
        let mut settings = crate::config::Settings::from_env();
        settings.database_url = database_url;
        settings.jwt_secret_key = "test-secret-key-that-is-at-least-32-chars!".to_string();
        settings.encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=".to_string();
        Some(AppState::lazy(settings))
    }

    async fn call(app: &Router, uri: &str, token: &str) -> axum::response::Response {
        let request = Request::builder()
            .uri(uri)
            .header("cookie", format!("access_token={token}"))
            .body(Body::empty())
            .unwrap();
        app.clone().oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn text_search_matches_title_description_and_tag_name() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-search-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(
            &state.settings.jwt_secret_key,
            &user.id.to_string(),
            0,
        )
        .unwrap();
        let app = router().with_state(state.clone());

        // A tag named "billing" attached to a task whose title does not contain it.
        let mut tx = state.pool.begin().await.unwrap();
        db::set_rls_user(&mut *tx, user.id, "").await.unwrap();
        let tag: uuid::Uuid =
            sqlx::query_scalar("INSERT INTO tags (user_id, name) VALUES ($1, 'billing') RETURNING id")
                .bind(user.id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        let tagged: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO tasks (user_id, title, description, status, priority, is_all_day, is_archived, sort_order) \
             VALUES ($1, 'Fix the checkout flow', NULL, 'todo'::task_status, 2, false, false, 0) RETURNING id",
        )
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)")
            .bind(tagged)
            .bind(tag)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO tasks (user_id, title, description, status, priority, is_all_day, is_archived, sort_order) \
             VALUES ($1, 'Quarterly report', 'This is about the quarterly review', 'todo'::task_status, 2, false, false, 0)",
        )
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // Title + description match.
        let res = call(&app, "/api/search?q=quarterly", &token).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "text");
        let titles: Vec<String> = body["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["title"].as_str().unwrap().to_string())
            .collect();
        assert!(titles.iter().any(|t| t == "Quarterly report"));
        assert!(body["results"][0].get("rank").is_some());
        assert!(body["results"][0].get("similarity").is_none());

        // Tag-name match surfaces a differently titled task.
        let res = call(&app, "/api/search?q=billing", &token).await;
        let body = body_json(res).await;
        let titles: Vec<String> = body["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["title"].as_str().unwrap().to_string())
            .collect();
        assert!(titles.iter().any(|t| t == "Fix the checkout flow"));

        // Trailing slash behaves identically.
        let res = call(&app, "/api/search/?q=billing", &token).await;
        assert_eq!(res.status(), StatusCode::OK);

        // Empty query is 422.
        let res = call(&app, "/api/search?q=", &token).await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn text_search_is_user_scoped() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-search-scope-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(
            &state.settings.jwt_secret_key,
            &user.id.to_string(),
            0,
        )
        .unwrap();
        let app = router().with_state(state.clone());

        let mut tx = state.pool.begin().await.unwrap();
        db::set_rls_user(&mut *tx, user.id, "").await.unwrap();
        sqlx::query(
            "INSERT INTO tasks (user_id, title, status, priority, is_all_day, is_archived, sort_order) \
             VALUES ($1, 'My private task', 'todo'::task_status, 2, false, false, 0)",
        )
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let res = call(&app, "/api/search?q=private", &token).await;
        let body = body_json(res).await;
        assert!(body["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["title"].as_str().unwrap().starts_with("My private")));

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn semantic_without_key_degrades_gracefully() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-search-sem-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(
            &state.settings.jwt_secret_key,
            &user.id.to_string(),
            0,
        )
        .unwrap();
        let app = router().with_state(state.clone());

        let res = call(&app, "/api/search?q=test&mode=semantic", &token).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "semantic");
        assert_eq!(body["error"], "No API key configured for embeddings");
        assert_eq!(body["results"].as_array().unwrap().len(), 0);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
