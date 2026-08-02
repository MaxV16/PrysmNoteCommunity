from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Uuid, Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AiMemory(Base):
    """A discrete, cross-session durable memory fact the user wants the agent to
    recall (e.g. "User has an ITV/mechanic appointment Tue 2026-08-04 ~16:00 —
    needs to shower first").

    This is the "life memory" layer, distinct from the per-session rolling
    summary on ``AiSession``: memories persist across chats and are retrieved by
    top-k relevance (embedding similarity, fallback keyword) and injected into a
    compact prompt block. ``source_session_id`` links a memory back to the
    session it was extracted from, so deleting that session can purge them.
    """

    __tablename__ = "ai_memories"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(32), default="context", nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)
    source_session_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
