//! Core finance lite: `/api/finance` items, debts, transactions and payments.
//!
//! This is the open-core manual ledger (items, transactions, record payment,
//! pay-off, reverse). The Enterprise cashflow projections and AI tools build on
//! top of it under `ee/`. Amounts are `numeric(12,2)` handled with
//! `sqlx::types::Decimal`, and the finance tables are RLS-protected so every
//! handler opens a transaction and sets `app.user_id`.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{Datelike, NaiveDate};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::types::Decimal;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::task::require_uuid;
use crate::{db, AppState};

const ITEM_COLUMNS: &str = "id, user_id, name, direction, amount, kind, start_date, end_date, \
     frequency, next_date, payee, category, principal, remaining_balance, interest_rate, \
     paid_off_at, repeat_count, frequency_unit, frequency_interval, notes, counterparty, \
     due_date, settled_at, receivable, linked_task_id, created_at";

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers).ok_or_else(|| {
        ApiError::Unauthorized("Not authenticated".to_string())
    })?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn dec(value: f64) -> Decimal {
    Decimal::from_f64_retain(value).unwrap_or(Decimal::ZERO)
}

fn parse_date_opt(value: &Option<String>) -> Result<Option<NaiveDate>, ApiError> {
    match value {
        None => Ok(None),
        Some(raw) => NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map(Some)
            .map_err(|_| ApiError::Unprocessable("date (YYYY-MM-DD) is required".to_string())),
    }
}

fn parse_uuid_opt(value: &Option<String>) -> Result<Option<Uuid>, ApiError> {
    match value {
        None => Ok(None),
        Some(raw) if raw.trim().is_empty() => Ok(None),
        Some(raw) => Uuid::parse_str(raw.trim())
            .map(Some)
            .map_err(|_| ApiError::Unprocessable("linked_task_id must be a UUID".to_string())),
    }
}

fn dec_opt(value: &Option<f64>) -> Option<Decimal> {
    value.map(dec)
}

/// The (unit, interval) a recurring item advances by. Prefers the modern
/// `frequency_unit` + `frequency_interval`, falling back to the legacy
/// `frequency` enum (weekly/monthly/quarterly/yearly).
fn item_step(item: &ItemRow) -> Option<(String, i32)> {
    if let Some(unit) = item.frequency_unit.as_deref() {
        return Some((unit.to_string(), item.frequency_interval.unwrap_or(1).max(1)));
    }
    item.frequency
        .as_deref()
        .map(|f| (f.to_string(), 1))
}

/// Advance a date by `interval` units (day/week/month/quarter/year, plus the
/// legacy weekly/monthly/quarterly/yearly names). Clamps to the last valid day
/// of the target month; on overflow returns the input unchanged.
fn advance_date(date: NaiveDate, unit: &str, interval: i32) -> NaiveDate {
    let n = interval.max(1);
    match unit {
        "day" => date + chrono::Duration::days(n as i64),
        "week" | "weekly" => date + chrono::Duration::weeks(n as i64),
        "month" | "monthly" => date
            .checked_add_months(chrono::Months::new(n as u32))
            .unwrap_or(date),
        "quarter" | "quarterly" => date
            .checked_add_months(chrono::Months::new((n * 3) as u32))
            .unwrap_or(date),
        "year" | "yearly" => date.with_year(date.year() + n).unwrap_or(date),
        _ => date
            .checked_add_months(chrono::Months::new(n as u32))
            .unwrap_or(date),
    }
}

/// The next occurrence of an item strictly after `after`, or None when the item
/// does not repeat.
fn next_occurrence(item: &ItemRow, after: NaiveDate) -> Option<NaiveDate> {
    if item.kind != "recurring" {
        return None;
    }
    let (unit, interval) = item_step(item)?;
    let mut next = item.next_date.or(item.start_date).unwrap_or(after);
    let mut guard = 0;
    while next <= after && guard < 600 {
        next = advance_date(next, &unit, interval);
        guard += 1;
    }
    Some(next)
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: Uuid,
    name: String,
    direction: String,
    amount: Decimal,
    kind: String,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    frequency: Option<String>,
    next_date: Option<NaiveDate>,
    payee: Option<String>,
    category: Option<String>,
    principal: Option<Decimal>,
    remaining_balance: Option<Decimal>,
    interest_rate: Option<Decimal>,
    paid_off_at: Option<NaiveDate>,
    repeat_count: Option<i32>,
    frequency_unit: Option<String>,
    frequency_interval: Option<i32>,
    notes: Option<String>,
    counterparty: Option<String>,
    due_date: Option<NaiveDate>,
    settled_at: Option<NaiveDate>,
    receivable: bool,
    linked_task_id: Option<Uuid>,
}

fn date_str(value: Option<NaiveDate>) -> Value {
    match value {
        Some(d) => Value::String(d.format("%Y-%m-%d").to_string()),
        None => Value::Null,
    }
}

fn amt(value: Option<Decimal>) -> Value {
    match value {
        Some(d) => Value::String(d.to_string()),
        None => Value::Null,
    }
}

