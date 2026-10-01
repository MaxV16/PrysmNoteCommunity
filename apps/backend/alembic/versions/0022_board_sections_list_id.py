"""Scope board sections to a task list

Revision ID: 0022
Revises: 0021

Timeline sections are now per-list: a new list starts with no sections and the
user creates them explicitly. Kanban/board sections keep list_id NULL (the
workspace-wide scope), which is also the scope used when no list is selected.

Parity/history only. Production/staging converge via ``create_all`` + the
startup ``ALTER TABLE ... ADD COLUMN IF NOT EXISTS`` statements in
``app/services/schema_provisioning.py`` (the production schema has no
alembic_version table).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0022"
down_revision: Union[str, None] = "0021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("board_sections", sa.Column("list_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_board_sections_list_id",
        "board_sections",
        "lists",
        ["list_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_board_sections_list", "board_sections", ["list_id"])


def downgrade() -> None:
    op.drop_index("ix_board_sections_list", table_name="board_sections")
    op.drop_constraint("fk_board_sections_list_id", "board_sections", type_="foreignkey")
    op.drop_column("board_sections", "list_id")
