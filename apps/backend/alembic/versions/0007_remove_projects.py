"""Remove projects feature entirely (table + tasks.project_id)

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop the FK column on tasks first (idempotent), then the projects table.
    op.execute("ALTER TABLE tasks DROP COLUMN IF EXISTS project_id")
    op.execute("DROP TABLE IF EXISTS projects CASCADE")


def downgrade() -> None:
    # Best-effort restore of the projects table + task FK for rollbacks. The
    # dropped project_id data cannot be recovered; this only recreates the shape.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          parent_id UUID REFERENCES projects(id) ON DELETE SET NULL,
          name VARCHAR(255) NOT NULL,
          color VARCHAR(7),
          icon VARCHAR(50),
          sort_order INT NOT NULL DEFAULT 0,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL")
