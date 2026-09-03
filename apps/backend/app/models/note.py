from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Note(Base):
    """Server-synced note. Mirrors the client-side note shape (see
    apps/frontend/src/lib/notes.ts) so the app can sync across devices; the
    frontend keeps a localStorage cache for offline use."""

    __tablename__ = "notes"
    __table_args__ = (
        Index("idx_notes_user_import_batch", "user_id", "import_batch_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # Batch marker set only for sticky notes created by POST /api/imports/tasks,
    # so the Undo endpoint can remove the whole imported set together.
    import_batch_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    title: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    color: Mapped[str] = mapped_column(String(16), default="#fbbf24", nullable=False)
    x: Mapped[float] = mapped_column(Float, default=300, nullable=False)
    y: Mapped[float] = mapped_column(Float, default=200, nullable=False)
    width: Mapped[float] = mapped_column(Float, default=320, nullable=False)
    height: Mapped[float] = mapped_column(Float, default=240, nullable=False)
    minimized: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    open: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
