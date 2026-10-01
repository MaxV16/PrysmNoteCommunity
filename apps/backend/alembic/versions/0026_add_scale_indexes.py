"""Add scale indexes for hot per-user listing and join paths

Revision ID: 0026
Revises: 0025
Create Date: 2026-09-30

Adds composite/partial indexes that match the filters exercised on the request
path, and replaces two under-serving legacy indexes (provider-only tokens,
google_event_id-only calendar events) with user_id-leading composites. Names
mirror the model __table_args__ and schema_provisioning so a fresh create_all
DB, an alembic-upgraded DB and the provisioning pass all converge.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0026"
down_revision: Union[str, None] = "0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_tasks_user_active_created ON tasks (user_id, created_at) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS ix_tasks_due_date_active ON tasks (due_date) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS ix_financial_items_user_created ON financial_items (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_financial_transactions_user_date ON financial_transactions (user_id, date)",
    "CREATE INDEX IF NOT EXISTS ix_financial_transactions_item ON financial_transactions (item_id)",
    "CREATE INDEX IF NOT EXISTS ix_task_links_user ON task_links (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_task_links_source ON task_links (source_task_id)",
    "CREATE INDEX IF NOT EXISTS ix_task_links_target ON task_links (target_task_id)",
    "CREATE INDEX IF NOT EXISTS ix_task_shares_task ON task_shares (task_id)",
    "CREATE INDEX IF NOT EXISTS ix_task_shares_team ON task_shares (team_id)",
    "CREATE INDEX IF NOT EXISTS ix_team_members_user ON team_members (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_notification_logs_user_task_kind ON notification_logs (user_id, task_id, kind)",
    "CREATE INDEX IF NOT EXISTS ix_notification_logs_kind_sent ON notification_logs (kind, sent_at)",
    "CREATE INDEX IF NOT EXISTS ix_habits_user ON habits (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_push_subscriptions_user ON push_subscriptions (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_ai_usage_user_provider_month ON ai_usage (user_id, provider, month)",
    "CREATE INDEX IF NOT EXISTS ix_watchlist_items_user_created ON watchlist_items (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_notes_user_sort_updated ON notes (user_id, sort, updated_at)",
    "CREATE INDEX IF NOT EXISTS ix_lists_user ON lists (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_user_tokens_user_provider ON user_tokens (user_id, provider)",
    "CREATE INDEX IF NOT EXISTS ix_calendar_events_user_google_cal ON calendar_events (user_id, google_event_id, calendar_id)",
)

_LEGACY_INDEXES = (
    "ix_user_tokens_provider",
    "ix_calendar_events_user_google",
    "idx_user_tokens_provider",
    "idx_calendar_events_google",
    "idx_task_links_source",
    "idx_task_links_target",
    "idx_habits_user",
)


def upgrade() -> None:
    for stmt in _NEW_INDEXES:
        op.execute(stmt)
    for name in _LEGACY_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")


def downgrade() -> None:
    for name in (
        "ix_tasks_user_active_created",
        "ix_tasks_due_date_active",
        "ix_financial_items_user_created",
        "ix_financial_transactions_user_date",
        "ix_financial_transactions_item",
        "ix_task_links_user",
        "ix_task_links_source",
        "ix_task_links_target",
        "ix_task_shares_task",
        "ix_task_shares_team",
        "ix_team_members_user",
        "ix_notification_logs_user_task_kind",
        "ix_notification_logs_kind_sent",
        "ix_habits_user",
        "ix_push_subscriptions_user",
        "ix_ai_usage_user_provider_month",
        "ix_watchlist_items_user_created",
        "ix_notes_user_sort_updated",
        "ix_lists_user",
        "ix_user_tokens_user_provider",
        "ix_calendar_events_user_google_cal",
    ):
        op.execute(f"DROP INDEX IF EXISTS {name}")
    # Restore the legacy indexes that the composites replaced.
    op.execute("CREATE INDEX IF NOT EXISTS ix_user_tokens_provider ON user_tokens (provider)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_calendar_events_user_google "
        "ON calendar_events (user_id, google_event_id)"
    )