fn serialize_item(row: &ItemRow) -> Value {
    json!({
        "id": row.id.to_string(),
        "name": row.name,
        "direction": row.direction,
        "amount": row.amount.to_string(),
        "kind": row.kind,
        "start_date": date_str(row.start_date),
        "end_date": date_str(row.end_date),
        "frequency": row.frequency,
        "next_date": date_str(row.next_date),
        "payee": row.payee,
        "category": row.category,
        "principal": amt(row.principal),
        "remaining_balance": amt(row.remaining_balance),
        "interest_rate": amt(row.interest_rate),
        "paid_off_at": date_str(row.paid_off_at),
        "repeat_count": row.repeat_count,
        "frequency_unit": row.frequency_unit,
        "frequency_interval": row.frequency_interval,
        "notes": row.notes,
        "counterparty": row.counterparty,
        "due_date": date_str(row.due_date),
        "settled_at": date_str(row.settled_at),
        "receivable": row.receivable,
        "linked_task_id": row.linked_task_id.map(|u| u.to_string()),
    })
}

async fn fetch_item(
    conn: &mut PgConnection,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<ItemRow>, sqlx::Error> {
    sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await
}

#[derive(Default, Deserialize)]
struct ItemPayload {
    name: Option<String>,
    direction: Option<String>,
    amount: Option<f64>,
    kind: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    frequency: Option<String>,
    next_date: Option<String>,
    payee: Option<String>,
    category: Option<String>,
    principal: Option<f64>,
    remaining_balance: Option<f64>,
    interest_rate: Option<f64>,
    paid_off_at: Option<String>,
    repeat_count: Option<i32>,
    frequency_unit: Option<String>,
    frequency_interval: Option<i32>,
    notes: Option<String>,
    counterparty: Option<String>,
    due_date: Option<String>,
    settled_at: Option<String>,
    receivable: Option<bool>,
    linked_task_id: Option<String>,
}

async fn list_items(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let rows = sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE user_id = $1 ORDER BY created_at ASC"
    ))
    .bind(user.user_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;
    Ok(Json(json!(rows.iter().map(serialize_item).collect::<Vec<_>>())))
}

async fn create_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ItemPayload>,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers)?;
    let name = payload.name.unwrap_or_default();
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::Unprocessable(
            "name must be 1-200 characters".to_string(),
        ));
    }
    let amount = payload
        .amount
        .ok_or_else(|| ApiError::Unprocessable("amount is required".to_string()))?;
    if amount <= 0.0 {
        return Err(ApiError::Unprocessable(
            "amount must be greater than 0".to_string(),
        ));
    }
    let direction = payload.direction.unwrap_or_else(|| "expense".to_string());
    let kind = payload.kind.unwrap_or_else(|| "one_off".to_string());
    let principal = dec_opt(&payload.principal);
    let mut remaining = dec_opt(&payload.remaining_balance);
    if principal.is_some() && remaining.is_none() {
        remaining = principal;
    }

    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let row = sqlx::query_as::<_, ItemRow>(&format!(
        "INSERT INTO financial_items (user_id, name, direction, amount, kind, start_date, \
         end_date, frequency, next_date, payee, category, principal, remaining_balance, \
         interest_rate, paid_off_at, repeat_count, frequency_unit, frequency_interval, \
         notes, counterparty, due_date, settled_at, receivable, linked_task_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) \
         RETURNING {ITEM_COLUMNS}"
    ))
    .bind(user.user_id)
    .bind(&name)
    .bind(&direction)
    .bind(dec(amount))
    .bind(&kind)
    .bind(parse_date_opt(&payload.start_date)?)
    .bind(parse_date_opt(&payload.end_date)?)
    .bind(&payload.frequency)
    .bind(parse_date_opt(&payload.next_date)?)
    .bind(&payload.payee)
    .bind(&payload.category)
    .bind(principal)
    .bind(remaining)
    .bind(dec_opt(&payload.interest_rate))
    .bind(parse_date_opt(&payload.paid_off_at)?)
    .bind(payload.repeat_count)
    .bind(&payload.frequency_unit)
    .bind(payload.frequency_interval)
    .bind(&payload.notes)
    .bind(&payload.counterparty)
    .bind(parse_date_opt(&payload.due_date)?)
    .bind(parse_date_opt(&payload.settled_at)?)
    .bind(payload.receivable.unwrap_or(false))
    .bind(parse_uuid_opt(&payload.linked_task_id)?)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_error)?;
    Ok((StatusCode::CREATED, Json(serialize_item(&row))).into_response())
}

async fn get_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&item_id)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let row = fetch_item(&mut conn, user.user_id, id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Item not found".to_string()))?;
    Ok(Json(serialize_item(&row)))
}

fn cast_for(key: &str) -> Option<&'static str> {
    match key {
        "name" | "direction" | "kind" | "frequency" | "payee" | "category" | "frequency_unit"
        | "notes" | "counterparty" => Some("text"),
        "amount" | "principal" | "remaining_balance" | "interest_rate" => Some("numeric"),
        "start_date" | "end_date" | "next_date" | "paid_off_at" | "due_date" | "settled_at" => {
            Some("date")
        }
        "repeat_count" | "frequency_interval" => Some("integer"),
        "receivable" => Some("boolean"),
        "linked_task_id" => Some("uuid"),
        _ => None,
    }
}

