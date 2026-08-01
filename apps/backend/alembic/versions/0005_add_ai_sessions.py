"""Add ai_sessions table for rolling conversation summaries

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_sessions",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("idx_ai_sessions_user_session", "ai_sessions", ["user_id", "session_id"])
    op.execute("ALTER TABLE ai_sessions ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON ai_sessions
          USING (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_table("ai_sessions")
