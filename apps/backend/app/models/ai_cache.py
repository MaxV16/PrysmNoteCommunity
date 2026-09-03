"""LLM response cache (core).

Caches exact-match provider responses for the non-streaming tool rounds so a
repeat of an identical prompt (system + history + user message) never re-bills a
provider call. Safe because the cache key is the full serialized request: byte-
identical input yields the same deterministic tool decisions, so a hit within the
short TTL is indistinguishable from a fresh call. Stale-data risk is bounded by a
short TTL and by only caching tool-round decisions, never the final answer.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid, event, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AiCache(Base):
    __tablename__ = "ai_cache"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    response: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


def _enable_ai_cache_rls(target, connection, **kw):
    if connection.dialect.name != "postgresql":
        return
    connection.execute(text(f"ALTER TABLE {target.name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {target.name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {target.name}"))
    connection.execute(text(
        f"CREATE POLICY user_isolation ON {target.name} "
        f"USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())"
    ))


event.listen(AiCache.__table__, "after_create", _enable_ai_cache_rls)
