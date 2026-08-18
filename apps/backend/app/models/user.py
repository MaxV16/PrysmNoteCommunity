from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # SSO provider that created the account ("google" | "github"); None for
    # email/password accounts. OAuth users have password_hash=NULL so they can't
    # sign in with a password, but live in the same users table.
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Whether the account's email address has been confirmed. SSO accounts are
    # verified by their provider at creation; email/password accounts start
    # unverified and must confirm before signing in when the deployment enables
    # REQUIRE_EMAIL_VERIFICATION. Existing accounts are backfilled as verified.
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false", default=False)
    # Bumped on password reset; access/refresh tokens carry a matching claim so
    # all pre-reset sessions are invalidated at once.
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0", default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    api_keys = relationship("ApiKey", back_populates="user", cascade="all, delete-orphan")
    tasks = relationship("Task", back_populates="user", cascade="all, delete-orphan")
