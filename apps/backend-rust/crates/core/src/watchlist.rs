//! Shows & Movies watchlist, mirroring the Python `/api/watchlist` router and
//! `watchlist_service` + `tmdb_service`. TMDB is optional: with no API key every
//! call is a no-op and manual entries use a stable synthetic (negative) id.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, PgPool, Row};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::config::Settings;
use crate::{db, error::ApiError, task, AppState};

const TMDB_BASE: &str = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE: &str = "https://image.tmdb.org/t/p/w500";

const VALID_MEDIA_TYPES: [&str; 2] = ["movie", "tv"];
const VALID_STATUSES: [&str; 3] = ["plan_to_watch", "watching", "watched"];

/// Seconds between watchlist background refresh passes (Python 6h).
pub const REFRESH_INTERVAL_SECONDS: u64 = 6 * 3600;
/// Maximum concurrent per-item TMDB refreshes (Python 3).
pub const REFRESH_CONCURRENCY: usize = 3;

const COLUMNS: &str = "id, user_id, tmdb_id, media_type, title, poster_path, release_year, \
     status, is_theatrical, rating, notes, watched_at, upcoming_json, providers_json, \
     metadata_fetched_at, created_at, updated_at";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/watchlist", get(list_items).post(add_item))
        .route("/api/watchlist/", get(list_items).post(add_item))
        .route("/api/watchlist/search", axum::routing::post(search_tmdb))
        .route(
            "/api/watchlist/{item_id}",
            axum::routing::patch(update_item).delete(delete_item),
        )
        .route("/api/watchlist/{item_id}/providers", get(get_providers))
}

#[derive(Deserialize)]
struct SearchQuery {
    query: Option<String>,
}

#[derive(Deserialize)]
struct RegionQuery {
    region: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct WatchlistAddRequest {
    pub(crate) tmdb_id: Option<i64>,
    pub(crate) media_type: String,
    #[serde(default)]
    pub(crate) title: String,
    pub(crate) release_year: Option<i32>,
    pub(crate) poster_path: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) rating: Option<i16>,
    pub(crate) notes: Option<String>,
}

/// A watchlist row, read column by column so the code stays on runtime sqlx
/// queries (no compile-time macros).
#[derive(Clone, Debug)]
struct Item {
    id: Uuid,
    tmdb_id: i32,
    media_type: String,
    title: String,
    poster_path: Option<String>,
    release_year: Option<i32>,
    status: String,
    is_theatrical: bool,
    rating: Option<i16>,
    notes: Option<String>,
    watched_at: Option<NaiveDate>,
    upcoming_json: Option<Value>,
    providers_json: Option<Value>,
    created_at: Option<DateTime<Utc>>,
}

impl Item {
    fn from_row(row: &sqlx::postgres::PgRow) -> Self {
        Item {
            id: row.try_get("id").unwrap(),
            tmdb_id: row.try_get("tmdb_id").unwrap(),
            media_type: row.try_get("media_type").unwrap(),
            title: row.try_get("title").unwrap(),
            poster_path: row.try_get("poster_path").unwrap(),
            release_year: row.try_get("release_year").unwrap(),
            status: row.try_get("status").unwrap(),
            is_theatrical: row.try_get("is_theatrical").unwrap(),
            rating: row.try_get("rating").unwrap(),
            notes: row.try_get("notes").unwrap(),
            watched_at: row.try_get("watched_at").unwrap(),
            upcoming_json: row.try_get("upcoming_json").unwrap(),
            providers_json: row.try_get("providers_json").unwrap(),
            created_at: row.try_get("created_at").unwrap(),
        }
    }

    fn json(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "tmdb_id": self.tmdb_id,
            "media_type": self.media_type,
            "title": self.title,
            "poster_path": self.poster_path,
            "poster_url": poster_url(self.poster_path.as_deref()),
            "release_year": self.release_year,
            "status": self.status,
            "is_theatrical": self.is_theatrical,
            "rating": self.rating,
            "notes": self.notes,
            "watched_at": self.watched_at.map(|d| d.to_string()),
            "upcoming": self.upcoming_json.clone().unwrap_or_else(|| json!([])),
            "providers": self.providers_json.clone().unwrap_or_else(|| json!({})),
            "created_at": self.created_at.map(|d| d.to_rfc3339()),
        })
    }
}

