"""Add users.provider for SSO accounts

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS provider VARCHAR(20)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_users_provider ON users(provider)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_provider")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS provider")
