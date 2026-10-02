//! Account activity tracking + the GDPR-friendly inactivity lifecycle.
//!
//! Two responsibilities:
//!
//! * **Activity** - authenticated requests record a `last_active_at` timestamp
//!   on the user at most once per hour (throttled in-process and written
//!   fire-and-forget on the BYPASSRLS system pool so it never blocks or fails a
//!   request). Login and registration record it directly too.
//! * **Lifecycle** - a daily, leader-gated sweep warns users inactive for
//!   `INACTIVITY_WARNING_DAYS` (default 365) and deletes accounts still inactive
//!   `INACTIVITY_GRACE_DAYS` (default 30) after the warning. Activity after a
//!   warning clears the warning so the clock resets.
//!
//! Deletion removes every personal row (the existing `ON DELETE CASCADE`) and
//! leaves a non-personal audit tombstone in `account_deletions` (the user id, a
//! SHA-256 email hash, the reason and the timestamp). The Enterprise billing
//! tombstone (subscription and anti-abuse history) is written through the
//! [`DeletionRecorder`] hook the private build installs, so core never
//! references EE code. The tombstone lets a Subject Access Request or a Data
//! Protection Commission query be answered after the data is gone.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Settings;
use crate::email;
use crate::AppState;

/// Audit reason for a self-service (`DELETE /api/auth/me`) deletion.
pub const REASON_USER_REQUEST: &str = "user_request";
/// Audit reason for an inactivity-driven deletion.
pub const REASON_INACTIVITY: &str = "inactivity";

/// Records an anti-abuse/subscription tombstone for a deleted account. The
/// private build implements this over its billing tombstone table; community
/// installs none.
pub type DeletionRecorderFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

pub trait DeletionRecorder: Send + Sync {
    fn record<'a>(
        &'a self,
        pool: &'a PgPool,
        user_id: Uuid,
        email: &'a str,
    ) -> DeletionRecorderFuture<'a>;
}

static DELETION_RECORDER: OnceLock<Box<dyn DeletionRecorder>> = OnceLock::new();

/// Install the Enterprise deletion recorder. Called from the EE extension.
pub fn register_deletion_recorder(recorder: Box<dyn DeletionRecorder>) {
    let _ = DELETION_RECORDER.set(recorder);
}

fn deletion_recorder() -> Option<&'static dyn DeletionRecorder> {
    DELETION_RECORDER.get().map(|boxed| boxed.as_ref())
}

