"""Per-user LLM token usage tracking (core).

Append-only rows (one per provider call) so monthly allowances can be summed.
Keyed on ``user_id`` with the same RLS policy used across the schema, so a user
can only ever see/own their own usage. Used to enforce the PrysmAI (hosted) token
allowance on paid plans and the 14-day trial.
"""
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Uuid, event, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AiUsage(Base):
    __tablename__ = "ai_usage"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    # Calendar month (YYYY-MM-01) this usage belongs to, for allowance sums.
    month: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cached_input_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _enable_ai_usage_rls(target, connection, **kw):
    if connection.dialect.name != "postgresql":
        return
    connection.execute(text(f"ALTER TABLE {target.name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {target.name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {target.name}"))
    connection.execute(text(
        f"CREATE POLICY user_isolation ON {target.name} "
        f"USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())"
    ))


event.listen(AiUsage.__table__, "after_create", _enable_ai_usage_rls)
