"""Add first-party analytics tables

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "analytics_events",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("event", sa.String(64), nullable=False, index=True),
        sa.Column("properties", JSONB(), nullable=False),
        sa.Column("session_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False, index=True),
    )
    op.create_table(
        "analytics_daily",
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("event", sa.String(64), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column("unique_users", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("day", "event"),
    )
    # Raw events are user-scoped: mirror the model's after_create RLS (the
    # create_all path provisions it, but migrated databases need it here).
    op.execute("""
        ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY
    """)
    op.execute("""
        ALTER TABLE analytics_events FORCE ROW LEVEL SECURITY
    """)
    op.execute("DROP POLICY IF EXISTS user_isolation ON analytics_events")
    op.execute("""
        CREATE POLICY user_isolation ON analytics_events
        USING (user_id = rls_user_id())
        WITH CHECK (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_table("analytics_daily")
    op.drop_table("analytics_events")