/// Lower-cased SHA-256 hex of an email, the non-reversible identifier kept in
/// the audit tombstone (matches the EE billing hash).
pub fn email_hash(email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.trim().to_ascii_lowercase().as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Delete an account, writing the audit tombstones first.
///
/// Idempotent: deleting an already-gone user is a no-op. `reason` is one of the
/// `REASON_*` constants. Runs on whichever pool the caller passes (system pool
/// for the cross-user loop, app pool for the self-service route).
pub async fn delete_user_account(
    pool: &PgPool,
    user_id: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    let Some(email) = email else {
        return Ok(());
    };

    // 1. Non-personal audit tombstone (answers a SAR/DPC query after deletion).
    sqlx::query(
        "INSERT INTO account_deletions (user_id, email_hash, reason, deleted_at) \
         VALUES ($1, $2, $3, now())",
    )
    .bind(user_id)
    .bind(email_hash(&email))
    .bind(reason)
    .execute(pool)
    .await?;

    // 2. Enterprise billing/subscription tombstone through the hook.
    if let Some(recorder) = deletion_recorder() {
        recorder.record(pool, user_id, &email).await;
    }

    // 3. Remove the personal data. Child rows cascade; orphaned blacklist rows
    //    are cleared explicitly (they are intentionally not FK-bound).
    sqlx::query("DELETE FROM token_blacklist WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// What the sweep should do for one user, given their activity timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InactivityAction {
    /// Active long enough ago that no warning has been sent yet.
    Warn,
    /// Warned, but the user has since been active: clear the warning.
    ClearWarning,
    /// Warned and still inactive past the grace window: delete.
    Delete,
    /// Nothing to do.
    None,
}

/// Pure decision function for the inactivity lifecycle. `now` is injected so the
/// time logic is unit-testable without a database.
pub fn classify_inactivity(
    last_active_at: Option<DateTime<Utc>>,
    warned_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    warning_days: i64,
    grace_days: i64,
) -> InactivityAction {
    let warning_cutoff = now - chrono::Duration::days(warning_days);
    let grace_cutoff = now - chrono::Duration::days(grace_days);
    match warned_at {
        Some(warned) => match last_active_at {
            // Active at or after the warning: reset the clock.
            Some(last) if last >= warned => InactivityAction::ClearWarning,
            // Still inactive and the grace window has fully elapsed: delete.
            Some(_) if warned < grace_cutoff => InactivityAction::Delete,
            // Unknown activity is never treated as inactive (safe default).
            _ => InactivityAction::None,
        },
        None => match last_active_at {
            Some(last) if last < warning_cutoff => InactivityAction::Warn,
            _ => InactivityAction::None,
        },
    }
}

/// How the sweep delivers an inactivity warning. Production uses `Real`;
/// tests can force a delivery result without a configured mail provider.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WarningDelivery {
    /// Send through the configured Brevo/SMTP transport.
    #[default]
    Real,
    /// Report success without sending (tests only).
    SimulateSuccess,
    /// Report failure without sending (tests only).
    SimulateFailure,
}

/// Outcome counters from one sweep pass (logged by the loop).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub warned: usize,
    /// Warnings that could not be delivered this pass. The user is left
    /// unwarned so the next sweep retries; a provider outage can never start a
    /// grace clock for someone who was never notified.
    pub warning_failed: usize,
    pub cleared: usize,
    pub deleted: usize,
}

/// Run one inactivity sweep against `pool` at logical time `now`.
///
/// Uses targeted queries (never a full-table scan) and one `now` per pass so a
/// user cannot be warned and deleted in the same run.
pub async fn inactivity_sweep(
    pool: &PgPool,
    settings: &Settings,
    now: DateTime<Utc>,
) -> Result<SweepReport, sqlx::Error> {
    inactivity_sweep_with(pool, settings, now, WarningDelivery::Real).await
}

/// Run one sweep with an injectable warning transport (see [`WarningDelivery`]).
pub async fn inactivity_sweep_with(
    pool: &PgPool,
    settings: &Settings,
    now: DateTime<Utc>,
    delivery: WarningDelivery,
) -> Result<SweepReport, sqlx::Error> {
    let warning_days = settings.inactivity_warning_days();
    let grace_days = settings.inactivity_grace_days();
    let warning_cutoff = now - chrono::Duration::days(warning_days);
    let grace_cutoff = now - chrono::Duration::days(grace_days);
    let mut report = SweepReport::default();

    // 1. Warn users inactive past the warning window who have not been warned.
    let to_warn: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users \
         WHERE inactivity_warned_at IS NULL \
           AND COALESCE(last_active_at, created_at) < $1",
    )
    .bind(warning_cutoff)
    .fetch_all(pool)
    .await?;
    for (user_id, email_addr) in to_warn {
        // Only start the grace clock once the warning has actually been
        // delivered. If the provider is down we leave the user unwarned and
        // retry next sweep, so an email outage can never delete someone who was
        // never notified.
        let delivered = match delivery {
            WarningDelivery::Real => {
                email::send_inactivity_warning(settings, &email_addr, grace_days).await
            }
            WarningDelivery::SimulateSuccess => true,
            WarningDelivery::SimulateFailure => false,
        };
        if !delivered {
            tracing::warn!(
                "inactivity warning to {email_addr} could not be delivered; will retry next sweep"
            );
            report.warning_failed += 1;
            continue;
        }
        sqlx::query("UPDATE users SET inactivity_warned_at = $2 WHERE id = $1")
            .bind(user_id)
            .bind(now)
            .execute(pool)
            .await?;
        report.warned += 1;
    }

    // 2. Clear warnings for users who became active after the warning, so a
    //    later inactivity period warns again from scratch.
    let cleared = sqlx::query(
        "UPDATE users SET inactivity_warned_at = NULL \
         WHERE inactivity_warned_at IS NOT NULL \
           AND last_active_at IS NOT NULL AND last_active_at >= inactivity_warned_at",
    )
    .execute(pool)
    .await?
    .rows_affected();
    report.cleared = cleared as usize;

    // 3. Delete users warned longer than the grace window ago and still inactive.
    let to_delete: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users \
         WHERE inactivity_warned_at IS NOT NULL \
           AND inactivity_warned_at < $1 \
           AND COALESCE(last_active_at, created_at) < inactivity_warned_at",
    )
    .bind(grace_cutoff)
    .fetch_all(pool)
    .await?;
    for user_id in to_delete {
        delete_user_account(pool, user_id, REASON_INACTIVITY).await?;
        report.deleted += 1;
    }

    Ok(report)
}

