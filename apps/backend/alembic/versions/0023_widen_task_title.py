"""Widen task titles to VARCHAR(5000)

Revision ID: 0023
Revises: 0022

Long-form task and subtask titles (multi-line steps, pasted instructions) no
longer fit in the original VARCHAR(500) column, so the API cap and the column
are both raised to 5000 characters.

Parity/history only. Production/staging converge via the startup
``ALTER TABLE tasks ALTER COLUMN title TYPE VARCHAR(5000)`` statement in
``app/services/schema_provisioning.py`` (the production schema has no
alembic_version table).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0023"
down_revision: Union[str, None] = "0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "tasks",
        "title",
        existing_type=sa.String(length=500),
        type_=sa.String(length=5000),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "tasks",
        "title",
        existing_type=sa.String(length=5000),
        type_=sa.String(length=500),
        existing_nullable=False,
    )
