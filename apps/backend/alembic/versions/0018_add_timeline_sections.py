"""Add timeline sections (display-layer segmented bands)

Revision ID: 0018
Revises: 0017
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "timeline_sections",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("color", sa.String(20), nullable=True),
        sa.Column("start_pct", sa.SmallInteger(), nullable=False, server_default="50"),
        sa.Column("end_pct", sa.SmallInteger(), nullable=False, server_default="100"),
        sa.Column("rule_kind", sa.String(16), nullable=True),
        sa.Column("rule_value", sa.String(200), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )

    op.execute("ALTER TABLE timeline_sections ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON timeline_sections
          USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS user_isolation ON timeline_sections")
    op.drop_table("timeline_sections")