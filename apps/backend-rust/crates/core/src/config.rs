use std::env;

/// Runtime configuration, read from the same environment variables as the
/// Python backend so the two can run side by side during the port.
#[derive(Clone, Debug)]
pub struct Settings {
    pub database_url: String,
    pub jwt_secret_key: String,
    pub encryption_key: String,
    pub port: u16,
    pub git_sha: Option<String>,
    pub environment: String,
    pub app_origin: String,
    pub webauthn_rp_id: String,
    pub webauthn_rp_name: String,
    pub webauthn_origins: String,
    pub oauth_redirect_uri: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub github_client_id: String,
    pub github_client_secret: String,
    pub redis_url: String,
    pub csrf_enabled: bool,
    pub csrf_allowed_origins: String,
    pub api_rate_limit_enabled: bool,
    pub api_rate_limit_per_min: u32,
    pub cors_origins: String,
    /// Notifications engine master switch (background loop no-op when false).
    pub notifications_enabled: bool,
    /// VAPID PEM private key powering Web Push (`VAPID_PRIVATE_KEY`).
    pub vapid_private_key: String,
    /// VAPID JWT subject claim (`VAPID_SUBJECT`), a mailto: or https: URL.
    pub vapid_subject: String,
    /// From address for automated notification emails (`NOTIFY_EMAIL`).
    pub notify_email: String,
    /// Seconds between due-alert background passes (`NOTIFICATION_LOOP_INTERVAL`).
    pub notification_loop_interval: u64,
    /// Local hour the daily digest email is sent (`DIGEST_HOUR`).
    pub digest_hour: u32,
}

impl Settings {
    pub fn from_env() -> Self {
        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://prysm:prysm@localhost:5432/prysm_note".to_string());
        let jwt_secret_key = env::var("JWT_SECRET_KEY").unwrap_or_default();
        let encryption_key = env::var("ENCRYPTION_KEY").unwrap_or_default();
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8000);
        let git_sha = env::var("GIT_SHA").ok().filter(|s| !s.is_empty());
        let environment = env::var("ENVIRONMENT").unwrap_or_else(|_| "development".to_string());
        let app_origin =
            env::var("APP_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".to_string());
        let webauthn_rp_id = env::var("WEBAUTHN_RP_ID").unwrap_or_default();
        let webauthn_rp_name =
            env::var("WEBAUTHN_RP_NAME").unwrap_or_else(|_| "Prysm Note".to_string());
        let webauthn_origins = env::var("WEBAUTHN_ORIGINS").unwrap_or_default();
        let oauth_redirect_uri = env::var("OAUTH_REDIRECT_URI").unwrap_or_else(|_| {
            "http://localhost:3000/api/auth/oauth/google/callback".to_string()
        });
        let google_client_id = env::var("GOOGLE_CLIENT_ID").unwrap_or_default();
        let google_client_secret = env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default();
        let github_client_id = env::var("GITHUB_CLIENT_ID").unwrap_or_default();
        let github_client_secret = env::var("GITHUB_CLIENT_SECRET").unwrap_or_default();
        let redis_url = env::var("REDIS_URL").unwrap_or_default();
        let csrf_enabled = env_bool("CSRF_ENABLED", true);
        let csrf_allowed_origins = env::var("CSRF_ALLOWED_ORIGINS").unwrap_or_else(|_| {
            "http://localhost:3000,http://127.0.0.1:3200,http://localhost:3200,http://localhost:8000,https://prysmnote.com"
                .to_string()
        });
        let api_rate_limit_enabled = env_bool("API_RATE_LIMIT_ENABLED", true);
        let api_rate_limit_per_min = env::var("API_RATE_LIMIT_PER_MIN")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(120);
        let cors_origins =
            env::var("CORS_ORIGINS").unwrap_or_else(|_| "http://localhost:3000".to_string());
        let notifications_enabled = env_bool("NOTIFICATIONS_ENABLED", false);
        let vapid_private_key = env::var("VAPID_PRIVATE_KEY").unwrap_or_default();
        let vapid_subject = env::var("VAPID_SUBJECT")
            .unwrap_or_else(|_| "mailto:support@prysmnote.com".to_string());
        let notify_email = env::var("NOTIFY_EMAIL").unwrap_or_default();
        let notification_loop_interval = env_u64("NOTIFICATION_LOOP_INTERVAL", 1800);
        let digest_hour = env_u32("DIGEST_HOUR", 7);

