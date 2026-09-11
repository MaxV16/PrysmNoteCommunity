from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = ""
    db_password: str = ""
    # Optional separate connection for system/background jobs (recurring-task
    # expansion, calendar pull). Uses a BYPASSRLS non-superuser role so those
    # jobs can process all users' data while the request path (database_url)
    # stays under enforced row-level security. Falls back to database_url.
    system_database_url: str = ""
    jwt_secret_key: str = ""
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    encryption_key: str = ""
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3200,http://localhost:3200,https://prysmnote.com"
    # CSRF Origin/Referer allowlist for unsafe /api requests. Desktop app
    # (http://127.0.0.1:3200) and dev (localhost:3000, :8000) plus the
    # production origin. Comma-separated; validated like cors_origins.
    csrf_allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3200,http://localhost:3200,http://localhost:8000,https://prysmnote.com"
    # "development" (default) exposes /docs and permissive CSP; "production"
    # disables the schema endpoints and hardens headers.
    environment: str = "development"

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @field_validator("cors_origins", "csrf_allowed_origins")
    @classmethod
    def validate_cors_origins(cls, v: str) -> str:
        origins = v.split(",")
        for origin in origins:
            origin = origin.strip()
            if "*" in origin and origin != "*":
                raise ValueError("Wildcard in CORS origin must be standalone '*'")
            if origin != "*" and not origin.startswith(("http://", "https://")):
                raise ValueError(f"CORS origin must start with http:// or https://: {origin}")
        return v

    openai_api_key: str = ""
    gemini_api_key: str = ""
    deepseek_api_key: str = ""
    openrouter_api_key: str = ""
    # TMDB API v3 key (user-supplied, free at tmdb.org). Powers the Shows &
    # Movies watchlist: title/posters/upcoming-continuation search and watch
    # providers. When empty, the watchlist degrades to manual entries only.
    tmdb_api_key: str = ""

    # Cap on the number of rows a single POST /api/imports/tasks request may
    # insert. Larger files must be split and imported in parts (the 409/400
    # message says so). Keeps one import from swamping the single-worker VM.
    import_max_rows: int = 5000

    # Deprecated single-model override for PrysmAI (EU / banned-region accounts).
    # Kept for back-compat: when set, it pins the EU GDPR-compliant chain to
    # that one model (no fallbacks). Empty = use prysm_ai_eu_chain.
    prysm_ai_region_model: str = ""

    # Base URL for the PrysmAI provider's OpenAI-compatible endpoint. Defaults to
    # OpenRouter; override for testing or a future proxy.
    prysm_ai_base_url: str = "https://openrouter.ai/api/v1"
    # EU / DeepSeek-blocklisted-region model chain (comma-separated, most
    # preferred first). Serves the EU/EEA, the UK, any country on
    # prysm_ai_deepseek_blocked_countries, and unknown/missing cf-ipcountry
    # headers (fail-safe compliant). GDPR-safe by construction: free ZDR models
    # first, then a paid ZDR floor that is fully capable of PrysmNote's toolset
    # and not Chinese-origin. Never contains DeepSeek.
    prysm_ai_eu_chain: str = (
        "thinkingmachines/inkling:free,google/gemma-4-31b-it:free,mistralai/mistral-small-3.2-24b-instruct"
    )
    # DeepSeek chain (serves every country NOT on the blocklist and NOT
    # restricted). Free ZDR models first, then DeepSeek as the paid overflow
    # floor. The USD cap prices on this floor, keeping allowances economical.
    prysm_ai_deepseek_chain: str = (
        "thinkingmachines/inkling:free,google/gemma-4-31b-it:free,deepseek/deepseek-v4-flash-0731"
    )
    # Comma-separated ISO alpha-2 countries where the DeepSeek chain must NOT
    # serve (EU/EEA-30 + UK by default - mirrors DeepSeek's own restrictions;
    # extend per policy). This is a BLOCKLIST, never an allowlist: empty =
    # DeepSeek everywhere except RESTRICTED countries. Unknown/missing headers
    # are NOT blocked here - they get the EU chain (compliant fail-safe).
    prysm_ai_deepseek_blocked_countries: str = (
        "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,IS,LI,NO,GB"
    )
    # Comma-separated ISO alpha-2 countries that are DENIED hosted PrysmAI with
    # HTTP 403 (no model call, no usage recorded). Russia/Belarus by default;
    # extend per policy (e.g. Cuba, Iran, North Korea, Syria, Crimea/UA-43).
    prysm_ai_restricted_countries: str = "RU,BY"
    # Force Zero-Data-Retention routing: send provider.data_collection="deny" on
    # every PrysmAI model request so no prompt/completion is stored or trained on.
    prysm_ai_zdr: bool = True
    # Safety buffer applied to per-user USD sub-key limits: the limit is computed
    # from the token allowance x blended per-token price, then multiplied by this
    # factor so a slightly more-expensive model / price shift cannot starve a
    # paying user mid-month. 1.0 = the USD cap IS the 40%-of-price worst-case
    # budget exactly (a higher buffer would let a user overspend the budget and
    # collapse the 60% margin).
    prysm_ai_key_limit_buffer: float = 1.0

    # Cloudflare Turnstile on the registration form. Both must be set for the
    # captcha to be enforced; when TURNSTILE_SECRET_KEY is empty the backend
    # skips verification (fail-open, so dev/tests and the community build are
    # unaffected).
    turnstile_secret_key: str = ""

    google_client_id: str = ""
    google_client_secret: str = ""

    github_client_id: str = ""
    github_client_secret: str = ""
    github_redirect_uri: str = "http://localhost:3000/settings"
    oauth_redirect_uri: str = "http://localhost:3000/api/auth/oauth/google/callback"
    # Where the Google Calendar OAuth popup returns after consent. MUST match
    # the redirect URI registered in the Google Cloud Console for the OAuth
    # client. Never accept a client-supplied value for this (M8).
    calendar_redirect_uri: str = ""
    app_origin: str = "http://localhost:3000"



    # Google Calendar background pull cadence (seconds) and how many users'
    # pulls may run concurrently in the background loop (each pull runs off the
    # event loop via to_thread, so a single worker stays responsive).
    gcal_pull_interval: int = 900
    gcal_pull_concurrency: int = 3
    # Rate guard on the manual POST /api/calendar/pull endpoint per user.
    calendar_manual_sync_min_interval: int = 60
    # Skip recurring templates whose last background expansion is newer than
    # this many hours (one pass per template per window instead of every hour).
    recurring_expand_cooldown_hours: int = 12

    redis_url: str = ""

    # Double-submit CSRF protection on unsafe /api requests (see
    # app/middleware/csrf.py). The frontend sends X-CSRF-Token on POST/PUT/PATCH/
    # DELETE. Tests and local tooling disable it explicitly when they exercise
    # the raw API without the header.
    csrf_enabled: bool = True

    # Global per-IP /api rate limit (app/middleware/ratelimit.py). Generous by
    # default; disabled in tests via a conftest fixture like csrf_enabled.
    api_rate_limit_enabled: bool = True
    api_rate_limit_per_min: int = 120

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    admin_email: str = ""
    notify_email: str = ""  # From address for automated notification emails (fallback: admin_email)

    # When enabled, email/password accounts must confirm their address via the
    # emailed verification link before they can sign in. SSO accounts (Google /
    # GitHub) are always treated as verified because the provider verifies the
    # email. Turn this on only when a working mailer is configured.
    require_email_verification: bool = False

    # Preferred transport: when set, the core mailer sends via the Brevo REST API
    # (port 443) instead of SMTP - reliable from the prod VM, whose network
    # blocks/flakes SMTP ports. API keys start with xkeysib-.
    brevo_api_key: str = ""

    # Notifications engine (email reminders, daily digest, browser Web Push).
    # NOTIFICATIONS_ENABLED turns the background loop on; VAPID keys power push
    # (generate once with `npx web-push generate-vapid-keys`). When unset, the
    # loop is a safe no-op and push/reminder endpoints still work for prefs.
    notifications_enabled: bool = False
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:support@prysmnote.com"
    notification_loop_interval: int = 1800  # seconds between due-alert passes
    digest_hour: int = 7  # local hour the daily digest email is sent

    # First-party product analytics: raw events are aggregated into
    # analytics_daily and pruned after this many days (aggregates are kept
    # forever). Internal analysis reads through the BYPASSRLS system role.
    analytics_retention_days: int = 90
    analytics_flush_interval: int = 5  # seconds between queue drains
    analytics_rollup_interval: int = 3600  # seconds between rollup passes

    # Trusted-proxy handling. When running behind Cloudflare/nginx (production),
    # uvicorn must be started with --proxy-headers and this forwarded-allow-ips
    # list so X-Forwarded-Proto/For are honored for secure cookies + client-IP.
    # The prod Dockerfile passes it on the uvicorn command line; kept here too so
    # the value is discoverable/configurable from a single place.
    forwarded_allow_ips: str = "*"

    # Deployed commit SHA, injected by the deploy workflows into the VM env
    # files (GIT_SHA=<sha>). Exposed via /api/health so the frontend can compare
    # it against its baked NEXT_PUBLIC_GIT_SHA and show the update banner.
    git_sha: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}

    @field_validator("jwt_secret_key", "encryption_key")
    @classmethod
    def validate_secrets(cls, v: str, info: ValidationInfo) -> str:
        placeholders = ["change-me", "CHANGE_ME", "placeholder", "your-secret"]
        if any(p in v.lower() for p in placeholders):
            raise ValueError(f"{info.field_name} contains a placeholder value. Set a real secret in .env")
        if not v or len(v) < 32:
            raise ValueError(f"{info.field_name} must be at least 32 characters")
        return v

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        if not v.startswith("postgresql"):
            raise ValueError("DATABASE_URL must start with postgresql")
        return v


settings = Settings()