"""Enable pg_trgm extension + trigram GIN index on tasks

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_tasks_trgm ON tasks USING gin "
        "(lower(title || ' ' || COALESCE(description, '')) gin_trgm_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_tasks_trgm")
