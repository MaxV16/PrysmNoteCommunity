//! Recurring task occurrence materialization.
//!
//! Mirrors Python `services/recurring_task_service.py`. Recurrence rules are
//! expanded lazily for a date window on reads ([`expand_recurring_for_range`]),
//! materialized up to a 90-day horizon when a template is created/updated
//! ([`expand_task_occurrences`]), and swept by an hourly background loop with a
//! cooldown ([`expand_recurring_tasks`]). Occurrence rows are ordinary tasks
//! whose `parent_task_id` points at the template row and whose start/due dates
//! are the instance dates (the template row itself is the first occurrence).

use std::collections::{BTreeSet, HashSet};
use std::time::Duration;

use chrono::{NaiveDate, Utc};
use rrule::RRuleSet;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::task::{Task, COLUMNS};

/// Future horizon materialized when a template is first expanded.
pub const INITIAL_HORIZON_DAYS: i64 = 90;
/// Occurrence cap for the background sweep.
pub const MAX_OCCURRENCES: usize = 104;
/// Occurrence cap for the lazy view-window expansion.
pub const MAX_OCCURRENCES_ON_DEMAND: usize = 200;
/// The rrule iterator takes a `u16` limit.
const RULE_LIMIT: usize = 65_535;

/// Expand an RRULE into its occurrence dates (Python `expand_recurring_instances`).
///
/// Stops at `max_occurrences`, at `recurrence_end_date` (exclusive tail) and at
/// `horizon_date`; dates before `start_date` are skipped. A malformed rule
/// yields an empty list (the caller treats that as "nothing to do").
pub fn expand_recurring_instances(
    start_date: NaiveDate,
    recurrence_rule: &str,
    recurrence_end_date: Option<NaiveDate>,
    max_occurrences: usize,
    horizon_date: Option<NaiveDate>,
) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    if max_occurrences == 0 {
        return out;
    }
    let source = format!(
        "DTSTART:{}T000000Z\nRRULE:{}",
        start_date.format("%Y%m%d"),
        recurrence_rule.trim()
    );
    let set: RRuleSet = match source.parse() {
        Ok(set) => set,
        Err(_) => return out,
    };
    let limit = max_occurrences.min(RULE_LIMIT) as u16;
    for dt in set.all(limit).dates {
        let date = dt.date_naive();
        if let Some(end) = recurrence_end_date {
            if date > end {
                break;
            }
        }
        if date < start_date {
            continue;
        }
        if let Some(horizon) = horizon_date {
            if date > horizon {
                break;
            }
        }
        out.push(date);
        if out.len() >= max_occurrences {
            break;
        }
    }
    out
}

/// Insert one occurrence row for a template on `date`.
async fn insert_occurrence(
    conn: &mut PgConnection,
    template: &Task,
    date: NaiveDate,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, title, description, status, priority, \
         start_date, due_date, start_time, end_time, is_all_day, is_archived, sort_order, \
         reminder_enabled) \
         VALUES ($1, $2, $3, $4, 'todo'::task_status, $5, $6, $6, $7, $8, false, false, 0, false)",
    )
    .bind(template.user_id)
    .bind(template.id)
    .bind(&template.title)
    .bind(&template.description)
    .bind(template.priority)
    .bind(date)
    .bind(template.start_time)
    .bind(template.end_time)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The start dates of a template's existing occurrences.
async fn existing_occurrence_dates(
    conn: &mut PgConnection,
    parent_id: Uuid,
) -> Result<HashSet<NaiveDate>, sqlx::Error> {
    let rows = sqlx::query("SELECT start_date FROM tasks WHERE parent_task_id = $1")
        .bind(parent_id)
        .fetch_all(&mut *conn)
        .await?;
    let mut set = HashSet::new();
    for row in rows {
        if let Some(date) = row.try_get::<Option<NaiveDate>, _>("start_date")? {
            set.insert(date);
        }
    }
    Ok(set)
}