async fn update_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&item_id)?;
    let obj = body
        .as_object()
        .cloned()
        .ok_or_else(|| ApiError::Unprocessable("Invalid body".to_string()))?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut tx, user.user_id, "").await.map_err(db_error)?;
    if fetch_item(&mut *tx, user.user_id, id).await.map_err(db_error)?.is_none() {
        return Err(ApiError::NotFound("Item not found".to_string()));
    }

    let mut sets: Vec<String> = Vec::new();
    let mut binds: Vec<Option<String>> = Vec::new();
    for (key, value) in obj.iter() {
        if key == "name" {
            let text = value.as_str().unwrap_or("").trim();
            if text.is_empty() || text.chars().count() > 200 {
                return Err(ApiError::Unprocessable(
                    "name must be 1-200 characters".to_string(),
                ));
            }
        }
        if key == "amount" {
            if let Some(n) = value.as_f64() {
                if n <= 0.0 {
                    return Err(ApiError::Unprocessable(
                        "amount must be greater than 0".to_string(),
                    ));
                }
            }
        }
        let Some(cast) = cast_for(key) else { continue };
        binds.push(match value {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        });
        sets.push(format!("{key} = ${}::{}", binds.len(), if cast == "integer" { "bigint" } else { cast }));
    }

    if !sets.is_empty() {
        let sql = format!(
            "UPDATE financial_items SET {} WHERE id = ${} AND user_id = ${}",
            sets.join(", "),
            binds.len() + 1,
            binds.len() + 2
        );
        let mut query = sqlx::query(&sql);
        for bind in &binds {
            query = query.bind(bind);
        }
        query
            .bind(id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }

    if let Some(row) = fetch_item(&mut *tx, user.user_id, id).await.map_err(db_error)? {
        if row.principal.is_some() && row.remaining_balance.is_none() {
            sqlx::query(
                "UPDATE financial_items SET remaining_balance = principal WHERE id = $1 AND user_id = $2",
            )
            .bind(id)
            .bind(user.user_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
    }

    let row = fetch_item(&mut *tx, user.user_id, id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| ApiError::NotFound("Item not found".to_string()))?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(serialize_item(&row)))
}

async fn delete_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&item_id)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let result = sqlx::query("DELETE FROM financial_items WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.user_id)
        .execute(&mut *conn)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("Item not found".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_debts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let rows = sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE user_id = $1 AND principal IS NOT NULL \
         AND paid_off_at IS NULL ORDER BY created_at ASC"
    ))
    .bind(user.user_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;
    Ok(Json(json!(rows.iter().map(serialize_item).collect::<Vec<_>>())))
}

// ----- transactions -----

#[derive(sqlx::FromRow)]
struct TxnRow {
    id: Uuid,
    date: NaiveDate,
    amount: Decimal,
    counterparty: Option<String>,
    description: Option<String>,
    category: Option<String>,
    source: String,
    item_id: Option<Uuid>,
}

const TXN_COLUMNS: &str =
    "id, date, amount, counterparty, description, category, source, item_id";

fn serialize_txn(row: &TxnRow) -> Value {
    json!({
        "id": row.id.to_string(),
        "date": row.date.format("%Y-%m-%d").to_string(),
        "amount": row.amount.to_string(),
        "counterparty": row.counterparty,
        "description": row.description,
        "category": row.category,
        "source": row.source,
        "item_id": row.item_id.map(|u| u.to_string()),
    })
}

#[derive(Deserialize)]
struct TxnCreate {
    date: String,
    amount: f64,
    counterparty: Option<String>,
    description: Option<String>,
    category: Option<String>,
}

async fn list_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: axum::extract::OriginalUri,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;

    let item_filter = uri
        .0
        .query()
        .and_then(|q| url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "item_id"))
        .map(|(_, v)| v.to_string());

    let rows = match item_filter {
        Some(raw) => {
            let id = require_uuid(&raw)?;
            sqlx::query_as::<_, TxnRow>(&format!(
                "SELECT {TXN_COLUMNS} FROM financial_transactions WHERE user_id = $1 AND item_id = $2 \
                 ORDER BY date DESC LIMIT 500"
            ))
            .bind(user.user_id)
            .bind(id)
            .fetch_all(&mut *conn)
            .await
            .map_err(db_error)?
        }
        None => sqlx::query_as::<_, TxnRow>(&format!(
            "SELECT {TXN_COLUMNS} FROM financial_transactions WHERE user_id = $1 \
             ORDER BY date DESC LIMIT 500"
        ))
        .bind(user.user_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db_error)?,
    };
    Ok(Json(json!(rows.iter().map(serialize_txn).collect::<Vec<_>>())))
}

async fn create_transaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TxnCreate>,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers)?;
    let date = NaiveDate::parse_from_str(&payload.date, "%Y-%m-%d")
        .map_err(|_| ApiError::Unprocessable("date (YYYY-MM-DD) is required".to_string()))?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let row = sqlx::query_as::<_, TxnRow>(&format!(
        "INSERT INTO financial_transactions (user_id, date, amount, counterparty, description, \
         category, source) VALUES ($1,$2,$3,$4,$5,$6,'manual') RETURNING {TXN_COLUMNS}"
    ))
    .bind(user.user_id)
    .bind(date)
    .bind(dec(payload.amount))
    .bind(&payload.counterparty)
    .bind(&payload.description)
    .bind(&payload.category)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_error)?;
    Ok((StatusCode::CREATED, Json(serialize_txn(&row))).into_response())
}

