"""Add task soft-delete column (deleted_at)

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-08

Moves every task DELETE from physical removal to a soft delete that lands in
the Trash view. Tasks are purged for real 14 days after being trashed. The
partial index keeps the trash listing (deleted rows) cheap to scan.

Mirrors the idempotent provisioning ALTER in schema_provisioning.py so fresh
and existing databases converge.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_user_deleted "
        "ON tasks (user_id, deleted_at) WHERE deleted_at IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_tasks_user_deleted")
    op.drop_column("tasks", "deleted_at")