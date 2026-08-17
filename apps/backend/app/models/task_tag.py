from sqlalchemy import ForeignKey, PrimaryKeyConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TaskTag(Base):
    __tablename__ = "task_tags"

    task_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"))
    tag_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("tags.id", ondelete="CASCADE"))

    __table_args__ = (PrimaryKeyConstraint("task_id", "tag_id"),)
