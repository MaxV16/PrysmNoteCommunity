"""Personal Access Token (PAT) model for the MCP server.

Only the SHA-256 hash of a token is stored at rest; the plaintext is shown to
the user exactly once at creation. Tokens carry a short public ``prefix`` so the
settings UI can identify a token without exposing it. Tokens are revocable.

RLS is provisioned with a dialect-guarded (no-op on SQLite) ``after_create``
listener, matching the policy defined in ``docker/db/init.sql``.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Uuid, event, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ApiToken(Base):
    __tablename__ = "api_tokens"
    __table_args__ = (
        Index("ix_api_tokens_hash", "token_hash", unique=True),
        Index("ix_api_tokens_user_revoked", "user_id", "revoked_at"),
    )

    id: Mapped[str] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    prefix: Mapped[str] = mapped_column(String(12), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


def _enable_api_token_rls(target, connection, **kw):
    if connection.dialect.name != "postgresql":
        return
    connection.execute(
        text(
            "CREATE OR REPLACE FUNCTION rls_user_id() RETURNS UUID AS $$ "
            "SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID; "
            "$$ LANGUAGE SQL STABLE"
        )
    )
    connection.execute(text(f"ALTER TABLE {target.name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {target.name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {target.name}"))
    connection.execute(
        text(
            f"CREATE POLICY user_isolation ON {target.name} "
            "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())"
        )
    )


event.listen(ApiToken.__table__, "after_create", _enable_api_token_rls)
