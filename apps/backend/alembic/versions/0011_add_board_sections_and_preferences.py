"""Add board_sections, user_preferences and tasks board placement columns

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_preferences",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "key", name="uq_user_preferences_user_key"),
    )

    op.create_table(
        "board_sections",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("color", sa.String(16), nullable=True),
        sa.Column("status", sa.String(16), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "kind", "status", name="uq_board_sections_user_kind_status"),
    )

    op.add_column("tasks", sa.Column("board_section_id", sa.UUID(), nullable=True))
    op.add_column("tasks", sa.Column("board_order", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_tasks_board_section_id",
        "tasks",
        "board_sections",
        ["board_section_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_tasks_board_section", "tasks", ["user_id", "board_section_id", "board_order"])

    op.execute("ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE board_sections ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON user_preferences
          USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())
    """)
    op.execute("""
        CREATE POLICY user_isolation ON board_sections
          USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_constraint("fk_tasks_board_section_id", "tasks", type_="foreignkey")
    op.drop_index("ix_tasks_board_section", table_name="tasks")
    op.drop_column("tasks", "board_section_id")
    op.drop_column("tasks", "board_order")
    op.drop_table("board_sections")
    op.drop_table("user_preferences")
