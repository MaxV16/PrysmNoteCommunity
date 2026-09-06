"""Add task time columns (start_time/end_time)

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Mirrors the idempotent provisioning ALTERs in schema_provisioning.py so
    # fresh and existing databases converge. Additive nullable TIME columns only -
    # existing rows are untouched.
    op.add_column("tasks", sa.Column("start_time", sa.Time(), nullable=True))
    op.add_column("tasks", sa.Column("end_time", sa.Time(), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "end_time")
    op.drop_column("tasks", "start_time")