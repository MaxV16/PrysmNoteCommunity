"""Add task lists (separate task collections)

Revision ID: 0017
Revises: 0016
Create Date: 2026-09-08

Adds the user-scoped ``lists`` table and wires ``tasks.list_id``. Existing
tasks are backfilled into a default "My Tasks" list per user (idempotent).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "lists",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )

    op.add_column("tasks", sa.Column("list_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_tasks_list_id", "tasks", "lists", ["list_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("ix_tasks_list", "tasks", ["list_id"])
    op.execute("CREATE INDEX IF NOT EXISTS idx_tasks_user_deleted ON tasks (user_id, deleted_at) WHERE deleted_at IS NOT NULL")

    op.execute("ALTER TABLE lists ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON lists
          USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())
    """)

    # Idempotent backfill: one default "My Tasks" list per user that has tasks,
    # then move every list-less task into that list. Rows already handled by an
    # earlier run (or a re-run) are untouched.
    op.execute(
        "INSERT INTO lists (user_id, name, position) "
        "SELECT DISTINCT t.user_id, 'My Tasks', 0 "
        "FROM tasks t "
        "WHERE NOT EXISTS (SELECT 1 FROM lists l WHERE l.user_id = t.user_id)"
    )
    op.execute(
        "UPDATE tasks SET list_id = l.id "
        "FROM lists l "
        "WHERE tasks.user_id = l.user_id AND tasks.list_id IS NULL"
    )


def downgrade() -> None:
    op.drop_constraint("fk_tasks_list_id", "tasks", type_="foreignkey")
    op.drop_index("ix_tasks_list", table_name="tasks")
    op.drop_column("tasks", "list_id")
    op.drop_table("lists")