        Settings {
            database_url,
            jwt_secret_key,
            encryption_key,
            port,
            git_sha,
            environment,
            app_origin,
            webauthn_rp_id,
            webauthn_rp_name,
            webauthn_origins,
            oauth_redirect_uri,
            google_client_id,
            google_client_secret,
            github_client_id,
            github_client_secret,
            redis_url,
            csrf_enabled,
            csrf_allowed_origins,
            api_rate_limit_enabled,
            api_rate_limit_per_min,
            cors_origins,
            notifications_enabled,
            vapid_private_key,
            vapid_subject,
            notify_email,
            notification_loop_interval,
            digest_hour,
        }
    }

    pub fn is_production(&self) -> bool {
        self.environment.eq_ignore_ascii_case("production")
    }

    /// The BYPASSRLS connection string for the cross-user background loops
    /// (`SYSTEM_DATABASE_URL`). Read from the environment at call time so it
    /// stays out of the settings struct and its many test literals; when unset
    /// or empty it falls back to `database_url`, matching Python
    /// `system_database_url or database_url` so unconfigured environments (dev,
    /// CI) keep working on the app role.
    pub fn system_database_url(&self) -> String {
        match env::var("SYSTEM_DATABASE_URL") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => self.database_url.clone(),
        }
    }

    /// The VAPID public key served to browsers for web-push subscription.
    /// Read from the environment at call time so it stays out of the settings
    /// struct and its many test literals.
    pub fn vapid_public_key(&self) -> String {
        std::env::var("VAPID_PUBLIC_KEY").unwrap_or_default()
    }

    /// Server-side Google OAuth redirect for the calendar integration
    /// (`CALENDAR_REDIRECT_URI`). Empty falls back to `{app_origin}/settings`
    /// in the router. Read at call time to keep it out of the test literals.
    pub fn calendar_redirect_uri(&self) -> String {
        env::var("CALENDAR_REDIRECT_URI").unwrap_or_default()
    }

    /// Seconds between Google Calendar pull passes for a user without a
    /// per-user interval (`GCAL_PULL_INTERVAL`, Python default 900).
    pub fn gcal_pull_interval(&self) -> u64 {
        env_u64("GCAL_PULL_INTERVAL", 900)
    }

    /// OAuth redirect URI for the GitHub integration (empty when unset).
    pub fn github_redirect_uri(&self) -> String {
        env::var("GITHUB_REDIRECT_URI").unwrap_or_default()
    }

    /// Maximum concurrent per-user calendar pulls (`GCAL_PULL_CONCURRENCY`,
    /// Python default 3).
    pub fn gcal_pull_concurrency(&self) -> usize {
        env::var("GCAL_PULL_CONCURRENCY").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(3)
    }

    /// Minimum seconds between manual calendar pulls for one user
    /// (`CALENDAR_MANUAL_SYNC_MIN_INTERVAL`, Python default 60).
    pub fn calendar_manual_sync_min_interval(&self) -> u64 {
        env_u64("CALENDAR_MANUAL_SYNC_MIN_INTERVAL", 60)
    }

    /// The TMDB API v3 key for the Shows & Movies watchlist. Read from the
    /// environment at call time so it stays out of the settings struct and its
    /// many test literals. An empty key disables all TMDB calls (the watchlist
    /// degrades to manual entries).
    pub fn tmdb_api_key(&self) -> String {
        std::env::var("TMDB_API_KEY").unwrap_or_default()
    }

    /// The WebAuthn relying-party id. Explicit `WEBAUTHN_RP_ID` wins; otherwise
    /// it is derived from the app origin hostname (localhost stays "localhost",
    /// anything else is reduced to its registrable last two labels).
    pub fn resolved_webauthn_rp_id(&self) -> String {
        if !self.webauthn_rp_id.is_empty() {
            return self.webauthn_rp_id.clone();
        }
        let host = origin_host(&self.app_origin).unwrap_or_else(|| "localhost".to_string());
        if host == "localhost" || host == "127.0.0.1" || host == "::1" {
            return "localhost".to_string();
        }
        let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
        if labels.len() <= 2 {
            host
        } else {
            labels[labels.len() - 2..].join(".")
        }
    }

    /// Allowed WebAuthn origins. Explicit `WEBAUTHN_ORIGINS` is a comma list;
    /// otherwise the single app origin is used. Trailing slashes are stripped.
    pub fn resolved_webauthn_origins(&self) -> Vec<String> {
        if !self.webauthn_origins.is_empty() {
            return self
                .webauthn_origins
                .split(',')
                .map(|o| o.trim().trim_end_matches('/').to_string())
                .filter(|o| !o.is_empty())
                .collect();
        }
        vec![self.app_origin.trim_end_matches('/').to_string()]
    }

    /// First-party analytics: raw event retention in days. Read from the
    /// environment at call time so it stays out of the settings struct and its
    /// many test literals.
    pub fn analytics_retention_days(&self) -> i64 {
        env_i64("ANALYTICS_RETENTION_DAYS", 30)
    }

    /// First-party analytics: anonymous (no user) raw event retention in days.
    pub fn analytics_anon_retention_days(&self) -> i64 {
        env_i64("ANALYTICS_ANON_RETENTION_DAYS", 7)
    }

    /// Premium AI usage retention in days (`AI_USAGE_RETENTION_DAYS`, Python
    /// default 400). Read from the environment at call time so it stays out of
    /// the settings struct and its many test literals.
    pub fn ai_usage_retention_days(&self) -> i64 {
        env_u64("AI_USAGE_RETENTION_DAYS", 400) as i64
    }

    /// First-party analytics: max seconds an idle queue waits before a flush.
    pub fn analytics_flush_interval(&self) -> u64 {
        env_u64("ANALYTICS_FLUSH_INTERVAL", 5)
    }

    /// First-party analytics: seconds between rollup passes.
    pub fn analytics_rollup_interval(&self) -> u64 {
        env_u64("ANALYTICS_ROLLUP_INTERVAL", 3600)
    }

    /// Max rows accepted by a single task import. Read from the environment at
    /// call time so it stays out of the settings struct and its test literals.
    pub fn import_max_rows(&self) -> i64 {
        env_i64("IMPORT_MAX_ROWS", 5000)
    }

    /// Hours a recurring template waits between background expansions. Read from
    /// the environment at call time so it stays out of the settings struct.
    pub fn recurring_expand_cooldown_hours(&self) -> i64 {
        env_i64("RECURRING_EXPAND_COOLDOWN_HOURS", 12)
    }

    /// Seconds between recurring background sweep passes.
    pub fn recurring_expand_interval_seconds(&self) -> u64 {
        env_u64("RECURRING_EXPAND_INTERVAL_SECONDS", 3600)
    }

    /// Whether this process may run the shared background loops at all.
    /// `PRYSM_RUN_BACKGROUND_LOOPS=false` (documented ops switch) disables the
    /// loops everywhere; otherwise they run and multi-worker leadership decides
    /// which single worker actually executes them.
    pub fn run_background_loops(&self) -> bool {
        if let Ok(v) = env::var("PRYSM_RUN_BACKGROUND_LOOPS") {
            let v = v.trim().to_ascii_lowercase();
            return !(v == "false" || v == "0" || v == "no" || v == "off");
        }
        env_bool("RUN_BACKGROUND_LOOPS", true)
    }

    /// Base URL of the hosted PrysmAI gateway. Read from the environment at call
    /// time so it stays out of the settings struct and its many test literals.
    pub fn prysm_ai_base_url(&self) -> String {
        env::var("PRYSM_AI_BASE_URL").unwrap_or_else(|_| "https://openrouter.ai/api/v1".to_string())
    }

    /// Default hosted model for the current region, when set.
    pub fn prysm_ai_region_model(&self) -> String {
        env::var("PRYSM_AI_REGION_MODEL").unwrap_or_default()
    }

    /// Whether hosted requests ask the gateway to deny data collection.
    pub fn prysm_ai_zdr(&self) -> bool {
        env_bool("PRYSM_AI_ZDR", true)
    }

    /// EU / DeepSeek-blocklisted-region model chain (most preferred first).
    ///
    /// DeepSeek is blocked for EU/EEA/UK countries, so this chain uses the
    /// tool-capable non-DeepSeek model only. No `:free` models anywhere.
    pub fn prysm_ai_eu_chain(&self) -> String {
        env::var("PRYSM_AI_EU_CHAIN")
            .unwrap_or_else(|_| crate::llm::PRYSMAI_EU_MODEL.to_string())
    }

    /// DeepSeek model chain for non-blocklisted, non-restricted countries:
    /// the tool-capable DeepSeek primary, then the compliant EU model as the
    /// fallback. No `:free` models anywhere.
    pub fn prysm_ai_deepseek_chain(&self) -> String {
        env::var("PRYSM_AI_DEEPSEEK_CHAIN").unwrap_or_else(|_| {
            format!(
                "{},{}",
                crate::llm::PRYSMAI_MODEL,
                crate::llm::PRYSMAI_EU_MODEL
            )
        })
    }

    /// Countries where the DeepSeek chain must not serve (EU/EEA + UK default).
    pub fn prysm_ai_deepseek_blocked_countries(&self) -> String {
        env::var("PRYSM_AI_DEEPSEEK_BLOCKED_COUNTRIES").unwrap_or_else(|_| {
            "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,IS,LI,NO,GB"
                .to_string()
        })
    }

    /// Countries denied hosted PrysmAI entirely (HTTP 403, no model call).
    pub fn prysm_ai_restricted_countries(&self) -> String {
        env::var("PRYSM_AI_RESTRICTED_COUNTRIES").unwrap_or_else(|_| "RU,BY".to_string())
    }

    /// Brevo REST API key; when set the mailer uses Brevo instead of SMTP.
    pub fn brevo_api_key(&self) -> String {
        env::var("BREVO_API_KEY").unwrap_or_default()
    }

    /// Public sender address (also the SMTP From); empty disables email.
    pub fn admin_email(&self) -> String {
        env::var("ADMIN_EMAIL").unwrap_or_default()
    }

    /// Classic SMTP relay host (used only when Brevo is not configured).
    pub fn smtp_host(&self) -> String {
        env::var("SMTP_HOST").unwrap_or_default()
    }

    /// SMTP port (defaults to 587 STARTTLS; 465 selects implicit TLS).
    pub fn smtp_port(&self) -> u16 {
        env::var("SMTP_PORT").ok().and_then(|v| v.trim().parse::<u16>().ok()).unwrap_or(587)
    }

    /// SMTP login (Brevo per-account login or a mailbox address).
    pub fn smtp_user(&self) -> String {
        env::var("SMTP_USER").unwrap_or_default()
    }

    /// SMTP password / API key value.
    pub fn smtp_password(&self) -> String {
        env::var("SMTP_PASSWORD").unwrap_or_default()
    }

    /// When true, registration does not log the user in until they confirm
    /// their email via the verification link.
    pub fn require_email_verification(&self) -> bool {
        env_bool("REQUIRE_EMAIL_VERIFICATION", false)
    }

    /// Cloudflare Turnstile secret. Blank disables the registration check
    /// (fail-open), keeping dev/tests and the community build simple.
    pub fn turnstile_secret_key(&self) -> String {
        env::var("TURNSTILE_SECRET_KEY").unwrap_or_default()
    }

    /// Days of inactivity before a warning email is sent. Read at call time so
    /// it stays out of the settings struct and its many test literals.
    pub fn inactivity_warning_days(&self) -> i64 {
        env_i64("INACTIVITY_WARNING_DAYS", 365)
    }

    /// Days after the warning before an account is deleted, if it is still
    /// inactive. Read at call time.
    pub fn inactivity_grace_days(&self) -> i64 {
        env_i64("INACTIVITY_GRACE_DAYS", 30)
    }

    /// Whether the inactivity lifecycle runs at all. Defaults on in production
    /// and off elsewhere, so dev/CI never delete seeded accounts. An explicit
    /// `ACCOUNT_INACTIVITY_ENABLED` overrides the default.
    pub fn account_inactivity_enabled(&self) -> bool {
        match env::var("ACCOUNT_INACTIVITY_ENABLED") {
            Ok(v) if !v.trim().is_empty() => env_bool("ACCOUNT_INACTIVITY_ENABLED", false),
            _ => self.is_production(),
        }
    }

    /// Minimum seconds between per-request `last_active_at` writes for one user
    /// (`ACTIVITY_TOUCH_INTERVAL_SECONDS`, default one hour).
    pub fn activity_touch_interval_seconds(&self) -> u64 {
        env_u64("ACTIVITY_TOUCH_INTERVAL_SECONDS", 3600)
    }
}