/// Materialize a template's occurrences up to a 90-day horizon (background path).
pub async fn expand_task_occurrences(
    conn: &mut PgConnection,
    template: &Task,
) -> Result<u32, sqlx::Error> {
    let Some(rule) = template.recurrence_rule.clone() else {
        return Ok(0);
    };
    let today = Utc::now().date_naive();
    if let Some(end) = template.recurrence_end_date {
        if end < today {
            return Ok(0);
        }
    }
    let start = match template.start_date {
        Some(start) => start,
        None => {
            sqlx::query("UPDATE tasks SET start_date = $2 WHERE id = $1")
                .bind(template.id)
                .bind(today)
                .execute(&mut *conn)
                .await?;
            today
        }
    };
    let from = start.max(today);
    let horizon = from + chrono::Duration::days(INITIAL_HORIZON_DAYS);
    let instances = expand_recurring_instances(
        start,
        &rule,
        template.recurrence_end_date,
        MAX_OCCURRENCES,
        Some(horizon),
    );
    let mut candidates: BTreeSet<NaiveDate> = instances.into_iter().collect();
    candidates.remove(&start);
    if candidates.is_empty() {
        return Ok(0);
    }
    let existing = existing_occurrence_dates(conn, template.id).await?;
    let mut created = 0u32;
    for date in candidates {
        if existing.contains(&date) {
            continue;
        }
        insert_occurrence(conn, template, date).await?;
        created += 1;
    }
    Ok(created)
}

