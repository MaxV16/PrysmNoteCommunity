import enum
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Enum, Index, func, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TaskLinkType(str, enum.Enum):
    DEPENDS_ON = "depends_on"
    RELATED = "related"
    BLOCKS = "blocks"
    DUPLICATES = "duplicates"


class TaskLink(Base):
    __tablename__ = "task_links"
    __table_args__ = (
        Index("ix_task_links_user", "user_id"),
        Index("ix_task_links_source", "source_task_id"),
        Index("ix_task_links_target", "target_task_id"),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source_task_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    target_task_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    link_type: Mapped[TaskLinkType] = mapped_column(Enum(TaskLinkType, name="task_link_type", values_callable=lambda x: [e.value for e in x]), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