fn origin_host(origin: &str) -> Option<String> {
    url::Url::parse(origin).ok().and_then(|u| u.host_str().map(|h| h.to_string()))
}

/// Parse a boolean env var, treating the same values as disabled that the Python
/// config does (`false`, `0`). Absent or unparseable falls back to `default`.
fn env_bool(name: &str, default: bool) -> bool {
    match env::var(name) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v == "false" || v == "0" || v == "no" || v == "off")
        }
        Err(_) => default,
    }
}

/// Parse a signed integer env var. Absent or unparseable falls back to `default`.
fn env_i64(name: &str, default: i64) -> i64 {
    env::var(name).ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(default)
}

/// Parse an unsigned integer env var. Absent or unparseable falls back to `default`.
fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name).ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(default)
}

/// Parse an unsigned 32-bit integer env var. Absent or unparseable falls back to
/// `default`.
fn env_u32(name: &str, default: u32) -> u32 {
    env::var(name).ok().and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(default)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::Settings;

    pub(crate) fn sample(environment: &str) -> Settings {
        Settings {
            database_url: "postgresql://x".into(),
            jwt_secret_key: "s".repeat(32),
            encryption_key: "k".into(),
            port: 8000,
            git_sha: None,
            environment: environment.into(),
            app_origin: "https://prysmnote.com".into(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".into(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: "https://prysmnote.com/api/auth/oauth/google/callback".into(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: true,
            csrf_allowed_origins: "https://prysmnote.com".into(),
            api_rate_limit_enabled: true,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".into(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: "mailto:support@prysmnote.com".into(),
            notify_email: String::new(),
            notification_loop_interval: 1800,
            digest_hour: 7,
        }
    }

    #[test]
    fn production_flag_is_case_insensitive() {
        assert!(sample("production").is_production());
        assert!(sample("Production").is_production());
        assert!(!sample("development").is_production());
    }

    #[test]
    fn system_database_url_falls_back_to_database_url() {
        std::env::remove_var("SYSTEM_DATABASE_URL");
        let settings = sample("development");
        assert_eq!(settings.system_database_url(), settings.database_url);
    }

    #[test]
    fn rp_id_derives_registrable_domain() {
        assert_eq!(sample("production").resolved_webauthn_rp_id(), "prysmnote.com");
        let mut local = sample("development");
        local.app_origin = "http://localhost:3000".into();
        assert_eq!(local.resolved_webauthn_rp_id(), "localhost");
    }

    #[test]
    fn rp_id_and_origins_respect_explicit_values() {
        let mut s = sample("production");
        s.webauthn_rp_id = "example.org".into();
        s.webauthn_origins = "https://example.org/, https://app.example.org".into();
        assert_eq!(s.resolved_webauthn_rp_id(), "example.org");
        assert_eq!(
            s.resolved_webauthn_origins(),
            vec!["https://example.org", "https://app.example.org"]
        );
        assert_eq!(
            sample("production").resolved_webauthn_origins(),
            vec!["https://prysmnote.com"]
        );
    }

    /// Every hosted chain entry must be a tool-capable model and never a
    /// `:free` variant (which cannot reliably call tools/MCP).
    #[test]
    fn hosted_chains_are_tool_capable_without_free_models() {
        let s = sample("production");
        for chain in [s.prysm_ai_eu_chain(), s.prysm_ai_deepseek_chain()] {
            assert!(!chain.contains(":free"), "no :free models allowed: {chain}");
            for model in chain.split(',').map(str::trim).filter(|m| !m.is_empty()) {
                assert!(
                    crate::llm::hosted_model_is_tool_capable(model),
                    "hosted model {model} is not on the tool-capable allow-list"
                );
            }
        }
        assert!(s.prysm_ai_eu_chain().contains(crate::llm::PRYSMAI_EU_MODEL));
        assert!(s
            .prysm_ai_deepseek_chain()
            .starts_with(crate::llm::PRYSMAI_MODEL));
    }

    #[test]
    fn inactivity_defaults_are_production_only() {
        std::env::remove_var("ACCOUNT_INACTIVITY_ENABLED");
        assert!(!sample("development").account_inactivity_enabled());
        assert!(sample("production").account_inactivity_enabled());
        assert_eq!(sample("production").inactivity_warning_days(), 365);
        assert_eq!(sample("production").inactivity_grace_days(), 30);
    }
}