// ----- resolution + payment flows -----

enum Resolved {
    Found(ItemRow),
    Failed(Value),
}

async fn resolve_item(
    conn: &mut PgConnection,
    user_id: Uuid,
    reference: &str,
) -> Result<Resolved, sqlx::Error> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return Ok(Resolved::Failed(
            json!({"error": "item_id or name is required.", "code": "missing_ref"}),
        ));
    }
    if let Ok(id) = Uuid::parse_str(trimmed) {
        return Ok(match fetch_item(&mut *conn, user_id, id).await? {
            Some(row) => Resolved::Found(row),
            None => Resolved::Failed(json!({"error": "Item not found", "code": "not_found"})),
        });
    }

    let exact = sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE user_id = $1 AND lower(name) = lower($2)"
    ))
    .bind(user_id)
    .bind(trimmed)
    .fetch_all(&mut *conn)
    .await?;
    if exact.len() == 1 {
        return Ok(Resolved::Found(exact.into_iter().next().unwrap()));
    }
    if exact.len() > 1 {
        return Ok(ambiguous(&exact));
    }

    let like = sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE user_id = $1 AND lower(name) LIKE $2 \
         ORDER BY created_at ASC LIMIT 10"
    ))
    .bind(user_id)
    .bind(format!("%{}%", trimmed.to_lowercase()))
    .fetch_all(&mut *conn)
    .await?;
    Ok(match like.len() {
        0 => Resolved::Failed(json!({"error": "Item not found", "code": "not_found"})),
        1 => Resolved::Found(like.into_iter().next().unwrap()),
        _ => ambiguous(&like),
    })
}

fn ambiguous(rows: &[ItemRow]) -> Resolved {
    let candidates: Vec<Value> = rows
        .iter()
        .map(|r| json!({"id": r.id.to_string(), "name": r.name, "amount": r.amount.to_string()}))
        .collect();
    Resolved::Failed(json!({
        "error": "Multiple items match that name",
        "code": "ambiguous",
        "candidates": candidates,
    }))
}

async fn record_payment(
    conn: &mut PgConnection,
    user_id: Uuid,
    item_id: &str,
    payment_date: NaiveDate,
    amount: Decimal,
) -> Result<Value, sqlx::Error> {
    let item = match resolve_item(&mut *conn, user_id, item_id).await? {
        Resolved::Found(row) => row,
        Resolved::Failed(err) => return Ok(err),
    };
    if amount <= Decimal::ZERO {
        return Ok(json!({"error": "Amount must be positive", "code": "invalid_amount"}));
    }
    let txn_id: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_transactions (user_id, date, amount, counterparty, description, \
         category, source, item_id) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING id",
    )
    .bind(user_id)
    .bind(payment_date)
    .bind(amount)
    .bind(&item.name)
    .bind(format!("Payment toward {}", item.name))
    .bind(&item.category)
    .bind(item.id)
    .fetch_one(&mut *conn)
    .await?;

    let mut paid_off = false;
    let mut remaining_json = Value::Null;
    if let Some(current) = item.remaining_balance {
        let mut new_balance = current - amount;
        if new_balance <= Decimal::ZERO {
            new_balance = Decimal::from_str_exact("0.00").unwrap_or(Decimal::ZERO);
            paid_off = true;
        }
        sqlx::query(
            "UPDATE financial_items SET remaining_balance = $1, paid_off_at = $2, end_date = $3 \
             WHERE id = $4 AND user_id = $5",
        )
        .bind(new_balance)
        .bind(if paid_off { Some(payment_date) } else { item.paid_off_at })
        .bind(if paid_off { Some(payment_date) } else { item.end_date })
        .bind(item.id)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
        remaining_json = Value::String(new_balance.to_string());
    }

    // A recurring item rolls its due date forward on payment so the next one is
    // always in the future without the user editing it by hand.
    let mut next_date_json = Value::Null;
    if !paid_off {
        if let Some(next) = next_occurrence(&item, payment_date) {
            sqlx::query(
                "UPDATE financial_items SET next_date = $1 WHERE id = $2 AND user_id = $3",
            )
            .bind(next)
            .bind(item.id)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
            next_date_json = Value::String(next.format("%Y-%m-%d").to_string());
        }
    }

    Ok(json!({
        "recorded": true,
        "item_id": item.id.to_string(),
        "transaction_id": txn_id.to_string(),
        "remaining_balance": remaining_json,
        "paid_off": paid_off,
        "next_date": next_date_json,
    }))
}

async fn pay_off_item(
    conn: &mut PgConnection,
    user_id: Uuid,
    item_id: &str,
    payment_date: NaiveDate,
) -> Result<Value, sqlx::Error> {
    let item = match resolve_item(&mut *conn, user_id, item_id).await? {
        Resolved::Found(row) => row,
        Resolved::Failed(err) => return Ok(err),
    };
    let remaining = item
        .remaining_balance
        .or(item.principal)
        .unwrap_or(item.amount);
    if remaining > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO financial_transactions (user_id, date, amount, counterparty, description, \
             category, source, item_id) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)",
        )
        .bind(user_id)
        .bind(payment_date)
        .bind(remaining)
        .bind(&item.name)
        .bind(format!("Paid off in full: {}", item.name))
        .bind(&item.category)
        .bind(item.id)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "UPDATE financial_items SET remaining_balance = $1, paid_off_at = $2, end_date = $3 \
         WHERE id = $4 AND user_id = $5",
    )
    .bind(Decimal::from_str_exact("0.00").unwrap_or(Decimal::ZERO))
    .bind(payment_date)
    .bind(payment_date)
    .bind(item.id)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(json!({
        "paid_off": true,
        "item_id": item.id.to_string(),
        "amount_paid": remaining.to_string(),
    }))
}

