import enum
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Enum, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SyncAction(str, enum.Enum):
    PUSH = "push"
    PULL = "pull"
    CONFLICT = "conflict"


class CalendarEvent(Base):
    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    google_event_id: Mapped[str] = mapped_column(String(500), nullable=False)
    calendar_id: Mapped[str] = mapped_column(String(500), nullable=False)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    sync_action: Mapped[SyncAction] = mapped_column(Enum(SyncAction), default=SyncAction.PUSH, nullable=False)
