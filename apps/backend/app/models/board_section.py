from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class BoardSection(Base):
    """Board section (column/group) definition.

    Kanban boards mix **status-bound** sections (``status`` set; membership is
    ``task.status == section.status AND task.board_section_id IS NULL``) with
    **free** custom sections (``status`` NULL; membership is ``task.board_section_id
    == section.id``, pinning the task independent of its status). The board
    scrapbook uses free sections only; cards with ``board_section_id IS NULL``
    appear in an implicit "Unsorted" area.

    The ``(user_id, kind, status)`` unique constraint keeps exactly one section
    per status per board; free sections (status NULL) never conflict (PostgreSQL
    treats NULLs as distinct in unique constraints).
    """

    __tablename__ = "board_sections"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", "status", name="uq_board_sections_user_kind_status"),
        Index("ix_board_sections_list", "list_id"),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # NULL = the section belongs to the workspace-wide scope (kanban/board), or
    # to no list in particular. Non-NULL = the section is scoped to one task
    # list, so a new list starts with no sections of its own.
    list_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("lists.id", ondelete="CASCADE"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # "kanban" | "board" | "timeline"
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)  # NULL = free section
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
