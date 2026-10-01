//! User preferences key/value store, mirroring the Python `/api/preferences`
//! router. Values are arbitrary JSON blobs keyed by a short string.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::{db, AppState};

const MAX_KEY_LENGTH: usize = 64;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/preferences", get(list_prefs))
        .route("/api/preferences/", get(list_prefs))
        .route("/api/preferences/{key}", axum::routing::put(set_pref).delete(delete_pref))
}

#[derive(Deserialize)]
struct PreferenceUpdate {
    value: Value,
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

async fn list_prefs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let rows = sqlx::query("SELECT key, value FROM user_preferences WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;

    let mut map = Map::new();
    for row in rows {
        let key: String = row.try_get("key").unwrap();
        let value: Option<Value> = row.try_get("value").unwrap();
        map.insert(key, value.unwrap_or(Value::Null));
    }

    tx.commit().await.map_err(db_error)?;
    Ok(Json(Value::Object(map)))
}

async fn set_pref(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<PreferenceUpdate>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    if key.is_empty() || key.chars().count() > MAX_KEY_LENGTH {
        return Err(ApiError::Unprocessable(format!(
            "Key must be at most {MAX_KEY_LENGTH} characters"
        )));
    }

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let row = sqlx::query(
        "INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         RETURNING key, value",
    )
    .bind(user.user_id)
    .bind(&key)
    .bind(&body.value)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;

    tx.commit().await.map_err(db_error)?;

    let stored: Option<Value> = row.try_get("value").unwrap();
    Ok(Json(json!({ "key": key, "value": stored.unwrap_or(Value::Null) })))
}

async fn delete_pref(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;

    let result = sqlx::query("DELETE FROM user_preferences WHERE user_id = $1 AND key = $2")
        .bind(user.user_id)
        .bind(&key)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    if result.rows_affected() == 0 {
        tx.rollback().await.ok();
        return Err(ApiError::NotFound("Preference not found".to_string()));
    }

    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({ "status": "deleted" })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn live_state() -> Option<AppState> {
        let database_url = std::env::var("DATABASE_URL").ok()?;
        let settings = crate::config::Settings {
            database_url,
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

    async fn call(app: &Router, method: &str, uri: &str, token: &str, body: Option<Value>) -> axum::response::Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", format!("access_token={token}"));
        let request = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                builder.body(Body::from(value.to_string())).unwrap()
            }
            None => builder.body(Body::empty()).unwrap(),
        };
        app.clone().oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn preference_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-prefs-{}@test.local", uuid::Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();
        let app = router().with_state(state.clone());

        let res = call(
            &app,
            "PUT",
            "/api/preferences/theme",
            &token,
            Some(json!({"value": "dark"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        let res = call(&app, "GET", "/api/preferences", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let listed = body_json(res).await;
        assert_eq!(listed["theme"], json!("dark"));

        let res = call(&app, "DELETE", "/api/preferences/theme", &token, None).await;
        assert_eq!(res.status(), StatusCode::OK);
        let res = call(&app, "DELETE", "/api/preferences/theme", &token, None).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
