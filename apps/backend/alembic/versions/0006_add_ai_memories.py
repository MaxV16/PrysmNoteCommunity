"""Add ai_memories table for cross-session durable memory

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import pgvector.sqlalchemy as pgv

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "ai_memories",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("category", sa.String(length=32), server_default="context", nullable=False),
        sa.Column("embedding", pgv.Vector(1536), nullable=True),
        sa.Column("source_session_id", sa.UUID(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("idx_ai_memories_user_active", "ai_memories", ["user_id", "is_active"])
    op.execute("ALTER TABLE ai_memories ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON ai_memories
          USING (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_table("ai_memories")