async fn reverse_transaction(
    conn: &mut PgConnection,
    user_id: Uuid,
    transaction_id: &str,
) -> Result<Value, sqlx::Error> {
    let Ok(txn_id) = Uuid::parse_str(transaction_id.trim()) else {
        return Ok(json!({
            "error": "Invalid transaction_id format",
            "code": "invalid_transaction_id",
        }));
    };
    let Some(txn) = sqlx::query_as::<_, TxnRow>(&format!(
        "SELECT {TXN_COLUMNS} FROM financial_transactions WHERE id = $1 AND user_id = $2"
    ))
    .bind(txn_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    else {
        return Ok(json!({"error": "Transaction not found", "code": "not_found"}));
    };

    let mut remaining_json = Value::Null;
    if let Some(item_id) = txn.item_id {
        if let Some(item) = fetch_item(&mut *conn, user_id, item_id).await? {
            let mut restored = item.remaining_balance.map(|r| r + txn.amount);
            if let (Some(r), Some(principal)) = (restored, item.principal) {
                if r > principal {
                    restored = Some(principal);
                }
            }
            sqlx::query(
                "UPDATE financial_items SET remaining_balance = $1, paid_off_at = NULL, \
                 end_date = CASE WHEN end_date = $2 THEN NULL ELSE end_date END \
                 WHERE id = $3 AND user_id = $4",
            )
            .bind(restored)
            .bind(txn.date)
            .bind(item_id)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
            remaining_json = restored.map(|d| Value::String(d.to_string())).unwrap_or(Value::Null);
        }
    }

    sqlx::query("DELETE FROM financial_transactions WHERE id = $1 AND user_id = $2")
        .bind(txn_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;

    Ok(json!({
        "reversed": true,
        "transaction_id": txn_id.to_string(),
        "item_id": txn.item_id.map(|u| u.to_string()),
        "remaining_balance": remaining_json,
    }))
}

async fn pay_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let date_raw = body.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let amount_raw = body.get("amount").and_then(|v| v.as_f64());
    let (payment_date, amount) = match (
        NaiveDate::parse_from_str(date_raw, "%Y-%m-%d"),
        amount_raw,
    ) {
        (Ok(d), Some(a)) => (d, dec(a)),
        _ => {
            return Err(ApiError::Unprocessable(
                "date (YYYY-MM-DD) and amount are required".to_string(),
            ))
        }
    };
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut tx, user.user_id, "").await.map_err(db_error)?;
    let result = record_payment(&mut *tx, user.user_id, &item_id, payment_date, amount)
        .await
        .map_err(db_error)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(ApiError::NotFound(err.to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}

async fn pay_off(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let date_raw = body.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let payment_date = NaiveDate::parse_from_str(date_raw, "%Y-%m-%d")
        .map_err(|_| ApiError::Unprocessable("date (YYYY-MM-DD) is required".to_string()))?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut tx, user.user_id, "").await.map_err(db_error)?;
    let result = pay_off_item(&mut *tx, user.user_id, &item_id, payment_date)
        .await
        .map_err(db_error)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(ApiError::NotFound(err.to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}

async fn delete_transaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transaction_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut tx, user.user_id, "").await.map_err(db_error)?;
    let result = reverse_transaction(&mut *tx, user.user_id, &transaction_id)
        .await
        .map_err(db_error)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        let code = result.get("code").and_then(|v| v.as_str()).unwrap_or("");
        return Err(if code == "invalid_transaction_id" {
            ApiError::Unprocessable(err.to_string())
        } else {
            ApiError::NotFound(err.to_string())
        });
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}

// ----- receivables + income -----

async fn list_receivables(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let rows = sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE user_id = $1 AND receivable = true \
         AND settled_at IS NULL ORDER BY due_date ASC NULLS LAST, created_at ASC"
    ))
    .bind(user.user_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;
    Ok(Json(json!(rows.iter().map(serialize_item).collect::<Vec<_>>())))
}

