from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, SmallInteger, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TimelineSection(Base):
    """Display-layer band across the timeline row.

    A timeline section is a naming, colorable strip between two percentage
    positions of the currently rendered day window (``start_pct`` to ``end_pct``
    of the viewport width, not of the whole canvas). It may carry a filter rule
    (``rule_kind`` + ``rule_value``): tasks matching the rule render inside the
    section, and dragging a task onto the section applies the rule to that task.
    Sections never mutate task state by themselves - they are display-only
    definitions persisted here.
    """

    __tablename__ = "timeline_sections"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Percentage of the rendered day window this band covers. start_pct is the
    # split point (>= 0), end_pct is the band's right edge (<= 100).
    start_pct: Mapped[int] = mapped_column(SmallInteger, default=50, nullable=False)
    end_pct: Mapped[int] = mapped_column(SmallInteger, default=100, nullable=False)
    # Filter rule: "list" | "tag" | "priority" | "status" | "all". Empty
    # rule_kind means the band is a plain name divider with no filtering.
    rule_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    rule_value: Mapped[str | None] = mapped_column(String(200), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)