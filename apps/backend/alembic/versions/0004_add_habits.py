"""Add habits and habit_logs tables

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-26

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "habits",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("frequency", sa.String(20), nullable=False, server_default="daily"),
        sa.Column("target_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("color", sa.String(7), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("idx_habits_user", "habits", ["user_id"])
    op.execute("ALTER TABLE habits ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON habits
          USING (user_id = rls_user_id())
    """)

    op.create_table(
        "habit_logs",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("habit_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("completed_at", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["habit_id"], ["habits.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("idx_habit_logs_habit", "habit_logs", ["habit_id"])
    op.create_index("idx_habit_logs_habit_date", "habit_logs", ["habit_id", "completed_at"])
    op.execute("ALTER TABLE habit_logs ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON habit_logs
          USING (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_table("habit_logs")
    op.drop_table("habits")