async fn list_upcoming_income(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut conn = state.pool.acquire().await.map_err(db_error)?;
    db::set_rls_user(&mut conn, user.user_id, "").await.map_err(db_error)?;
    let rows = sqlx::query_as::<_, ItemRow>(&format!(
        "SELECT {ITEM_COLUMNS} FROM financial_items WHERE user_id = $1 AND direction = 'income' \
         AND paid_off_at IS NULL AND settled_at IS NULL ORDER BY created_at ASC"
    ))
    .bind(user.user_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;

    let today = chrono::Utc::now().date_naive();
    let mut upcoming: Vec<(Option<NaiveDate>, Value)> = Vec::new();
    for row in &rows {
        let next = if row.kind == "recurring" {
            next_occurrence(row, today).or(row.next_date).or(row.start_date)
        } else {
            row.due_date.or(row.next_date).or(row.start_date)
        };
        let mut value = serialize_item(row);
        if let Value::Object(ref mut map) = value {
            map.insert("next_occurrence".to_string(), date_str(next));
        }
        upcoming.push((next, value));
    }
    upcoming.sort_by(|a, b| match (a.0, b.0) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    Ok(Json(json!(upcoming.into_iter().map(|(_, v)| v).collect::<Vec<_>>())))
}

async fn settle_receivable(
    conn: &mut PgConnection,
    user_id: Uuid,
    item_id: &str,
    settle_date: NaiveDate,
) -> Result<Value, sqlx::Error> {
    let item = match resolve_item(&mut *conn, user_id, item_id).await? {
        Resolved::Found(row) => row,
        Resolved::Failed(err) => return Ok(err),
    };
    let outstanding = item
        .remaining_balance
        .or(item.principal)
        .unwrap_or(item.amount);
    if outstanding > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO financial_transactions (user_id, date, amount, counterparty, description, \
             category, source, item_id) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)",
        )
        .bind(user_id)
        .bind(settle_date)
        .bind(outstanding)
        .bind(&item.counterparty)
        .bind(format!("Received: {}", item.name))
        .bind(&item.category)
        .bind(item.id)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "UPDATE financial_items SET remaining_balance = $1, settled_at = $2, paid_off_at = $3 \
         WHERE id = $4 AND user_id = $5",
    )
    .bind(Decimal::from_str_exact("0.00").unwrap_or(Decimal::ZERO))
    .bind(settle_date)
    .bind(settle_date)
    .bind(item.id)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(json!({
        "settled": true,
        "item_id": item.id.to_string(),
        "amount": outstanding.to_string(),
        "date": settle_date.format("%Y-%m-%d").to_string(),
    }))
}

async fn settle_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let date_raw = body.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let settle_date = if date_raw.is_empty() {
        chrono::Utc::now().date_naive()
    } else {
        NaiveDate::parse_from_str(date_raw, "%Y-%m-%d")
            .map_err(|_| ApiError::Unprocessable("date (YYYY-MM-DD) is required".to_string()))?
    };
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut tx, user.user_id, "").await.map_err(db_error)?;
    let result = settle_receivable(&mut *tx, user.user_id, &item_id, settle_date)
        .await
        .map_err(db_error)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(ApiError::NotFound(err.to_string()));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}

/// Build the task that represents a financial item: a one-off "Get X from Y"
/// for a receivable, or a recurring repayment task (monthly by default) running
/// until the item's end date for a recurring bill/loan.
fn build_finance_task(item: &ItemRow) -> crate::tasks::CreateTaskRequest {
    let counterparty = item.counterparty.clone().filter(|s| !s.trim().is_empty());
    let title = if item.receivable {
        match &counterparty {
            Some(person) => format!("Get {} from {}", item.amount, person),
            None => format!("Get {} owed to you", item.amount),
        }
    } else {
        format!("Pay {}", item.name)
    };
    let due = item.due_date.or(item.next_date).or(item.start_date);
    let (recurrence_rule, recurrence_end_date) = if item.kind == "recurring" && item.end_date.is_some()
    {
        let unit = item
            .frequency_unit
            .as_deref()
            .or(item.frequency.as_deref())
            .unwrap_or("monthly");
        let rule = match unit {
            "day" => "FREQ=DAILY",
            "week" | "weekly" => "FREQ=WEEKLY",
            "year" | "yearly" => "FREQ=YEARLY",
            "quarter" | "quarterly" => "FREQ=MONTHLY;INTERVAL=3",
            _ => "FREQ=MONTHLY",
        };
        (
            Some(rule.to_string()),
            item.end_date.map(|d| d.format("%Y-%m-%d").to_string()),
        )
    } else {
        (None, None)
    };
    crate::tasks::CreateTaskRequest {
        title,
        parent_task_id: None,
        board_section_id: None,
        description: item.notes.clone(),
        status: "backlog".to_string(),
        priority: 2,
        start_date: None,
        due_date: due.map(|d| d.format("%Y-%m-%d").to_string()),
        start_time: None,
        end_time: None,
        recurrence_rule,
        recurrence_end_date,
        estimated_minutes: None,
        tag_ids: None,
        list_id: None,
        reminder_enabled: false,
    }
}

/// Link a task to a financial item, or create one (a "Get X from Y" task for a
/// receivable, or a recurring repayment task for a recurring bill/loan) then link
/// it. Shared by the REST route and the EE finance AI/MCP tools.
pub async fn svc_link_finance_task(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    task_id: Option<Uuid>,
) -> Result<Value, ApiError> {
    let item = {
        let mut conn = state.pool.acquire().await.map_err(db_error)?;
        db::set_rls_user(&mut conn, user_id, "").await.map_err(db_error)?;
        fetch_item(&mut *conn, user_id, id)
            .await
            .map_err(db_error)?
            .ok_or_else(|| ApiError::NotFound("Item not found".to_string()))?
    };

    let task_id = match task_id {
        Some(tid) => {
            let mut conn = state.pool.acquire().await.map_err(db_error)?;
            db::set_rls_user(&mut conn, user_id, "").await.map_err(db_error)?;
            let owned: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM tasks WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            )
            .bind(tid)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db_error)?;
            owned.ok_or_else(|| ApiError::NotFound("Task not found".to_string()))?
        }
        None => {
            let created = crate::tasks::svc_create_task(state, user_id, build_finance_task(&item)).await?;
            let created_id = created
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ApiError::Internal("created task missing id".to_string()))?;
            require_uuid(created_id)?
        }
    };

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut tx, user_id, "").await.map_err(db_error)?;
    let row = sqlx::query_as::<_, ItemRow>(&format!(
        "UPDATE financial_items SET linked_task_id = $1 WHERE id = $2 AND user_id = $3 \
         RETURNING {ITEM_COLUMNS}"
    ))
    .bind(task_id)
    .bind(id)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(json!({
        "linked_task_id": task_id.to_string(),
        "item": serialize_item(&row),
    }))
}

