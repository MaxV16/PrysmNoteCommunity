from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TaskList(Base):
    """A user-scoped task collection.

    Every task belongs to at most one list (``tasks.list_id``, SET NULL on list
    deletion). Each user starts with a default "My Tasks" list (created lazily
    by ``task_service.default_list_id``); deleting any other list moves its
    tasks back to that default list. Lists are visible only to their owner
    (RLS ``user_isolation`` policy, same pattern as board_sections).
    """

    __tablename__ = "lists"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)