/// Daily loop wrapper. No-ops (returns immediately once) when disabled.
pub async fn inactivity_loop(pool: PgPool, settings: Settings, interval: Duration) {
    if !settings.account_inactivity_enabled() {
        tracing::info!("account inactivity lifecycle disabled");
        return;
    }
    loop {
        match inactivity_sweep(&pool, &settings, Utc::now()).await {
            Ok(report) => tracing::info!(
                "account inactivity sweep: warned={} failed={} cleared={} deleted={}",
                report.warned,
                report.warning_failed,
                report.cleared,
                report.deleted
            ),
            Err(err) => tracing::warn!("account inactivity sweep failed: {err}"),
        }
        tokio::time::sleep(interval).await;
    }
}

/// In-process throttle so a burst of requests for one user writes once an hour.
fn last_touch() -> &'static Mutex<HashMap<Uuid, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<Uuid, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record activity for an authenticated user, throttled to once per hour and
/// written fire-and-forget. Never blocks or fails the caller.
pub fn touch_activity(state: &AppState, user_id: Uuid) {
    let interval = Duration::from_secs(state.settings.activity_touch_interval_seconds());
    let now = Instant::now();
    if let Ok(mut map) = last_touch().lock() {
        if let Some(previous) = map.get(&user_id) {
            if now.duration_since(*previous) < interval {
                return;
            }
        }
        // Bounded: drop the oldest entry past a soft cap so a long-lived
        // process cannot grow the map without limit.
        if map.len() >= 100_000 {
            map.clear();
        }
        map.insert(user_id, now);
    } else {
        return;
    }

    let pool = state.system_pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("UPDATE users SET last_active_at = now() WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(days_ago: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 1, 12, 0, 0).unwrap() - chrono::Duration::days(days_ago)
    }

    #[test]
    fn active_user_is_untouched() {
        let now = at(0);
        assert_eq!(
            classify_inactivity(Some(at(1)), None, now, 365, 30),
            InactivityAction::None
        );
    }

    #[test]
    fn inactive_past_the_window_is_warned_once() {
        let now = at(0);
        assert_eq!(
            classify_inactivity(Some(at(400)), None, now, 365, 30),
            InactivityAction::Warn
        );
        // Already warned -> no second warning.
        assert_eq!(
            classify_inactivity(Some(at(400)), Some(at(10)), now, 365, 30),
            InactivityAction::None
        );
    }

    #[test]
    fn warned_but_still_inactive_inside_grace_is_kept() {
        let now = at(0);
        // Warned 10 days ago, grace is 30 -> not yet deletable.
        assert_eq!(
            classify_inactivity(Some(at(400)), Some(at(10)), now, 365, 30),
            InactivityAction::None
        );
    }

    #[test]
    fn warned_and_inactive_past_grace_is_deleted() {
        let now = at(0);
        assert_eq!(
            classify_inactivity(Some(at(400)), Some(at(31)), now, 365, 30),
            InactivityAction::Delete
        );
    }

    #[test]
    fn warned_but_became_active_clears_the_warning() {
        let now = at(0);
        // Warned 40 days ago but active 5 days ago -> reset, never delete.
        assert_eq!(
            classify_inactivity(Some(at(5)), Some(at(40)), now, 365, 30),
            InactivityAction::ClearWarning
        );
    }

    #[test]
    fn never_active_uses_the_warning_window_from_creation() {
        let now = at(0);
        // last_active unknown -> treated as still active, never deleted.
        assert_eq!(
            classify_inactivity(None, Some(at(100)), now, 365, 30),
            InactivityAction::None
        );
    }

    #[test]
    fn email_hash_is_lowercased_and_stable() {
        assert_eq!(email_hash("  User@Example.com "), email_hash("user@example.com"));
        assert_eq!(email_hash("a@b.com").len(), 64);
    }

    /// Live-Postgres coverage: the audit tombstone is written and the personal
    /// rows are gone after a deletion.
    #[tokio::test]
    async fn delete_writes_tombstone_and_removes_personal_data() {
        let Some(state) = live_state().await else {
            return;
        };
        crate::schema::ensure_schema(&state.pool, &state.system_pool)
            .await
            .expect("provision");
        let email = format!("rust-lifecycle-del-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "hash", None)
            .await
            .unwrap();

        delete_user_account(&state.pool, user.id, REASON_USER_REQUEST)
            .await
            .unwrap();

        let gone: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert!(gone, "user row must be deleted");

        let (hash, reason): (String, String) = sqlx::query_as(
            "SELECT email_hash, reason FROM account_deletions WHERE user_id = $1",
        )
        .bind(user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(hash, email_hash(&email));
        assert_eq!(reason, REASON_USER_REQUEST);

        // Idempotent: a second delete is a no-op.
        delete_user_account(&state.pool, user.id, REASON_USER_REQUEST)
            .await
            .unwrap();

        sqlx::query("DELETE FROM account_deletions WHERE email_hash = $1")
            .bind(email_hash(&email))
            .execute(&state.pool)
            .await
            .unwrap();
    }

    /// Serializes the sweep tests: a sweep scans and mutates every user, so two
    /// of them sharing the table concurrently would interfere (one test's
    /// successful warning could arm the deletion path for another's user).
    fn sweep_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    /// Live-Postgres coverage of the time-based sweep, driven with an injected
    /// `now` so it is deterministic and needs no env changes.
    #[tokio::test]
    async fn sweep_warns_then_deletes_and_clears_on_activity() {
        let Some(state) = live_state().await else {
            return;
        };
        let _guard = sweep_lock().lock().await;
        crate::schema::ensure_schema(&state.pool, &state.system_pool)
            .await
            .expect("provision");
        let settings = (*state.settings).clone();
        let now = Utc::now();

        // A: never warned, inactive 400 days -> warned this pass.
        let a_email = format!("rust-lifecycle-warn-{}@test.local", Uuid::new_v4());
        let a = crate::user::create_email_user(&state.pool, &a_email, "hash", None)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET last_active_at = $2 WHERE id = $1")
            .bind(a.id)
            .bind(now - chrono::Duration::days(400))
            .execute(&state.pool)
            .await
            .unwrap();

        let report = inactivity_sweep_with(&state.pool, &settings, now, WarningDelivery::SimulateSuccess)
            .await
            .unwrap();
        assert!(report.warned >= 1);
        let warned_at: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT inactivity_warned_at FROM users WHERE id = $1")
                .bind(a.id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert!(warned_at.is_some(), "A must be marked warned");

        // 31 days later, still inactive -> deleted (grace is 30).
        let report =
            inactivity_sweep_with(&state.pool, &settings, now + chrono::Duration::days(31), WarningDelivery::SimulateSuccess)
                .await
                .unwrap();
        assert!(report.deleted >= 1);
        let gone: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(a.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert!(gone, "A must be deleted after the grace window");

        // B: warned 40 days ago but active 5 days ago -> warning cleared, kept.
        let b_email = format!("rust-lifecycle-active-{}@test.local", Uuid::new_v4());
        let b = crate::user::create_email_user(&state.pool, &b_email, "hash", None)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE users SET last_active_at = $2, inactivity_warned_at = $3 WHERE id = $1",
        )
        .bind(b.id)
        .bind(now - chrono::Duration::days(5))
        .bind(now - chrono::Duration::days(40))
        .execute(&state.pool)
        .await
        .unwrap();

        let report = inactivity_sweep_with(&state.pool, &settings, now, WarningDelivery::SimulateSuccess)
            .await
            .unwrap();
        assert!(report.cleared >= 1);
        let still_there: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
                .bind(b.id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert!(still_there, "active user must never be deleted");
        let cleared: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT inactivity_warned_at FROM users WHERE id = $1")
                .bind(b.id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert!(cleared.is_none(), "warning must be cleared after activity");

        sqlx::query("DELETE FROM users WHERE id = $1").bind(b.id).execute(&state.pool).await.unwrap();
        sqlx::query("DELETE FROM account_deletions WHERE email_hash = $1")
            .bind(email_hash(&a_email))
            .execute(&state.pool)
            .await
            .unwrap();
    }

    /// A warning that cannot be delivered must NOT start the grace clock and
    /// must never lead to deletion, even long after the grace window; a later
    /// successful delivery warns normally.
    #[tokio::test]
    async fn undeliverable_warning_never_deletes() {
        let Some(state) = live_state().await else {
            return;
        };
        let _guard = sweep_lock().lock().await;
        crate::schema::ensure_schema(&state.pool, &state.system_pool)
            .await
            .expect("provision");
        let settings = (*state.settings).clone();
        let now = Utc::now();

        let email = format!("rust-lifecycle-undeliverable-{}@test.local", Uuid::new_v4());
        let user = crate::user::create_email_user(&state.pool, &email, "hash", None)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET last_active_at = $2 WHERE id = $1")
            .bind(user.id)
            .bind(now - chrono::Duration::days(400))
            .execute(&state.pool)
            .await
            .unwrap();

        // Provider down: no warning is recorded, so no grace clock starts.
        let report =
            inactivity_sweep_with(&state.pool, &settings, now, WarningDelivery::SimulateFailure)
                .await
                .unwrap();
        assert!(report.warning_failed >= 1);
        let warned: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT inactivity_warned_at FROM users WHERE id = $1")
                .bind(user.id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert!(warned.is_none(), "failed delivery must not start the grace clock");

        // Even 90 days later (well past the 30-day grace) the unnotified user
        // is still present, because no warning ever landed.
        let _ =
            inactivity_sweep_with(&state.pool, &settings, now + chrono::Duration::days(90), WarningDelivery::SimulateFailure)
                .await
                .unwrap();
        let still_there: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert!(still_there, "an unnotified user must never be deleted");

        // A later successful delivery warns and starts the clock.
        let report =
            inactivity_sweep_with(&state.pool, &settings, now + chrono::Duration::days(90), WarningDelivery::SimulateSuccess)
                .await
                .unwrap();
        assert!(report.warned >= 1);
        let warned: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT inactivity_warned_at FROM users WHERE id = $1")
                .bind(user.id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert!(warned.is_some(), "successful delivery must start the grace clock");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    async fn live_state() -> Option<AppState> {
        // Settings::from_env already reads DATABASE_URL; skip when unset so the
        // DB-backed tests return early exactly like the rest of the suite.
        std::env::var("DATABASE_URL").ok()?;
        Some(AppState::lazy(Settings::from_env()))
    }
}
