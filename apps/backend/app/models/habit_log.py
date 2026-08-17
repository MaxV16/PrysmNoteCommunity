from datetime import datetime, date

from sqlalchemy import DateTime, Date, ForeignKey, func, Uuid, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class HabitLog(Base):
    __tablename__ = "habit_logs"
    __table_args__ = (
        Index("ix_habit_logs_habit_date", "habit_id", "completed_at"),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    habit_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("habits.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    completed_at: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    habit = relationship("Habit", back_populates="logs")
