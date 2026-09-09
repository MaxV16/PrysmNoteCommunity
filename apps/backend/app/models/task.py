import enum
from datetime import date, datetime, time

from sqlalchemy import Boolean, Date, DateTime, Integer, SmallInteger, String, Text, ForeignKey, Enum, func, Uuid, Index, Time
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class TaskStatus(str, enum.Enum):
    BACKLOG = "backlog"
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    CANCELLED = "cancelled"


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        Index("idx_tasks_user_start_date", "user_id", "start_date"),
        Index("idx_tasks_user_due_date", "user_id", "due_date"),
        Index("idx_tasks_user_status", "user_id", "status"),
        Index("idx_tasks_user_archived", "user_id", "is_archived"),
        Index("idx_tasks_parent", "parent_task_id"),
        Index("idx_tasks_user_created", "user_id", "created_at"),
        Index("ix_tasks_board_section", "user_id", "board_section_id", "board_order"),
        Index("idx_tasks_user_import_batch", "user_id", "import_batch_id"),
        Index("idx_tasks_user_deleted", "user_id", "deleted_at", postgresql_where=sa_text("deleted_at IS NOT NULL")),
        Index("ix_tasks_list", "list_id"),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_task_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    # Board placement: a non-NULL board_section_id pins the task to a free
    # section of a board, independent of its status. Status sections are
    # membership-by-status (board_section_id IS NULL + matching status).
    board_section_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("board_sections.id", ondelete="SET NULL"), nullable=True)
    board_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TaskStatus] = mapped_column(Enum(TaskStatus, name="task_status", values_callable=lambda x: [e.value for e in x]), default=TaskStatus.BACKLOG, nullable=False)
    priority: Mapped[int] = mapped_column(SmallInteger, default=2, nullable=False)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Naive HH:MM local times (no tz column): "at 2" -> "14:00". Used by the
    # AI to capture clock times and by the timeline to order same-day bars.
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    is_all_day: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    estimated_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recurrence_rule: Mapped[str | None] = mapped_column(Text, nullable=True)
    recurrence_end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    recurrence_last_expanded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Batch marker set only for rows created by POST /api/imports/tasks, so the
    # user can undo a whole import (the Undo endpoint deletes every task in the
    # batch, including descendants and later recurrence expansions).
    import_batch_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Soft-delete: a non-NULL deleted_at moves the task into the Trash view.
    # Rows are purged for real 14 days after being trashed by the background job
    # (and opportunistically when the trash is listed). Trashed tasks are
    # excluded from every normal task query via Task.deleted_at.is_(None).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Optional list membership: NULL means "no explicit list" (shown in All Tasks).
    # New tasks without a list are assigned the user's default "My Tasks" list.
    list_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("lists.id", ondelete="SET NULL"), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    user = relationship("User", back_populates="tasks")
    subtasks = relationship("Task", backref="parent_task", remote_side="Task.id")
    embedding = relationship("TaskEmbedding", back_populates="task", uselist=False, cascade="all, delete-orphan")