/// Materialize a template's occurrences intersecting `[from, to]` (lazy path).
pub async fn expand_task_occurrences_for_range(
    conn: &mut PgConnection,
    template: &Task,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<u32, sqlx::Error> {
    let Some(rule) = template.recurrence_rule.clone() else {
        return Ok(0);
    };
    let today = Utc::now().date_naive();
    let start = match template.start_date {
        Some(start) => start,
        None => {
            sqlx::query("UPDATE tasks SET start_date = $2 WHERE id = $1")
                .bind(template.id)
                .bind(today)
                .execute(&mut *conn)
                .await?;
            today
        }
    };
    if to < start {
        return Ok(0);
    }
    let budget = MAX_OCCURRENCES_ON_DEMAND.max(((to - start).num_days().max(0) as usize) + 1);
    let instances = expand_recurring_instances(
        start,
        &rule,
        template.recurrence_end_date,
        budget,
        Some(to),
    );
    let mut candidates: Vec<NaiveDate> = instances
        .into_iter()
        .filter(|d| *d >= from && *d <= to && *d != start)
        .collect();
    if candidates.is_empty() {
        return Ok(0);
    }
    candidates.truncate(MAX_OCCURRENCES_ON_DEMAND);
    let existing = existing_occurrence_dates(conn, template.id).await?;
    let mut created = 0u32;
    for date in candidates {
        if existing.contains(&date) {
            continue;
        }
        insert_occurrence(conn, template, date).await?;
        created += 1;
    }
    Ok(created)
}

/// Expand every recurring template for a window (read path). A single failure
/// must not abort the batch.
pub async fn expand_recurring_for_range(
    conn: &mut PgConnection,
    user_id: Option<Uuid>,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<u32, sqlx::Error> {
    let sql = format!(
        "SELECT {COLUMNS} FROM tasks WHERE recurrence_rule IS NOT NULL \
         AND status NOT IN ('done'::task_status, 'cancelled'::task_status) \
         AND deleted_at IS NULL AND (recurrence_end_date IS NULL OR recurrence_end_date >= $1) \
         AND ($2::uuid IS NULL OR user_id = $2)"
    );
    let rows = sqlx::query(&sql)
        .bind(from)
        .bind(user_id)
        .fetch_all(&mut *conn)
        .await?;
    let templates: Vec<Task> = rows.iter().map(Task::from_row).collect::<Result<_, _>>()?;
    let mut total = 0u32;
    for template in templates {
        if template.parent_task_id.is_some() {
            continue;
        }
        match expand_task_occurrences_for_range(conn, &template, from, to).await {
            Ok(created) => total += created,
            Err(err) => {
                tracing::warn!(error = %err, task_id = %template.id, "recurring range expansion failed");
            }
        }
    }
    Ok(total)
}

/// Expand every due recurring template, stamping the cooldown on success
/// (background path). A single failure leaves that template for the next pass.
pub async fn expand_recurring_tasks(
    conn: &mut PgConnection,
    user_id: Option<Uuid>,
    cooldown_hours: i64,
) -> Result<u32, sqlx::Error> {
    let today = Utc::now().date_naive();
    let cutoff = Utc::now() - chrono::Duration::hours(cooldown_hours);
    let sql = format!(
        "SELECT {COLUMNS} FROM tasks WHERE recurrence_rule IS NOT NULL \
         AND status NOT IN ('done'::task_status, 'cancelled'::task_status) \
         AND deleted_at IS NULL AND (recurrence_end_date IS NULL OR recurrence_end_date >= $1) \
         AND ($2::uuid IS NULL OR user_id = $2) \
         AND (recurrence_last_expanded_at IS NULL OR recurrence_last_expanded_at < $3)"
    );
    let rows = sqlx::query(&sql)
        .bind(today)
        .bind(user_id)
        .bind(cutoff)
        .fetch_all(&mut *conn)
        .await?;
    let templates: Vec<Task> = rows.iter().map(Task::from_row).collect::<Result<_, _>>()?;
    let mut total = 0u32;
    for template in templates {
        if template.parent_task_id.is_some() {
            continue;
        }
        match expand_task_occurrences(conn, &template).await {
            Ok(created) => {
                sqlx::query("UPDATE tasks SET recurrence_last_expanded_at = now() WHERE id = $1")
                    .bind(template.id)
                    .execute(&mut *conn)
                    .await?;
                total += created;
            }
            Err(err) => {
                tracing::warn!(error = %err, task_id = %template.id, "recurring expansion failed");
            }
        }
    }
    Ok(total)
}

/// Hourly background sweep over every user (Python `recurring_task_background_loop`).
pub async fn recurring_background_loop(pool: PgPool, interval: Duration, cooldown_hours: i64) {
    loop {
        let mut tx = match pool.begin().await {
            Ok(tx) => tx,
            Err(err) => {
                tracing::warn!(error = %err, "recurring loop could not begin a transaction");
                tokio::time::sleep(interval).await;
                continue;
            }
        };
        match expand_recurring_tasks(&mut *tx, None, cooldown_hours).await {
            Ok(created) => {
                if let Err(err) = tx.commit().await {
                    tracing::warn!(error = %err, "recurring loop commit failed");
                } else if created > 0 {
                    tracing::info!(created, "recurring occurrences materialized");
                }
            }
            Err(err) => {
                tracing::warn!(error = %err, "recurring loop expansion failed");
            }
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn daily_rule_expands_within_the_horizon() {
        let start = date(2026, 1, 1);
        let dates = expand_recurring_instances(
            start,
            "FREQ=DAILY",
            None,
            10,
            Some(date(2026, 1, 5)),
        );
        assert_eq!(dates, vec![date(2026, 1, 1), date(2026, 1, 2), date(2026, 1, 3), date(2026, 1, 4), date(2026, 1, 5)]);
    }

    #[test]
    fn weekly_interval_and_end_date_are_respected() {
        let start = date(2026, 1, 1);
        let dates = expand_recurring_instances(
            start,
            "FREQ=WEEKLY;INTERVAL=2",
            Some(date(2026, 1, 20)),
            10,
            None,
        );
        assert_eq!(dates, vec![date(2026, 1, 1), date(2026, 1, 15)]);
    }

    #[test]
    fn monthly_rule_skips_short_months() {
        let start = date(2026, 1, 31);
        let dates = expand_recurring_instances(start, "FREQ=MONTHLY;BYMONTHDAY=31", None, 4, None);
        assert_eq!(dates, vec![date(2026, 1, 31), date(2026, 3, 31), date(2026, 5, 31), date(2026, 7, 31)]);
    }

    #[test]
    fn count_limits_the_rule() {
        let dates =
            expand_recurring_instances(date(2026, 1, 1), "FREQ=DAILY;COUNT=3", None, 10, None);
        assert_eq!(dates.len(), 3);
    }

    #[test]
    fn malformed_rule_yields_nothing() {
        let dates = expand_recurring_instances(date(2026, 1, 1), "NOT A RULE", None, 10, None);
        assert!(dates.is_empty());
    }
}
