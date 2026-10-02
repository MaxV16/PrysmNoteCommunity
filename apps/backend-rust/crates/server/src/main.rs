//! `prysm-server` - the single Rust binary. It wires the open-core router with the
//! optional extension crate and serves it.

use axum::Router;
use prysm_core::config::Settings;
use prysm_core::{build_router, AppState, EeExtension};

fn router(state: AppState) -> Router {
    #[cfg(feature = "ee")]
    let extension = prysm_ee::Ee::new(state.clone());
    #[cfg(feature = "ee")]
    let ee: Option<&dyn EeExtension> = Some(&extension);
    #[cfg(not(feature = "ee"))]
    let ee: Option<&dyn EeExtension> = None;

    build_router(state, ee)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let settings = Settings::from_env();
    let pool = prysm_core::db::connect(&settings.database_url)
        .await
        .expect("failed to connect to the database");
    let state = AppState::new(pool, settings);

    // First-boot schema provisioning: a no-op once the tables exist, so every
    // later startup (including production) skips it. Runs before any request.
    prysm_core::schema::ensure_schema(&state.pool, &state.system_pool)
        .await
        .expect("failed to provision the core schema");
    #[cfg(feature = "ee")]
    prysm_ee::schema::ensure_schema(&state.pool, &state.system_pool)
        .await
        .expect("failed to provision the Enterprise schema");

    let port = state.settings.port;

    // Background loops run only when explicitly enabled AND this worker holds the
    // advisory-lock leadership (one worker per fleet); followers serve HTTP only.
    let mut leader = prysm_core::loop_leader::BackgroundLeader::follower();
    if state.settings.run_background_loops() {
        leader = prysm_core::loop_leader::BackgroundLeader::try_acquire(
            &state.settings.database_url,
        )
        .await;
    } else {
        tracing::info!("PRYSM_RUN_BACKGROUND_LOOPS disabled; no background loops started");
    }

    if leader.is_leader() {
        // Cross-user loops run on the BYPASSRLS system pool so their queries
        // are not filtered to zero rows by the RLS policies; the request paths
        // keep using the RLS-enforced app pool.
        let flush_pool = state.system_pool.clone();
        let flush_interval =
            std::time::Duration::from_secs(state.settings.analytics_flush_interval());
        tokio::spawn(prysm_core::analytics::analytics_flush_loop(
            flush_pool,
            flush_interval,
        ));
        let rollup_pool = state.system_pool.clone();
        let rollup_interval =
            std::time::Duration::from_secs(state.settings.analytics_rollup_interval());
        let retention_days = state.settings.analytics_retention_days();
        let anon_retention_days = state.settings.analytics_anon_retention_days();
        tokio::spawn(prysm_core::analytics::analytics_rollup_loop(
            rollup_pool,
            rollup_interval,
            retention_days,
            anon_retention_days,
        ));

        let recurring_pool = state.system_pool.clone();
        let recurring_interval =
            std::time::Duration::from_secs(state.settings.recurring_expand_interval_seconds());
        let recurring_cooldown = state.settings.recurring_expand_cooldown_hours();
        tokio::spawn(prysm_core::recurring::recurring_background_loop(
            recurring_pool,
            recurring_interval,
            recurring_cooldown,
        ));

        let notification_pool = state.system_pool.clone();
        let notification_settings = (*state.settings).clone();
        let notification_interval = std::time::Duration::from_secs(
            state.settings.notification_loop_interval,
        );
        tokio::spawn(prysm_core::notification_service::notification_background_loop(
            notification_pool,
            notification_settings,
            notification_interval,
        ));

        let gcal_pool = state.system_pool.clone();
        let gcal_settings = (*state.settings).clone();
        let gcal_interval = std::time::Duration::from_secs(state.settings.gcal_pull_interval());
        tokio::spawn(prysm_core::calendar::gcal_pull_background_loop(
            gcal_pool,
            gcal_settings,
            gcal_interval,
        ));

        // Hourly maintenance: prune expired token-blacklist / AI cache rows and
        // AI usage past the retention window (system pool).
        let maintenance_pool = state.system_pool.clone();
        let maintenance_interval = std::time::Duration::from_secs(3600);
        let ai_usage_retention_days = state.settings.ai_usage_retention_days();
        tokio::spawn(prysm_core::maintenance::maintenance_cleanup_loop(
            maintenance_pool,
            maintenance_interval,
            ai_usage_retention_days,
        ));

        // Trash purge: hard-delete tasks trashed more than 14 days ago (system
        // pool covers every user), every 6 hours.
        let trash_pool = state.system_pool.clone();
        tokio::spawn(prysm_core::tasks::trash_purge_loop(
            trash_pool,
            std::time::Duration::from_secs(6 * 3600),
        ));

        // Shows & Movies: refresh upcoming-continuation metadata for stale
        // items, every 6 hours (self-skips with no TMDB key).
        let watchlist_pool = state.system_pool.clone();
        let watchlist_settings = (*state.settings).clone();
        tokio::spawn(prysm_core::watchlist::watchlist_background_loop(
            watchlist_pool,
            watchlist_settings,
            std::time::Duration::from_secs(prysm_core::watchlist::REFRESH_INTERVAL_SECONDS),
        ));

        // GDPR account inactivity lifecycle: warn accounts inactive for a year,
        // delete 30 days later if still inactive (system pool, daily).
        let inactivity_pool = state.system_pool.clone();
        let inactivity_settings = (*state.settings).clone();
        tokio::spawn(prysm_core::lifecycle::inactivity_loop(
            inactivity_pool,
            inactivity_settings,
            std::time::Duration::from_secs(24 * 3600),
        ));

        #[cfg(feature = "ee")]
        {
            let workflow_pool = state.system_pool.clone();
            let workflow_key = state.settings.encryption_key.clone();
            tokio::spawn(prysm_ee::workflow::workflow_background_loop(
                workflow_pool,
                workflow_key,
                std::time::Duration::from_secs(prysm_ee::workflow::SWEEP_INTERVAL_SECONDS),
            ));

            // The email poll lists every user's account through the system pool
            // internally (poll_due_users), so it keeps taking the state handle.
            let email_state = state.clone();
            tokio::spawn(prysm_ee::email::email_poll_background_loop(email_state));

            // One-shot FX warm-up so the pricing page has rates immediately.
            tokio::spawn(prysm_ee::fx::warm_fx_cache());

            let digest_pool = state.system_pool.clone();
            let digest_settings = (*state.settings).clone();
            tokio::spawn(prysm_ee::loops::openclaw_digest_background_loop(
                digest_pool,
                digest_settings,
                std::time::Duration::from_secs(prysm_ee::loops::DIGEST_LOOP_INTERVAL_SECONDS),
            ));

            let trial_pool = state.system_pool.clone();
            let trial_settings = (*state.settings).clone();
            tokio::spawn(prysm_ee::loops::trial_notice_background_loop(
                trial_pool,
                trial_settings,
                std::time::Duration::from_secs(
                    prysm_ee::loops::TRIAL_NOTICE_LOOP_INTERVAL_SECONDS,
                ),
            ));
        }
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind");
    tracing::info!("prysm-core listening on {port}");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");

    leader.release().await;
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn server_exposes_health() {
        let response = router(AppState::lazy(Settings::from_env()))
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
    }
}
