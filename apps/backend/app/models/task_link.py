import enum
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Enum, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TaskLinkType(str, enum.Enum):
    DEPENDS_ON = "depends_on"
    RELATED = "related"
    BLOCKS = "blocks"
    DUPLICATES = "duplicates"


class TaskLink(Base):
    __tablename__ = "task_links"

    id: Mapped[str] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source_task_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    target_task_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    link_type: Mapped[TaskLinkType] = mapped_column(Enum(TaskLinkType, name="task_link_type", values_callable=lambda x: [e.value for e in x]), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
