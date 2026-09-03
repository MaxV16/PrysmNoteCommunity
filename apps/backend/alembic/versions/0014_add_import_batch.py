"""Add import_batch_id to tasks and notes for batch import tracking + undo

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("import_batch_id", sa.Uuid(), nullable=True))
    op.add_column("notes", sa.Column("import_batch_id", sa.Uuid(), nullable=True))
    op.create_index("idx_tasks_user_import_batch", "tasks", ["user_id", "import_batch_id"])
    op.create_index("idx_notes_user_import_batch", "notes", ["user_id", "import_batch_id"])


def downgrade() -> None:
    op.drop_index("idx_notes_user_import_batch", table_name="notes")
    op.drop_index("idx_tasks_user_import_batch", table_name="tasks")
    op.drop_column("notes", "import_batch_id")
    op.drop_column("tasks", "import_batch_id")