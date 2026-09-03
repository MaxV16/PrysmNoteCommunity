from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text, UniqueConstraint, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class WatchlistItem(Base):
    """A movie or TV show the user is tracking in the Shows & Movies workspace.

    ``tmdb_id`` + ``media_type`` come from TMDB (or are synthesized for manual
    entries). ``upcoming_json`` holds the computed list of upcoming continuations
    (next season airing, next franchise installment) - refreshed on a 6h
    background cadence. ``providers_json`` caches the watch-provider map for the
    last requested region so the UI never refetches on every card expansion.
    """

    __tablename__ = "watchlist_items"
    __table_args__ = (
        UniqueConstraint("user_id", "tmdb_id", name="uq_watchlist_items_user_tmdb"),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tmdb_id: Mapped[int] = mapped_column(Integer, nullable=False)
    media_type: Mapped[str] = mapped_column(String(8), nullable=False)  # "movie" | "tv"
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    poster_path: Mapped[str | None] = mapped_column(String(500), nullable=True)  # path only; render via TMDB image CDN
    release_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="plan_to_watch", nullable=False)  # plan_to_watch | watching | watched
    is_theatrical: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    rating: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)  # 1-10
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    watched_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    upcoming_json: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)
    providers_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    metadata_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
