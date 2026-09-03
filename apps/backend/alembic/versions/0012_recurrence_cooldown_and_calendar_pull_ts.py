"""Add recurrence cooldown and calendar pull timestamps

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Mirrors the idempotent provisioning ALTERs in schema_provisioning.py so
    # fresh and existing databases converge. Additive nullable only - existing
    # rows are untouched.
    op.add_column("tasks", sa.Column("recurrence_last_expanded_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("user_tokens", sa.Column("last_pulled_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("user_tokens", "last_pulled_at")
    op.drop_column("tasks", "recurrence_last_expanded_at")
