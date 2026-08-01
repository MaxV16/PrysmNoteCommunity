from datetime import datetime

from sqlalchemy import Uuid, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AiSession(Base):
    """Rolling summary / context memory per AI chat session.

    Stores a concise, evolving summary of the conversation's key facts (tasks
    created, dates, priorities, decisions, user preferences) so the agent can
    recall important details long after they fall outside the most recent N raw
    messages. The summary is injected into the prompt on each turn.
    """

    __tablename__ = "ai_sessions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
