//! Notification engine, ported from
//! `apps/backend/app/services/notification_service.py`.
//!
//! Per-user preferences, due-date alerts (email + Web Push) and the daily digest
//! email. The background loop runs as a system / BYPASSRLS reader on the raw
//! pool so it can see every user's data, exactly like the Python loop which uses
//! a dedicated system session; it never sets `app.user_id`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, Timelike, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::config::Settings;
use crate::email;
use crate::notifications::load_prefs;
use crate::push_service::{send_push, PushResult};

/// One due task row (id, owner, title, due date).
struct DueTask {
    id: Uuid,
    user_id: Uuid,
    title: String,
    due_date: NaiveDate,
}

/// One scheduled per-task reminder row.
struct ScheduledReminder {
    id: Uuid,
    user_id: Uuid,
    title: String,
    due_date: Option<NaiveDate>,
    reminder_at: DateTime<Utc>,
    inapp: bool,
    push: bool,
    email: bool,
}

/// Load a user's prefs, creating the default row on first read
/// (Python `get_or_create_prefs`).
async fn get_or_create_prefs(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> Result<crate::notifications::Prefs, sqlx::Error> {
    load_prefs(&mut *conn, user_id).await
}

/// Insert a dedupe log row (Python `_log_sent`).
async fn log_sent(
    conn: &mut PgConnection,
    user_id: Uuid,
    task_id: Option<Uuid>,
    kind: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO notification_logs (user_id, task_id, kind) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(task_id)
        .bind(kind)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Send a push to every subscription a user owns, deleting dead endpoints
/// (Python `_push_to_user`). Also reused by the dev-only
/// `POST /api/notifications/test` endpoint (production-gated off).
pub(crate) async fn push_to_user(
    conn: &mut PgConnection,
    user_id: Uuid,
    title: &str,
    body: &str,
    settings: &Settings,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;

    for row in rows {
        let id: Uuid = row.try_get("id")?;
        let endpoint: String = row.try_get("endpoint")?;
        let p256dh: String = row.try_get("p256dh")?;
        let auth: String = row.try_get("auth")?;
        let payload = serde_json::json!({ "title": title, "body": body });
        if send_push(settings, &endpoint, &p256dh, &auth, &payload).await == PushResult::Stale {
            sqlx::query("DELETE FROM push_subscriptions WHERE id = $1")
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// The From address for automated notification email: `notify_email` when set,
/// otherwise the core mailer's `admin_email` default (None lets it fall back).
fn notification_from<'a>(settings: &'a Settings) -> Option<&'a str> {
    if settings.notify_email.is_empty() {
        None
    } else {
        Some(settings.notify_email.as_str())
    }
}

/// Email + push a "due soon" alert for tasks due today or tomorrow, at most once
/// per task per user (deduped via `notification_logs`). Returns the count sent.
pub async fn send_due_alerts(
    conn: &mut PgConnection,
    settings: &Settings,
) -> Result<i64, sqlx::Error> {
    let today = Utc::now().date_naive();
    let tomorrow = today + chrono::Duration::days(1);

    let rows = sqlx::query(
        "SELECT id, user_id, title, due_date FROM tasks \
         WHERE due_date >= $1 AND due_date <= $2 \
           AND deleted_at IS NULL \
           AND status::text NOT IN ('done', 'cancelled') \
           AND is_archived = false \
           AND reminder_enabled = true",
    )
    .bind(today)
    .bind(tomorrow)
    .fetch_all(&mut *conn)
    .await?;

    let tasks: Vec<DueTask> = rows
        .iter()
        .map(|row| {
            Ok(DueTask {
                id: row.try_get("id")?,
                user_id: row.try_get("user_id")?,
                title: row.try_get("title")?,
                due_date: row.try_get("due_date")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()?;
    if tasks.is_empty() {
        return Ok(0);
    }

    let mut user_ids: Vec<Uuid> = tasks.iter().map(|t| t.user_id).collect();
    user_ids.sort();
    user_ids.dedup();

    // Batch-load users (id -> email) and the due-alert dedupe log.
    let user_rows = sqlx::query("SELECT id, email FROM users WHERE id = ANY($1)")
        .bind(&user_ids)
        .fetch_all(&mut *conn)
        .await?;
    let mut users_by_id: HashMap<Uuid, Option<String>> = HashMap::new();
    for row in &user_rows {
        let id: Uuid = row.try_get("id")?;
        let email: Option<String> = row.try_get("email")?;
        users_by_id.insert(id, email);
    }

    let task_ids: Vec<Uuid> = tasks.iter().map(|t| t.id).collect();
    let log_rows = sqlx::query(
        "SELECT user_id, task_id FROM notification_logs \
         WHERE kind = 'due' AND task_id = ANY($1) AND user_id = ANY($2)",
    )
    .bind(&task_ids)
    .bind(&user_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut already_sent: HashSet<(Uuid, Uuid)> = HashSet::new();
    for row in &log_rows {
        let task_id: Option<Uuid> = row.try_get("task_id")?;
        let user_id: Option<Uuid> = row.try_get("user_id")?;
        if let (Some(task_id), Some(user_id)) = (task_id, user_id) {
            already_sent.insert((user_id, task_id));
        }
    }

    let mut prefs_by_user: HashMap<Uuid, crate::notifications::Prefs> = HashMap::new();
    let mut sent = 0i64;
    for task in &tasks {
        if already_sent.contains(&(task.user_id, task.id)) {
            continue;
        }

        if !prefs_by_user.contains_key(&task.user_id) {
            let prefs = get_or_create_prefs(&mut *conn, task.user_id).await?;
            prefs_by_user.insert(task.user_id, prefs);
        }
        let (due_alerts, email_reminders, push_enabled) = {
            let prefs = prefs_by_user.get(&task.user_id).expect("prefs inserted above");
            (prefs.due_alerts, prefs.email_reminders, prefs.push_enabled)
        };
        if !due_alerts {
            continue;
        }

        let title = format!("Reminder: Due soon - {}", task.title);
        let body = format!(
            "'{}' is due {} - don't let it slip.",
            task.title,
            task.due_date.format("%Y-%m-%d")
        );

        let mut attempted = false;
        if email_reminders {
            if let Some(Some(email)) = users_by_id.get(&task.user_id) {
                if !email.is_empty() {
                    email::send_email(
                        settings,
                        email,
                        &title,
                        &body,
                        notification_from(settings),
                    )
                    .await;
                    attempted = true;
                }
            }
        }
        if push_enabled {
            push_to_user(&mut *conn, task.user_id, &title, &body, settings).await?;
            attempted = true;
        }
        if attempted {
            log_sent(&mut *conn, task.user_id, Some(task.id), "due").await?;
            sent += 1;
        }
    }

    Ok(sent)
}

/// Send the email/push channels for per-task scheduled reminders whose
/// `reminder_at` has arrived. Delivery is deduped per (task, reminder time):
/// a log row written at or after the reminder time suppresses a repeat, while
/// rescheduling the reminder to a later time makes it eligible again. In-app
/// delivery stays client-side (the running app polls the due-reminders route),
/// so this pass only needs a task when it has email or push selected.
pub async fn send_task_reminders(
    conn: &mut PgConnection,
    settings: &Settings,
) -> Result<i64, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, user_id, title, due_date, reminder_at, \
                reminder_inapp, reminder_push, reminder_email FROM tasks \
         WHERE reminder_at IS NOT NULL AND reminder_at <= now() \
           AND reminder_enabled = true \
           AND deleted_at IS NULL AND is_archived = false \
           AND status::text NOT IN ('done', 'cancelled') \
           AND (reminder_email = true OR reminder_push = true) \
         ORDER BY reminder_at ASC LIMIT 200",
    )
    .fetch_all(&mut *conn)
    .await?;

    let reminders: Vec<ScheduledReminder> = rows
        .iter()
        .map(|row| {
            Ok(ScheduledReminder {
                id: row.try_get("id")?,
                user_id: row.try_get("user_id")?,
                title: row.try_get("title")?,
                due_date: row.try_get("due_date")?,
                reminder_at: row.try_get("reminder_at")?,
                inapp: row.try_get("reminder_inapp")?,
                push: row.try_get("reminder_push")?,
                email: row.try_get("reminder_email")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()?;
    if reminders.is_empty() {
        return Ok(0);
    }

    let task_ids: Vec<Uuid> = reminders.iter().map(|r| r.id).collect();
    let log_rows = sqlx::query(
        "SELECT task_id, MAX(sent_at) AS sent_at FROM notification_logs \
         WHERE kind = 'task_reminder' AND task_id = ANY($1) GROUP BY task_id",
    )
    .bind(&task_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut last_sent: HashMap<Uuid, DateTime<Utc>> = HashMap::new();
    for row in &log_rows {
        let task_id: Option<Uuid> = row.try_get("task_id")?;
        let sent_at: Option<DateTime<Utc>> = row.try_get("sent_at")?;
        if let (Some(task_id), Some(sent_at)) = (task_id, sent_at) {
            last_sent.insert(task_id, sent_at);
        }
    }

    let mut user_ids: Vec<Uuid> = reminders.iter().map(|r| r.user_id).collect();
    user_ids.sort();
    user_ids.dedup();
    let user_rows = sqlx::query("SELECT id, email FROM users WHERE id = ANY($1)")
        .bind(&user_ids)
        .fetch_all(&mut *conn)
        .await?;
    let mut users_by_id: HashMap<Uuid, Option<String>> = HashMap::new();
    for row in &user_rows {
        let id: Uuid = row.try_get("id")?;
        let email: Option<String> = row.try_get("email")?;
        users_by_id.insert(id, email);
    }

    let mut prefs_by_user: HashMap<Uuid, crate::notifications::Prefs> = HashMap::new();
    let mut sent = 0i64;
    for reminder in &reminders {
        // A log row from at or after this reminder's time means it already went
        // out; an earlier row belongs to a previous (pre-reschedule) reminder.
        if last_sent
            .get(&reminder.id)
            .is_some_and(|sent_at| *sent_at >= reminder.reminder_at)
        {
            continue;
        }

        if !prefs_by_user.contains_key(&reminder.user_id) {
            let prefs = get_or_create_prefs(&mut *conn, reminder.user_id).await?;
            prefs_by_user.insert(reminder.user_id, prefs);
        }
        let (email_reminders, push_enabled) = {
            let prefs = prefs_by_user
                .get(&reminder.user_id)
                .expect("prefs inserted above");
            (prefs.email_reminders, prefs.push_enabled)
        };

        let title = format!("Reminder: {}", reminder.title);
        let body = match reminder.due_date {
            Some(due) => format!(
                "This is your reminder for '{}' (due {}).",
                reminder.title,
                due.format("%Y-%m-%d")
            ),
            None => format!("This is your reminder for '{}'.", reminder.title),
        };

        let mut attempted = false;
        if reminder.email && email_reminders {
            if let Some(Some(address)) = users_by_id.get(&reminder.user_id) {
                if !address.is_empty() {
                    email::send_email(settings, address, &title, &body, notification_from(settings))
                        .await;
                    attempted = true;
                }
            }
        }
        if reminder.push && push_enabled {
            match push_to_user(
                &mut *conn,
                reminder.user_id,
                &title,
                &body,
                settings,
            )
            .await
            {
                Ok(()) => attempted = true,
                Err(err) => {
                    // One dead push service must not abort the whole pass.
                    tracing::warn!(error = %err, task_id = %reminder.id, "task reminder push failed");
                }
            }
        }
        if attempted {
            log_sent(&mut *conn, reminder.user_id, Some(reminder.id), "task_reminder").await?;
            // When no in-app card is expected, the server has completed every
            // selected channel, so clear the one-off time. With in-app selected
            // it stays until the running client shows the card (deduped by the
            // log above) or the user clears/completes the task.
            if !reminder.inapp {
                sqlx::query(
                    "UPDATE tasks SET reminder_at = NULL, updated_at = now() WHERE id = $1",
                )
                .bind(reminder.id)
                .execute(&mut *conn)
                .await?;
            }
            sent += 1;
        }
    }

    Ok(sent)
}

/// Fast per-task reminder loop (email + Web Push). Runs every minute so a
/// reminder set for a specific time is not delayed by the slower due-alert /
/// digest interval. Per-pass transaction, per-item tolerant.
pub async fn task_reminder_background_loop(pool: PgPool, settings: Settings) {
    loop {
        if settings.notifications_enabled {
            match pool.begin().await {
                Ok(mut tx) => {
                    match send_task_reminders(&mut *tx, &settings).await {
                        Ok(count) if count > 0 => {
                            tracing::info!("task reminders: sent {count} scheduled reminder(s)")
                        }
                        Ok(_) => {}
                        Err(err) => {
                            tracing::warn!(error = %err, "task reminder pass failed");
                            let _ = tx.rollback().await;
                            tokio::time::sleep(Duration::from_secs(60)).await;
                            continue;
                        }
                    }
                    if let Err(err) = tx.commit().await {
                        tracing::warn!(error = %err, "task reminder pass commit failed");
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "task reminder loop could not begin a transaction");
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// Send the daily digest email (summary of today's tasks) once per calendar day
/// per user. Returns the count sent.
pub async fn send_daily_digests(
    conn: &mut PgConnection,
    settings: &Settings,
    day: Option<NaiveDate>,
) -> Result<i64, sqlx::Error> {
    let day = day.unwrap_or_else(|| Utc::now().date_naive());
    // Dedupe per DAY, not once-ever: only logs from this day count.
    let day_start = day.and_hms_opt(0, 0, 0).expect("valid midnight");

    let already_rows = sqlx::query(
        "SELECT user_id FROM notification_logs WHERE kind = 'digest' AND sent_at >= $1",
    )
    .bind(day_start)
    .fetch_all(&mut *conn)
    .await?;
    let already_sent: HashSet<Uuid> = already_rows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("user_id").ok())
        .collect();

    let target_rows = sqlx::query(
        "SELECT user_id FROM user_notification_prefs WHERE email_digest = true",
    )
    .fetch_all(&mut *conn)
    .await?;
    let target_ids: Vec<Uuid> = target_rows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("user_id").ok())
        .filter(|user_id| !already_sent.contains(user_id))
        .collect();
    if target_ids.is_empty() {
        return Ok(0);
    }

    let user_rows = sqlx::query("SELECT id, email FROM users WHERE id = ANY($1)")
        .bind(&target_ids)
        .fetch_all(&mut *conn)
        .await?;
    let mut users_by_id: HashMap<Uuid, Option<String>> = HashMap::new();
    for row in &user_rows {
        let id: Uuid = row.try_get("id")?;
        let email: Option<String> = row.try_get("email")?;
        users_by_id.insert(id, email);
    }

    let task_rows = sqlx::query(
        "SELECT user_id, title FROM tasks \
         WHERE due_date = $1 AND deleted_at IS NULL \
           AND status::text NOT IN ('done', 'cancelled') \
           AND is_archived = false",
    )
    .bind(day)
    .fetch_all(&mut *conn)
    .await?;
    let mut titles_by_user: HashMap<Uuid, Vec<String>> = HashMap::new();
    for row in &task_rows {
        let user_id: Uuid = row.try_get("user_id")?;
        let title: String = row.try_get("title")?;
        titles_by_user.entry(user_id).or_default().push(title);
    }

    let mut sent = 0i64;
    for user_id in target_ids {
        if already_sent.contains(&user_id) {
            continue;
        }
        let Some(titles) = titles_by_user.get(&user_id) else {
            continue;
        };
        if titles.is_empty() {
            continue;
        }
        let Some(Some(email)) = users_by_id.get(&user_id) else {
            continue;
        };
        if email.is_empty() {
            continue;
        }

        let lines = titles
            .iter()
            .map(|title| format!("- {title}"))
            .collect::<Vec<_>>()
            .join("\n");
        let subject = format!("Your plan for {}", day.format("%Y-%m-%d"));
        let body = format!(
            "Here's what's on your plate today:\n\n{lines}\n\nHave a productive day!"
        );
        email::send_email(settings, email, &subject, &body, None).await;
        log_sent(&mut *conn, user_id, None, "digest").await?;
        sent += 1;
    }

    Ok(sent)
}

/// Background loop: due alerts every interval, daily digest at `digest_hour`.
/// No-op when `notifications_enabled` is off (safe on dev/community builds). One
/// pass is one transaction, committed on success and rolled back on error, so a
/// failure never kills the loop (Python `notification_background_loop`).
pub async fn notification_background_loop(
    pool: PgPool,
    settings: Settings,
    interval: Duration,
) {
    loop {
        if settings.notifications_enabled {
            match pool.begin().await {
                Ok(mut tx) => {
                    let mut failed = false;
                    if let Err(err) = send_due_alerts(&mut *tx, &settings).await {
                        tracing::warn!(error = %err, "notification due-alert pass failed");
                        failed = true;
                    }
                    if !failed
                        && chrono::Local::now().hour() == settings.digest_hour
                    {
                        if let Err(err) = send_daily_digests(&mut *tx, &settings, None).await {
                            tracing::warn!(error = %err, "notification digest pass failed");
                            failed = true;
                        }
                    }
                    if failed {
                        let _ = tx.rollback().await;
                    } else if let Err(err) = tx.commit().await {
                        tracing::warn!(error = %err, "notification pass commit failed");
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "notification loop could not begin a transaction");
                }
            }
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    async fn live_settings() -> Option<Settings> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let mut settings = config::tests::sample("test");
        settings.database_url = url;
        Some(settings)
    }

    async fn count_due_logs(pool: &PgPool, task_id: Uuid) -> i64 {
        sqlx::query(
            "SELECT COUNT(*)::bigint AS n FROM notification_logs \
             WHERE kind = 'due' AND task_id = $1",
        )
        .bind(task_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .try_get::<i64, _>("n")
        .unwrap()
    }

    #[tokio::test]
    async fn due_alerts_insert_log_and_dedupe() {
        let Some(settings) = live_settings().await else {
            return;
        };
        let pool = crate::db::connect(&settings.database_url).await.unwrap();

        let email = format!("rust-notif-svc-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();

        // Email is off and push is on with no subscriptions, so the pass marks
        // the alert "attempted" (and logs it) without any network call.
        sqlx::query(
            "INSERT INTO user_notification_prefs \
             (user_id, inapp_reminders, reminder_time, email_reminders, due_alerts, \
              email_digest, push_enabled, sound) \
             VALUES ($1, true, '20:00', false, true, false, true, true) \
             ON CONFLICT (user_id) DO UPDATE \
             SET email_reminders = false, due_alerts = true, push_enabled = true",
        )
        .bind(user.id)
        .execute(&pool)
        .await
        .unwrap();

        let due_day = Utc::now().date_naive();
        let task_id: Uuid = sqlx::query(
            "INSERT INTO tasks \
             (user_id, parent_task_id, title, description, status, priority, start_date, \
              due_date, start_time, end_time, is_all_day, is_archived, sort_order, reminder_enabled) \
             VALUES ($1, NULL, $2, NULL, 'todo'::task_status, 0, $3, $3, NULL, NULL, false, false, 0, true) \
             RETURNING id",
        )
        .bind(user.id)
        .bind("Rust due alert task")
        .bind(due_day)
        .fetch_one(&pool)
        .await
        .unwrap()
        .try_get("id")
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let first = send_due_alerts(&mut *tx, &settings).await.unwrap();
        tx.commit().await.unwrap();
        assert!(first >= 1, "at least our task must be alerted");
        assert_eq!(count_due_logs(&pool, task_id).await, 1);

        // Second pass must not create another log row for the same task.
        let mut tx = pool.begin().await.unwrap();
        send_due_alerts(&mut *tx, &settings).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(count_due_logs(&pool, task_id).await, 1, "dedupe failed");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await
            .unwrap();
    }

    async fn count_digest_logs(pool: &PgPool, user_id: Uuid) -> i64 {
        sqlx::query(
            "SELECT COUNT(*)::bigint AS n FROM notification_logs \
             WHERE kind = 'digest' AND user_id = $1 AND task_id IS NULL",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .try_get::<i64, _>("n")
        .unwrap()
    }

    #[tokio::test]
    async fn daily_digest_logs_once_per_day() {
        let Some(settings) = live_settings().await else {
            return;
        };
        let pool = crate::db::connect(&settings.database_url).await.unwrap();

        let email = format!("rust-digest-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO user_notification_prefs \
             (user_id, inapp_reminders, reminder_time, email_reminders, due_alerts, \
              email_digest, push_enabled, sound) \
             VALUES ($1, true, '20:00', false, true, true, false, true) \
             ON CONFLICT (user_id) DO UPDATE SET email_digest = true",
        )
        .bind(user.id)
        .execute(&pool)
        .await
        .unwrap();

        let due_day = Utc::now().date_naive();
        sqlx::query(
            "INSERT INTO tasks \
             (user_id, parent_task_id, title, description, status, priority, start_date, \
              due_date, start_time, end_time, is_all_day, is_archived, sort_order, reminder_enabled) \
             VALUES ($1, NULL, $2, NULL, 'todo'::task_status, 0, $3, $3, NULL, NULL, false, false, 0, false)",
        )
        .bind(user.id)
        .bind("Rust digest task")
        .bind(due_day)
        .execute(&pool)
        .await
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let first = send_daily_digests(&mut *tx, &settings, Some(due_day)).await.unwrap();
        tx.commit().await.unwrap();
        assert!(first >= 1, "at least our digest must be sent");
        assert_eq!(count_digest_logs(&pool, user.id).await, 1);

        let mut tx = pool.begin().await.unwrap();
        send_daily_digests(&mut *tx, &settings, Some(due_day)).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(count_digest_logs(&pool, user.id).await, 1, "digest dedupe failed");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await
            .unwrap();
    }

    async fn count_task_reminder_logs(pool: &PgPool, task_id: Uuid) -> i64 {
        sqlx::query(
            "SELECT COUNT(*)::bigint AS n FROM notification_logs \
             WHERE kind = 'task_reminder' AND task_id = $1",
        )
        .bind(task_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .try_get::<i64, _>("n")
        .unwrap()
    }

    #[tokio::test]
    async fn scheduled_task_reminder_sends_once_and_dedupes() {
        let Some(settings) = live_settings().await else {
            return;
        };
        let pool = crate::db::connect(&settings.database_url).await.unwrap();

        let email = format!("rust-task-reminder-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();

        // Push is enabled with no subscriptions, so the pass records an attempt
        // (and a dedupe log) without any network call.
        sqlx::query(
            "INSERT INTO user_notification_prefs \
             (user_id, inapp_reminders, reminder_time, email_reminders, due_alerts, \
              email_digest, push_enabled, sound) \
             VALUES ($1, true, '20:00', false, true, false, true, true) \
             ON CONFLICT (user_id) DO UPDATE SET push_enabled = true",
        )
        .bind(user.id)
        .execute(&pool)
        .await
        .unwrap();

        let task_id: Uuid = sqlx::query(
            "INSERT INTO tasks \
             (user_id, parent_task_id, title, description, status, priority, start_date, \
              due_date, start_time, end_time, is_all_day, is_archived, sort_order, \
              reminder_enabled, reminder_at, reminder_push) \
             VALUES ($1, NULL, $2, NULL, 'todo'::task_status, 0, NULL, NULL, NULL, NULL, \
                     false, false, 0, true, now() - interval '1 minute', true) \
             RETURNING id",
        )
        .bind(user.id)
        .bind("Scheduled reminder task")
        .fetch_one(&pool)
        .await
        .unwrap()
        .try_get("id")
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let first = send_task_reminders(&mut *tx, &settings).await.unwrap();
        tx.commit().await.unwrap();
        assert!(first >= 1, "at least our scheduled reminder must be sent");
        assert_eq!(count_task_reminder_logs(&pool, task_id).await, 1);

        let mut tx = pool.begin().await.unwrap();
        send_task_reminders(&mut *tx, &settings).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count_task_reminder_logs(&pool, task_id).await,
            1,
            "scheduled reminder dedupe failed"
        );

        // Rescheduling to the future keeps it out of the due scan.
        sqlx::query("UPDATE tasks SET reminder_at = now() + interval '1 hour' WHERE id = $1")
            .bind(task_id)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        send_task_reminders(&mut *tx, &settings).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count_task_reminder_logs(&pool, task_id).await,
            1,
            "a future reminder must not send"
        );

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await
            .unwrap();
    }
}
