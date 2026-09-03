"""First-party, cookieless product analytics (core).

Raw events carry the owning user (nullable: some events may be recorded before
auth or reference a deleted account) and are RLS-isolated exactly like the other
user-scoped tables. The aggregated ``analytics_daily`` rollup has no user id and
is not RLS'd; the background rollup loop reads the raw table through the
BYPASSRLS system role and writes the daily aggregate.

Retention: raw rows are pruned after ``settings.analytics_retention_days``
(default 90) by the hourly rollup loop; ``analytics_daily`` is kept forever.
"""
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    event,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# SQLite (test fallback) cannot autoincrement a plain BigInteger PK the way
# Postgres can; the with_variant keeps the DDL portable.
BigIntPK = BigInteger().with_variant(Integer, "sqlite")


class AnalyticsEvent(Base):
    """A single tracked product event. Written by the background flush loop
    (system session) so the request path never blocks on the DB."""

    __tablename__ = "analytics_events"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    event: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    properties: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


class AnalyticsDaily(Base):
    """Hourly aggregate of raw events (day, event). Kept forever; the raw rows
    that feed it are pruned after the retention window."""

    __tablename__ = "analytics_daily"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    event: Mapped[str] = mapped_column(String(64), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unique_users: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


# RLS on the raw events table (user-scoped). Aggregate analytics_daily has no
# user column and is deliberately unprotected. after_create + idempotent +
# PostgreSQL-only, mirroring the subscription.py pattern.
def _enable_events_rls(target, connection, **kw):
    if connection.dialect.name != "postgresql":
        return
    connection.execute(text(f"ALTER TABLE {target.name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {target.name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {target.name}"))
    connection.execute(text(
        f"CREATE POLICY user_isolation ON {target.name} "
        f"USING (user_id = rls_user_id()) "
        f"WITH CHECK (user_id = rls_user_id())"
    ))


event.listen(AnalyticsEvent.__table__, "after_create", _enable_events_rls)
