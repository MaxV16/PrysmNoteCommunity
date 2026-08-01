from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = ""
    db_password: str = ""
    jwt_secret_key: str = ""
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    encryption_key: str = ""
    cors_origins: str = "http://localhost:3000"

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

    google_client_id: str = ""
    google_client_secret: str = ""

    redis_url: str = ""

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    admin_email: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

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