from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, Uuid, event, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserNotificationPrefs(Base):
    """Per-user notification preferences (email reminders, daily digest, push,
    sound). One row per user, created on first read by the API.
    """

    __tablename__ = "user_notification_prefs"

    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    email_reminders: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    due_alerts: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    email_digest: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    push_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sound: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class PushSubscription(Base):
    """A browser Web Push subscription (VAPID), keyed to a user. Sending is done
    via app/services/push_service.py; dead endpoints are removed on 404/410.
    """

    __tablename__ = "push_subscriptions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class NotificationLog(Base):
    """Dedupe log for the notification loop: one row per (user, task, kind) so a
    due alert isn't re-sent every loop pass, and per (user, kind, day) for the
    daily digest.
    """

    __tablename__ = "notification_logs"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)  # due | digest
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# RLS: all three tables are user-scoped. after_create (create_all cannot emit
# policies), idempotent, PostgreSQL-only (no-op on SQLite).
def _enable_rls(target, connection, **kw):
    if connection.dialect.name != "postgresql":
        return
    connection.execute(text(
        "CREATE OR REPLACE FUNCTION rls_user_id() RETURNS UUID AS $$ "
        "SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID; "
        "$$ LANGUAGE SQL STABLE"
    ))
    connection.execute(text(f"ALTER TABLE {target.name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {target.name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {target.name}"))
    connection.execute(text(
        f"CREATE POLICY user_isolation ON {target.name} "
        f"USING (user_id = rls_user_id()) "
        f"WITH CHECK (user_id = rls_user_id())"
    ))


event.listen(UserNotificationPrefs.__table__, "after_create", _enable_rls)
event.listen(PushSubscription.__table__, "after_create", _enable_rls)
event.listen(NotificationLog.__table__, "after_create", _enable_rls)
