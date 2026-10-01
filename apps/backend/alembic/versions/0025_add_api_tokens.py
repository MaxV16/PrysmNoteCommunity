"""Add api_tokens table

Revision ID: 0025
Revises: 0024
Create Date: 2026-09-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0025"
down_revision: Union[str, None] = "0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_tokens",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("prefix", sa.String(12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_api_tokens_hash", "api_tokens", ["token_hash"], unique=True)
    op.create_index("ix_api_tokens_user_revoked", "api_tokens", ["user_id", "revoked_at"])
    op.execute("ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON api_tokens
          USING (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_table("api_tokens")
