"""Add performance indexes for recurring expansion and batch reads

Revision ID: 0020
Revises: 0019
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Composite index for expand_task_occurrences / expand_task_occurrences_for_range.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_parent_start_date "
        "ON tasks (parent_task_id, start_date)"
    )
    # Partial index for the recurring expansion background loop.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_tasks_user_recurring "
        "ON tasks (user_id) WHERE recurrence_rule IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_tasks_user_recurring")
    op.execute("DROP INDEX IF EXISTS idx_tasks_parent_start_date")
