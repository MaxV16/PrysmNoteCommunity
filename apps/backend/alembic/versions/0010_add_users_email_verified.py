"""Add users.email_verified

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-18

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE"
    )
    # Grandfather existing accounts: verification only gates NEW signups (and
    # SSO accounts are provider-verified from here on). No-op on fresh installs.
    op.execute("UPDATE users SET email_verified = TRUE")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS email_verified")