async fn link_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let id = require_uuid(&item_id)?;
    let task_id = match body
        .get("task_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        Some(raw) => Some(require_uuid(raw)?),
        None => None,
    };
    let value = svc_link_finance_task(&state, user.user_id, id, task_id).await?;
    Ok(Json(value))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/finance/items", get(list_items).post(create_item))
        .route("/api/finance/items/", get(list_items))
        .route(
            "/api/finance/items/{item_id}",
            get(get_item).patch(update_item).delete(delete_item),
        )
        .route("/api/finance/items/{item_id}/pay", axum::routing::post(pay_item))
        .route("/api/finance/items/{item_id}/pay-off", axum::routing::post(pay_off))
        .route("/api/finance/items/{item_id}/settle", axum::routing::post(settle_route))
        .route("/api/finance/items/{item_id}/link-task", axum::routing::post(link_task))
        .route("/api/finance/receivables", get(list_receivables))
        .route("/api/finance/upcoming-income", get(list_upcoming_income))
        .route("/api/finance/debts", get(list_debts))
        .route(
            "/api/finance/transactions",
            get(list_transactions).post(create_transaction),
        )
        .route(
            "/api/finance/transactions/{transaction_id}",
            axum::routing::delete(delete_transaction),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::response::Response;
    use tower::ServiceExt;

    use crate::config::Settings;

    fn sample_item(kind: &str, unit: Option<&str>, interval: Option<i32>) -> ItemRow {
        ItemRow {
            id: Uuid::new_v4(),
            name: "Sample".to_string(),
            direction: "expense".to_string(),
            amount: Decimal::new(1000, 2),
            kind: kind.to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 1, 10),
            end_date: None,
            frequency: None,
            next_date: NaiveDate::from_ymd_opt(2026, 1, 10),
            payee: None,
            category: None,
            principal: None,
            remaining_balance: None,
            interest_rate: None,
            paid_off_at: None,
            repeat_count: None,
            frequency_unit: unit.map(str::to_string),
            frequency_interval: interval,
            notes: None,
            counterparty: None,
            due_date: None,
            settled_at: None,
            receivable: false,
            linked_task_id: None,
        }
    }

    #[test]
    fn recurring_items_advance_to_the_next_occurrence() {
        let item = sample_item("recurring", Some("month"), Some(1));
        let after = NaiveDate::from_ymd_opt(2026, 1, 10).unwrap();
        assert_eq!(
            next_occurrence(&item, after),
            NaiveDate::from_ymd_opt(2026, 2, 10)
        );

        let biweekly = sample_item("recurring", Some("week"), Some(2));
        assert_eq!(
            next_occurrence(&biweekly, after),
            NaiveDate::from_ymd_opt(2026, 1, 24)
        );

        let yearly = sample_item("recurring", Some("year"), Some(1));
        assert_eq!(
            next_occurrence(&yearly, after),
            NaiveDate::from_ymd_opt(2027, 1, 10)
        );
    }

    #[test]
    fn one_off_items_do_not_advance() {
        let item = sample_item("one_off", Some("month"), Some(1));
        assert_eq!(next_occurrence(&item, NaiveDate::from_ymd_opt(2026, 1, 10).unwrap()), None);
    }

    #[test]
    fn receivable_tasks_are_titled_get_from_and_recur_with_an_end_date() {
        let mut item = sample_item("recurring", Some("month"), Some(1));
        item.name = "Car loan".to_string();
        item.counterparty = Some("Gaby".to_string());
        item.receivable = true;
        item.end_date = NaiveDate::from_ymd_opt(2026, 6, 10);
        let task = build_finance_task(&item);
        assert!(task.title.contains("Gaby"));
        assert_eq!(task.recurrence_end_date.as_deref(), Some("2026-06-10"));
        assert!(task.recurrence_rule.is_some());

        let mut plain = sample_item("recurring", Some("month"), Some(1));
        plain.name = "Rent".to_string();
        plain.receivable = false;
        let task = build_finance_task(&plain);
        assert_eq!(task.title, "Pay Rent");
    }

    fn live_state() -> Option<AppState> {
        let database_url = std::env::var("DATABASE_URL").ok()?;
        let settings = Settings {
            database_url,
            jwt_secret_key: "test-secret-key-that-is-long-enough-0123456789".to_string(),
            encryption_key: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=".to_string(),
            port: 8000,
            git_sha: None,
            environment: "test".to_string(),
            app_origin: "http://localhost:3000".to_string(),
            webauthn_rp_id: "localhost".to_string(),
            webauthn_rp_name: "Prysm Note".to_string(),
            webauthn_origins: "http://localhost:3000".to_string(),
            oauth_redirect_uri: "http://localhost:8000/api/oauth/google/callback".to_string(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: false,
            csrf_allowed_origins: String::new(),
            api_rate_limit_enabled: false,
            api_rate_limit_per_min: 120,
            cors_origins: String::new(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: String::new(),
            notify_email: String::new(),
            notification_loop_interval: 300,
            digest_hour: 8,
        };
        Some(AppState::lazy(settings))
    }

    async fn call(app: &Router, method: &str, uri: &str, token: &str, body: Option<Value>) -> Response {
        let builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let request = match body {
            Some(value) => builder
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        app.clone().oneshot(request).await.unwrap()
    }

    async fn body_json(res: Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn make_user(state: &AppState, label: &str) -> (Uuid, String) {
        let email = format!("rust-finance-{label}-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = crate::jwt::encode_access(
            &state.settings.jwt_secret_key,
            &user.id.to_string(),
            0,
        )
        .unwrap();
        (user.id, token)
    }

    #[tokio::test]
    async fn item_create_patch_and_delete_round_trip() {
        let Some(state) = live_state() else {
            return;
        };
        let app = router().with_state(state.clone());
        let (user_id, token) = make_user(&state, "item").await;

        let created = body_json(
            call(
                &app,
                "POST",
                "/api/finance/items",
                &token,
                Some(json!({"name": "Rent", "direction": "expense", "amount": 100})),
            )
            .await,
        )
        .await;
        assert_eq!(created["name"], "Rent");
        assert_eq!(created["amount"], "100.00");
        assert_eq!(created["direction"], "expense");
        let id = created["id"].as_str().unwrap().to_string();

        let patched = body_json(
            call(
                &app,
                "PATCH",
                &format!("/api/finance/items/{id}"),
                &token,
                Some(json!({"name": "Rent Updated", "payee": "Landlord"})),
            )
            .await,
        )
        .await;
        assert_eq!(patched["name"], "Rent Updated");
        assert_eq!(patched["payee"], "Landlord");

        let listed = body_json(call(&app, "GET", "/api/finance/items", &token, None).await).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let deleted = call(
            &app,
            "DELETE",
            &format!("/api/finance/items/{id}"),
            &token,
            None,
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await;
    }

    #[tokio::test]
    async fn debt_payment_and_payoff_flow() {
        let Some(state) = live_state() else {
            return;
        };
        let app = router().with_state(state.clone());
        let (user_id, token) = make_user(&state, "debt").await;

        let created = body_json(
            call(
                &app,
                "POST",
                "/api/finance/items",
                &token,
                Some(json!({"name": "Loan", "direction": "expense", "amount": 500, "principal": 500})),
            )
            .await,
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["remaining_balance"], "500.00");

        let debts = body_json(call(&app, "GET", "/api/finance/debts", &token, None).await).await;
        assert_eq!(debts.as_array().unwrap().len(), 1);

        let paid = body_json(
            call(
                &app,
                "POST",
                &format!("/api/finance/items/{id}/pay"),
                &token,
                Some(json!({"date": "2026-01-10", "amount": 200})),
            )
            .await,
        )
        .await;
        assert_eq!(paid["recorded"], true);
        assert_eq!(paid["remaining_balance"], "300.00");

        let txns = body_json(call(&app, "GET", "/api/finance/transactions", &token, None).await).await;
        assert_eq!(txns.as_array().unwrap().len(), 1);
        let txn_id = txns[0]["id"].as_str().unwrap().to_string();

        let reversed = body_json(
            call(
                &app,
                "DELETE",
                &format!("/api/finance/transactions/{txn_id}"),
                &token,
                None,
            )
            .await,
        )
        .await;
        assert_eq!(reversed["reversed"], true);
        assert_eq!(reversed["remaining_balance"], "500.00");

        let paid_off = body_json(
            call(
                &app,
                "POST",
                &format!("/api/finance/items/{id}/pay-off"),
                &token,
                Some(json!({"date": "2026-02-01"})),
            )
            .await,
        )
        .await;
        assert_eq!(paid_off["paid_off"], true);
        assert_eq!(paid_off["amount_paid"], "500.00");

        let debts = body_json(call(&app, "GET", "/api/finance/debts", &token, None).await).await;
        assert_eq!(debts.as_array().unwrap().len(), 0);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await;
    }

    #[tokio::test]
    async fn transaction_create_and_reverse_missing() {
        let Some(state) = live_state() else {
            return;
        };
        let app = router().with_state(state.clone());
        let (user_id, token) = make_user(&state, "txn").await;

        let created = body_json(
            call(
                &app,
                "POST",
                "/api/finance/transactions",
                &token,
                Some(json!({"date": "2026-01-05", "amount": 42.5, "counterparty": "Shop"})),
            )
            .await,
        )
        .await;
        assert_eq!(created["amount"], "42.50");
        assert_eq!(created["counterparty"], "Shop");

        let missing = call(
            &app,
            "DELETE",
            &format!("/api/finance/transactions/{}", Uuid::new_v4()),
            &token,
            None,
        )
        .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await;
    }
}