// ---------------------------------------------------------------------------
// TMDB client (fail-soft: never raises, returns None/[] on any failure)
// ---------------------------------------------------------------------------

fn has_key(settings: &Settings) -> bool {
    !settings.tmdb_api_key().is_empty()
}

/// The TMDB image CDN URL for a poster path (None when there is no path).
pub fn poster_url(poster_path: Option<&str>) -> Option<String> {
    poster_path.map(|p| format!("{TMDB_IMAGE_BASE}{p}"))
}

/// Deterministic negative id for a manual entry (stable across runs, fits i32).
pub fn synthetic_tmdb_id(media_type: &str, title: &str) -> i32 {
    use sha2::{Digest, Sha256};
    let normalized = format!("{}:{}", media_type, title.trim().to_lowercase());
    let digest = Sha256::digest(normalized.as_bytes());
    let hex = format!("{digest:x}");
    let value = i64::from_str_radix(&hex[..7], 16).unwrap_or(0);
    -(value as i32)
}

/// True for a manual entry (synthesized id); TMDB paths must no-op.
pub fn is_synthetic(tmdb_id: i32) -> bool {
    tmdb_id < 0
}

async fn tmdb_get(settings: &Settings, path: &str, params: &[(&str, &str)]) -> Option<Value> {
    let key = settings.tmdb_api_key();
    if key.is_empty() {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let resp = client
        .get(format!("{TMDB_BASE}{path}"))
        .query(params)
        .header("Authorization", format!("Bearer {key}"))
        .header("accept", "application/json")
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    resp.json::<Value>().await.ok()
}

fn extract_year(value: Option<&str>) -> Option<i32> {
    let raw = value?;
    raw.get(..4)?.parse::<i32>().ok()
}

async fn search_multi(settings: &Settings, query: &str) -> Vec<Value> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Some(data) = tmdb_get(settings, "/search/multi", &[("query", trimmed), ("language", "en-US")]).await
    else {
        return Vec::new();
    };
    let mut results = Vec::new();
    if let Some(items) = data.get("results").and_then(|r| r.as_array()) {
        for r in items {
            let media_type = r.get("media_type").and_then(|m| m.as_str()).unwrap_or("");
            if media_type != "movie" && media_type != "tv" {
                continue;
            }
            let title = r
                .get("title")
                .and_then(|t| t.as_str())
                .or_else(|| r.get("name").and_then(|t| t.as_str()))
                .unwrap_or("Untitled");
            let date = r
                .get("release_date")
                .and_then(|d| d.as_str())
                .or_else(|| r.get("first_air_date").and_then(|d| d.as_str()));
            results.push(json!({
                "tmdb_id": r.get("id").and_then(|i| i.as_i64()),
                "media_type": media_type,
                "title": title,
                "release_year": extract_year(date),
                "poster_path": r.get("poster_path").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    results
}

async fn movie_details(settings: &Settings, tmdb_id: i32) -> Option<Value> {
    tmdb_get(
        settings,
        &format!("/movie/{tmdb_id}"),
        &[("language", "en-US"), ("append_to_response", "belongs_to_collection")],
    )
    .await
}

async fn tv_details(settings: &Settings, tmdb_id: i32) -> Option<Value> {
    tmdb_get(
        settings,
        &format!("/tv/{tmdb_id}"),
        &[("language", "en-US"), ("append_to_response", "next_episode_to_air")],
    )
    .await
}

async fn collection(settings: &Settings, tmdb_id: i64) -> Vec<Value> {
    match tmdb_get(settings, &format!("/collection/{tmdb_id}"), &[("language", "en-US")]).await {
        Some(data) => data
            .get("parts")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

fn map_provider_links(region_data: Option<&Value>) -> Option<Value> {
    let region_data = region_data?;
    if region_data.is_null() {
        return None;
    }
    let mut links = Map::new();
    for key in ["flatrate", "buy", "rent", "free"] {
        let providers = region_data
            .get(key)
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();
        let mapped: Vec<Value> = providers
            .iter()
            .map(|p| {
                json!({
                    "id": p.get("provider_id").cloned().unwrap_or(Value::Null),
                    "name": p.get("provider_name").cloned().unwrap_or(Value::Null),
                    "logo_path": p.get("logo_path").cloned().unwrap_or(Value::Null),
                    "display_priority": p.get("display_priority").cloned().unwrap_or(Value::Null),
                    "link": p.get("link").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        links.insert(key.to_string(), Value::Array(mapped));
    }
    Some(Value::Object(links))
}

async fn watch_providers(
    settings: &Settings,
    tmdb_id: i32,
    media_type: &str,
    region: &str,
) -> Option<Value> {
    let data = tmdb_get(
        settings,
        &format!("/{media_type}/{tmdb_id}/watch/providers"),
        &[("language", "en-US")],
    )
    .await?;
    let region_data = data.get("results").and_then(|r| r.get(region));
    map_provider_links(region_data)
}

async fn has_theatrical_release(settings: &Settings, tmdb_id: i32) -> bool {
    if !has_key(settings) {
        return false;
    }
    let Some(data) =
        tmdb_get(settings, &format!("/movie/{tmdb_id}/release_dates"), &[("language", "en-US")]).await
    else {
        return false;
    };
    if let Some(regions) = data.get("results").and_then(|r| r.as_array()) {
        for region in regions {
            if let Some(releases) = region.get("release_dates").and_then(|r| r.as_array()) {
                for rd in releases {
                    if matches!(rd.get("release_type").and_then(|t| t.as_i64()), Some(2) | Some(3)) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn parse_tmdb_date(value: Option<&str>) -> Option<NaiveDate> {
    let raw = value?;
    let head: String = raw.chars().take(10).collect();
    NaiveDate::parse_from_str(&head, "%Y-%m-%d").ok()
}

async fn compute_upcoming(settings: &Settings, tmdb_id: i32, media_type: &str) -> Vec<Value> {
    if !has_key(settings) {
        return Vec::new();
    }
    let today = Utc::now().date_naive();
    if media_type == "tv" {
        let Some(details) = tv_details(settings, tmdb_id).await else {
            return Vec::new();
        };
        let next_ep = details.get("next_episode_to_air");
        let air_date = next_ep
            .and_then(|e| e.get("air_date"))
            .and_then(|d| d.as_str());
        let Some(parsed) = parse_tmdb_date(air_date) else {
            return Vec::new();
        };
        if next_ep.map(|e| e.is_null()).unwrap_or(true) || parsed <= today {
            return Vec::new();
        }
        let season = next_ep.and_then(|e| e.get("season_number"));
        let label = match season.and_then(|s| s.as_i64()) {
            Some(s) => format!("Season {s} airs"),
            None => "New episode airs".to_string(),
        };
        return vec![json!({ "label": label, "date": air_date, "extra": next_ep.and_then(|e| e.get("name")).cloned().unwrap_or(Value::Null) })];
    }

    let Some(details) = movie_details(settings, tmdb_id).await else {
        return Vec::new();
    };
    let Some(collection_id) = details
        .get("belongs_to_collection")
        .and_then(|b| b.get("id"))
        .and_then(|i| i.as_i64())
    else {
        return Vec::new();
    };
    let parts = collection(settings, collection_id).await;
    let mut upcoming = Vec::new();
    for part in &parts {
        if part.get("id").and_then(|i| i.as_i64()) == Some(tmdb_id as i64) {
            continue;
        }
        let raw_date = part
            .get("release_date")
            .and_then(|d| d.as_str())
            .or_else(|| part.get("first_air_date").and_then(|d| d.as_str()));
        let Some(release_date) = parse_tmdb_date(raw_date) else {
            continue;
        };
        if release_date <= today {
            continue;
        }
        let part_title = part
            .get("title")
            .and_then(|t| t.as_str())
            .or_else(|| part.get("name").and_then(|t| t.as_str()))
            .unwrap_or("Untitled");
        let date: String = raw_date.unwrap_or_default().chars().take(10).collect();
        upcoming.push(json!({
            "label": format!("Next installment '{part_title}' releases"),
            "date": date,
            "extra": part_title,
        }));
    }
    upcoming
}

async fn resolve_add_identity(
    settings: &Settings,
    media_type: &str,
    title: &str,
    tmdb_id: Option<i64>,
) -> (i32, String, Option<String>, Option<i32>) {
    if let Some(id) = tmdb_id {
        if let Ok(narrow) = i32::try_from(id) {
            return (narrow, title.to_string(), None, None);
        }
    }
    if !title.is_empty() && has_key(settings) {
        let results = search_multi(settings, title).await;
        let matched = results.iter().find(|r| {
            r.get("media_type").and_then(|m| m.as_str()) == Some(media_type)
        });
        if let Some(match_item) = matched {
            let resolved_id = match_item
                .get("tmdb_id")
                .and_then(|i| i.as_i64())
                .unwrap_or(0) as i32;
            let resolved_title = match_item
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or(title)
                .to_string();
            let poster = match_item
                .get("poster_path")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string());
            let year = match_item.get("release_year").and_then(|y| y.as_i64()).map(|y| y as i32);
            return (resolved_id, resolved_title, poster, year);
        }
    }
    (synthetic_tmdb_id(media_type, title), title.to_string(), None, None)
}

/// Populate title/poster/year/upcoming for a freshly added item (no-op without
/// a TMDB key or for manual entries). Returns the fields to persist.
struct Enrichment {
    title: Option<String>,
    poster_path: Option<String>,
    release_year: Option<i32>,
    upcoming: Option<Vec<Value>>,
    is_theatrical: Option<bool>,
}

async fn fetch_metadata(
    settings: &Settings,
    tmdb_id: i32,
    media_type: &str,
    title: &str,
    poster_path: Option<&str>,
    release_year: Option<i32>,
) -> Option<Enrichment> {
    if !has_key(settings) || is_synthetic(tmdb_id) {
        return None;
    }
    let details = if media_type == "tv" {
        tv_details(settings, tmdb_id).await
    } else {
        movie_details(settings, tmdb_id).await
    };
    let details = details?;
    let mut title_out = None;
    if title.trim().is_empty() {
        title_out = details
            .get("name")
            .and_then(|t| t.as_str())
            .or_else(|| details.get("title").and_then(|t| t.as_str()))
            .map(|s| s.to_string());
    }
    let poster_out = if poster_path.is_none() {
        details.get("poster_path").and_then(|p| p.as_str()).map(|s| s.to_string())
    } else {
        None
    };
    let mut year_out = None;
    if release_year.is_none() {
        let raw = details
            .get("release_date")
            .and_then(|d| d.as_str())
            .or_else(|| details.get("first_air_date").and_then(|d| d.as_str()));
        year_out = extract_year(raw);
    }
    let upcoming = compute_upcoming(settings, tmdb_id, media_type).await;
    let is_theatrical = if media_type == "movie" {
        Some(has_theatrical_release(settings, tmdb_id).await)
    } else {
        None
    };
    Some(Enrichment {
        title: title_out,
        poster_path: poster_out,
        release_year: year_out,
        upcoming: Some(upcoming),
        is_theatrical,
    })
}

/// Recompute TMDB-derived metadata for a stored item and stamp
/// `metadata_fetched_at`. Mirrors Python `watchlist_service.refresh_upcoming`
/// plus the add-path enrichment: with no TMDB key or a synthesized (manual) id
/// it is a no-op, and a failed TMDB call leaves the row untouched. Returns
/// whether the row was updated.
pub(crate) async fn refresh_item_metadata(
    conn: &mut PgConnection,
    settings: &Settings,
    item_id: Uuid,
) -> Result<bool, ApiError> {
    if !has_key(settings) {
        return Ok(false);
    }
    let row = sqlx::query(
        "SELECT tmdb_id, media_type, title, poster_path, release_year \
         FROM watchlist_items WHERE id = $1",
    )
    .bind(item_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db_error)?;
    let Some(row) = row else {
        return Ok(false);
    };
    let tmdb_id: i32 = row.try_get("tmdb_id").unwrap_or(0);
    if is_synthetic(tmdb_id) {
        return Ok(false);
    }
    let media_type: String = row.try_get("media_type").unwrap_or_default();
    let title: String = row.try_get("title").unwrap_or_default();
    let poster_path: Option<String> = row.try_get("poster_path").ok().flatten();
    let release_year: Option<i32> = row.try_get("release_year").ok().flatten();

    let Some(enrichment) = fetch_metadata(
        settings,
        tmdb_id,
        &media_type,
        &title,
        poster_path.as_deref(),
        release_year,
    )
    .await
    else {
        return Ok(false);
    };
    let upcoming = enrichment.upcoming.map(Value::Array).unwrap_or(Value::Null);
    sqlx::query(
        "UPDATE watchlist_items SET \
         title = COALESCE($2, title), \
         poster_path = COALESCE($3, poster_path), \
         release_year = COALESCE($4, release_year), \
         upcoming_json = COALESCE($5::jsonb, upcoming_json), \
         is_theatrical = COALESCE($6, is_theatrical), \
         metadata_fetched_at = now(), \
         updated_at = now() \
         WHERE id = $1",
    )
    .bind(item_id)
    .bind(&enrichment.title)
    .bind(&enrichment.poster_path)
    .bind(enrichment.release_year)
    .bind(upcoming)
    .bind(enrichment.is_theatrical)
    .execute(&mut *conn)
    .await
    .map_err(db_error)?;
    Ok(true)
}

/// One refresh pass: recompute upcoming data for every stale item. Lists the
/// due ids in one short query (never held open across network calls), then
/// refreshes each in its own transaction under a bounded semaphore; one failing
/// item never aborts the batch. Returns 0 when no TMDB key is configured.
/// Mirrors Python `watchlist_background.refresh_due_items` (including counting
/// synthetic no-ops, which Python also counted).
pub async fn refresh_due_items(pool: &PgPool, settings: &Settings) -> i64 {
    if settings.tmdb_api_key().is_empty() {
        return 0;
    }
    let due: Vec<Uuid> = match sqlx::query_scalar(
        "SELECT id FROM watchlist_items \
         WHERE metadata_fetched_at IS NULL \
            OR metadata_fetched_at < now() - ($1 * INTERVAL '1 second')",
    )
    .bind(REFRESH_INTERVAL_SECONDS as i64)
    .fetch_all(pool)
    .await
    {
        Ok(ids) => ids,
        Err(err) => {
            tracing::warn!("watchlist refresh listing failed: {err}");
            return 0;
        }
    };
    if due.is_empty() {
        return 0;
    }

    let semaphore = Arc::new(Semaphore::new(REFRESH_CONCURRENCY));
    let settings = Arc::new(settings.clone());
    let mut tasks = JoinSet::new();
    for item_id in due {
        let pool = pool.clone();
        let permit = semaphore.clone();
        let settings = settings.clone();
        tasks.spawn(async move {
            let _permit = permit.acquire_owned().await.ok()?;
            let mut tx = pool.begin().await.ok()?;
            let refreshed = refresh_item_metadata(&mut tx, &settings, item_id).await.ok()?;
            tx.commit().await.ok()?;
            Some(refreshed)
        });
    }

    let mut refreshed = 0i64;
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Some(_)) => refreshed += 1,
            Ok(None) => {}
            Err(err) => tracing::warn!("watchlist refresh task failed: {err}"),
        }
    }
    refreshed
}

/// Background loop: refresh the due items, then sleep (Python
/// `watchlist_background_loop`, every 6h). Fully skipped when no TMDB key is
/// configured.
pub async fn watchlist_background_loop(pool: PgPool, settings: Settings, interval: Duration) {
    loop {
        let refreshed = refresh_due_items(&pool, &settings).await;
        if refreshed > 0 {
            tracing::info!("watchlist: refreshed {refreshed} due item(s)");
        }
        tokio::time::sleep(interval).await;
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("23505"))
}

async fn find_item(
    conn: &mut PgConnection,
    id: Uuid,
    user_id: Uuid,
) -> Result<Option<Item>, ApiError> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM watchlist_items WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(conn)
    .await
    .map_err(db_error)?;
    Ok(row.as_ref().map(Item::from_row))
}

pub(crate) async fn svc_list_watchlist(
    state: &AppState,
    user_id: Uuid,
    status: Option<String>,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let rows = if let Some(status) = status {
        sqlx::query(&format!(
            "SELECT {COLUMNS} FROM watchlist_items WHERE user_id = $1 AND status = $2 \
             ORDER BY created_at DESC"
        ))
        .bind(user_id)
        .bind(&status)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?
    } else {
        sqlx::query(&format!(
            "SELECT {COLUMNS} FROM watchlist_items WHERE user_id = $1 ORDER BY created_at DESC"
        ))
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?
    };
    let items: Vec<Value> = rows.iter().map(|r| Item::from_row(r).json()).collect();
    tx.commit().await.map_err(db_error)?;
    Ok(Value::Array(items))
}

pub(crate) async fn svc_search_titles(
    state: &AppState,
    query: String,
) -> Result<Value, ApiError> {
    let results = search_multi(&state.settings, &query).await;
    Ok(Value::Array(results))
}

async fn list_items(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_list_watchlist(&state, user.user_id, None).await?))
}

async fn search_tmdb(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers)?;
    let query = q.query.unwrap_or_default();
    Ok(Json(svc_search_titles(&state, query).await?))
}

pub(crate) async fn svc_add_watchlist_item(
    state: &AppState,
    user_id: Uuid,
    payload: WatchlistAddRequest,
) -> Result<Value, ApiError> {
    if !VALID_MEDIA_TYPES.contains(&payload.media_type.as_str()) {
        return Err(ApiError::Unprocessable("media_type must be movie or tv".to_string()));
    }
    if let Some(status) = &payload.status {
        if !VALID_STATUSES.contains(&status.as_str()) {
            return Err(ApiError::Unprocessable("Invalid status".to_string()));
        }
    }
    let title = payload.title.trim().to_string();
    if payload.tmdb_id.is_none() && title.is_empty() {
        return Err(ApiError::Unprocessable(
            "title is required when tmdb_id is not provided".to_string(),
        ));
    }

    let (tmdb_id, resolved_title, search_poster, search_year) =
        resolve_add_identity(&state.settings, &payload.media_type, &title, payload.tmdb_id).await;
    let resolved_title = if resolved_title.trim().is_empty() {
        title.clone()
    } else {
        resolved_title.trim().to_string()
    };

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;

    let duplicate: Option<Uuid> = if is_synthetic(tmdb_id) {
        sqlx::query_scalar(
            "SELECT id FROM watchlist_items WHERE user_id = $1 AND media_type = $2 \
             AND lower(title) = lower($3) LIMIT 1",
        )
        .bind(user_id)
        .bind(&payload.media_type)
        .bind(&resolved_title)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
    } else {
        sqlx::query_scalar(
            "SELECT id FROM watchlist_items WHERE user_id = $1 AND tmdb_id = $2 LIMIT 1",
        )
        .bind(user_id)
        .bind(tmdb_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
    };
    if duplicate.is_some() {
        return Err(ApiError::Conflict("Already on your watchlist".to_string()));
    }

    let poster_path = payload.poster_path.or(search_poster);
    let release_year = payload.release_year.or(search_year);
    let status = payload.status.unwrap_or_else(|| "plan_to_watch".to_string());

    let inserted = sqlx::query(
        "INSERT INTO watchlist_items \
         (user_id, tmdb_id, media_type, title, poster_path, release_year, status, rating, notes) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(user_id)
    .bind(tmdb_id)
    .bind(&payload.media_type)
    .bind(&resolved_title)
    .bind(&poster_path)
    .bind(release_year)
    .bind(&status)
    .bind(payload.rating)
    .bind(&payload.notes)
    .fetch_one(&mut *tx)
    .await;
    let id: Uuid = match inserted {
        Ok(row) => row.try_get("id").unwrap(),
        Err(err) if is_unique_violation(&err) => {
            return Err(ApiError::Conflict("Already on your watchlist".to_string()));
        }
        Err(err) => return Err(db_error(err)),
    };

    refresh_item_metadata(&mut tx, &state.settings, id).await?;

    let Some(item) = find_item(&mut *tx, id, user_id).await? else {
        return Err(ApiError::NotFound("Watchlist item not found".to_string()));
    };
    if item.title.trim().is_empty() {
        tx.rollback().await.ok();
        return Err(ApiError::Unprocessable(
            "Title is required (TMDB lookup unavailable)".to_string(),
        ));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(item.json())
}

async fn add_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<WatchlistAddRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    Ok(Json(svc_add_watchlist_item(&state, user.user_id, payload).await?))
}

pub(crate) async fn svc_update_watchlist_item(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    body: Value,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;

    let Some(mut item) = find_item(&mut *tx, id, user_id).await? else {
        return Err(ApiError::NotFound("Watchlist item not found".to_string()));
    };

    let obj = body.as_object().cloned().unwrap_or_default();
    if let Some(status) = obj.get("status") {
        let status = status.as_str().unwrap_or("");
        if !VALID_STATUSES.contains(&status) {
            return Err(ApiError::Unprocessable("Invalid status".to_string()));
        }
    }
    let mut set_status: Option<String> = None;
    if let Some(status) = obj.get("status") {
        set_status = Some(status.as_str().unwrap_or("").to_string());
    }
    let mut set_rating: Option<i16> = None;
    if obj.contains_key("rating") {
        set_rating = match obj.get("rating") {
            Some(Value::Null) | None => None,
            Some(v) => v.as_i64().map(|n| n as i16),
        };
    }
    let mut set_notes: Option<String> = None;
    if obj.contains_key("notes") {
        set_notes = obj.get("notes").and_then(|n| n.as_str()).map(|s| s.to_string());
    }
    let mut set_watched: Option<Option<NaiveDate>> = None;
    if let Some(raw) = obj.get("watched_at") {
        match raw.as_str() {
            Some(s) if !s.is_empty() => {
                let parsed = NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
                    ApiError::Unprocessable("watched_at must be YYYY-MM-DD".to_string())
                })?;
                set_watched = Some(Some(parsed));
            }
            _ => set_watched = Some(None),
        }
    }

    if let Some(status) = set_status {
        item.status = status;
    }
    if obj.contains_key("rating") {
        item.rating = set_rating;
    }
    if obj.contains_key("notes") {
        item.notes = set_notes;
    }
    if let Some(watched) = set_watched {
        item.watched_at = watched;
    }

    sqlx::query(
        "UPDATE watchlist_items SET status = $2, rating = $3, notes = $4, watched_at = $5, \
         updated_at = now() WHERE id = $1",
    )
    .bind(item.id)
    .bind(&item.status)
    .bind(item.rating)
    .bind(&item.notes)
    .bind(item.watched_at)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;

    let Some(saved) = find_item(&mut *tx, id, user_id).await? else {
        return Err(ApiError::NotFound("Watchlist item not found".to_string()));
    };
    tx.commit().await.map_err(db_error)?;
    Ok(saved.json())
}

async fn update_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&item_id)?;
    Ok(Json(svc_update_watchlist_item(&state, user.user_id, id, body).await?))
}

pub(crate) async fn svc_remove_watchlist_item(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user_id, "").await.map_err(db_error)?;
    let result = sqlx::query("DELETE FROM watchlist_items WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("Watchlist item not found".to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(())
}

async fn delete_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&item_id)?;
    svc_remove_watchlist_item(&state, user.user_id, id).await?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn get_providers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Query(q): Query<RegionQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = task::require_uuid(&item_id)?;
    let region = q.region.unwrap_or_else(|| "US".to_string());

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
    let Some(item) = find_item(&mut *tx, id, user.user_id).await? else {
        return Err(ApiError::NotFound("Watchlist item not found".to_string()));
    };
    if is_synthetic(item.tmdb_id) {
        let cached = item.providers_json.clone().unwrap_or_else(|| json!({}));
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(cached));
    }
    let providers = watch_providers(&state.settings, item.tmdb_id, &item.media_type, &region).await;
    let response = match providers {
        Some(value) => {
            sqlx::query(
                "UPDATE watchlist_items SET providers_json = $2::jsonb, updated_at = now() WHERE id = $1",
            )
            .bind(item.id)
            .bind(&value)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
            value
        }
        None => item.providers_json.clone().unwrap_or_else(|| json!({})),
    };
    tx.commit().await.map_err(db_error)?;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn synthetic_ids_are_stable_and_negative() {
        let a = synthetic_tmdb_id("movie", " Dune ");
        let b = synthetic_tmdb_id("movie", "dune");
        assert_eq!(a, b);
        assert!(is_synthetic(a));
        assert_ne!(synthetic_tmdb_id("movie", "dune"), synthetic_tmdb_id("tv", "dune"));
        assert!(!is_synthetic(550));
    }

    #[test]
    fn poster_url_prefixes_the_cdn() {
        assert_eq!(
            poster_url(Some("/abc.jpg")),
            Some("https://image.tmdb.org/t/p/w500/abc.jpg".to_string())
        );
        assert_eq!(poster_url(None), None);
        assert_eq!(poster_url(Some("")), Some("https://image.tmdb.org/t/p/w500".to_string()));
    }

    async fn live_state() -> Option<AppState> {
        let database_url = match std::env::var("DATABASE_URL") {
            Ok(url) => url,
            Err(_) => return None,
        };
        let settings = crate::config::Settings {
            database_url,
            jwt_secret_key: "test-secret-key-that-is-at-least-32-chars!".into(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".into(),
            app_origin: "http://localhost:3000".into(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".into(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: "http://localhost:3000/api/auth/oauth/google/callback".into(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: false,
            csrf_allowed_origins: "http://localhost:3000".into(),
            api_rate_limit_enabled: false,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".into(),
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
        let mut builder = Request::builder().method(method).uri(uri);
        if !token.is_empty() {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(value) => builder
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        app.oneshot(request).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn manual_entry_round_trip() {
        let Some(state) = live_state().await else {
            return;
        };
        let app = router().with_state(state.clone());
        let email = format!("rust-watchlist-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0)
            .unwrap();

        let res = call(
            app.clone(),
            "POST",
            "/api/watchlist/",
            &token,
            Some(json!({"media_type": "movie", "title": "My Custom Movie"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let created = body_json(res).await;
        assert_eq!(created["title"], json!("My Custom Movie"));
        assert_eq!(created["status"], json!("plan_to_watch"));
        assert!(created["tmdb_id"].as_i64().unwrap() < 0);
        let item_id = created["id"].as_str().unwrap().to_string();

        let res = call(app.clone(), "GET", "/api/watchlist/", &token, None).await;
        let listed = body_json(res).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let res = call(
            app.clone(),
            "POST",
            "/api/watchlist/",
            &token,
            Some(json!({"media_type": "movie", "title": "my custom movie"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);

        let res = call(
            app.clone(),
            "PATCH",
            &format!("/api/watchlist/{item_id}"),
            &token,
            Some(json!({"status": "watching"})),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], json!("watching"));

        let res = call(
            app.clone(),
            "GET",
            &format!("/api/watchlist/{item_id}/providers"),
            &token,
            None,
        )
        .await;
        assert_eq!(body_json(res).await, json!({}));

        let res = call(
            app.clone(),
            "DELETE",
            &format!("/api/watchlist/{item_id}"),
            &token,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], json!("deleted"));

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn refresh_is_a_noop_for_synthetic_items() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-watchlist-refresh-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();

        let mut tx = state.pool.begin().await.unwrap();
        db::set_rls_user(&mut *tx, user.id, "").await.unwrap();
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO watchlist_items (user_id, tmdb_id, media_type, title, status) \
             VALUES ($1, $2, 'movie', 'Manual Movie', 'plan_to_watch') RETURNING id",
        )
        .bind(user.id)
        .bind(synthetic_tmdb_id("movie", "Manual Movie"))
        .fetch_one(&mut *tx)
        .await
        .unwrap();

        // A manual (synthetic) entry must never be stamped or updated, whether
        // or not a TMDB key is present.
        let changed = refresh_item_metadata(&mut tx, &state.settings, id).await.unwrap();
        assert!(!changed);
        tx.commit().await.unwrap();

        let stamped: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT metadata_fetched_at FROM watchlist_items WHERE id = $1")
                .bind(id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert!(stamped.is_none(), "synthetic items must not be stamped");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
