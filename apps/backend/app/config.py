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
    cors_origins: str = "http://localhost:3000"
    # "development" (default) exposes /docs and permissive CSP; "production"
    # disables the schema endpoints and hardens headers.
    environment: str = "development"

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @field_validator("cors_origins")
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

    google_client_id: str = ""
    google_client_secret: str = ""

    github_client_id: str = ""
    github_client_secret: str = ""
    github_redirect_uri: str = "http://localhost:3000/settings"
    oauth_redirect_uri: str = "http://localhost:3000/api/auth/oauth/google/callback"
    app_origin: str = "http://localhost:3000"

    gocardless_secret_id: str = ""
    gocardless_secret_key: str = ""
    gocardless_endpoint: str = ""

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

    # Preferred transport: when set, the core mailer sends via the Brevo REST API
    # (port 443) instead of SMTP — reliable from the prod VM, whose network
    # blocks/flakes SMTP ports. API keys start with xkeysib-.
    brevo_api_key: str = ""

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