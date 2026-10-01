"""Add financial_items and financial_transactions tables

Revision ID: 0024
Revises: 0023
Create Date: 2026-09-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0024"
down_revision: Union[str, None] = "0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "financial_items",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("direction", sa.String(10), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False, server_default="one_off"),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("frequency", sa.String(10), nullable=True),
        sa.Column("next_date", sa.Date(), nullable=True),
        sa.Column("payee", sa.String(200), nullable=True),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("principal", sa.Numeric(12, 2), nullable=True),
        sa.Column("remaining_balance", sa.Numeric(12, 2), nullable=True),
        sa.Column("interest_rate", sa.Numeric(6, 3), nullable=True),
        sa.Column("paid_off_at", sa.Date(), nullable=True),
        sa.Column("repeat_count", sa.Integer(), nullable=True),
        sa.Column("frequency_unit", sa.String(10), nullable=True),
        sa.Column("frequency_interval", sa.Integer(), nullable=True, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("idx_financial_items_user", "financial_items", ["user_id"])
    op.execute("ALTER TABLE financial_items ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON financial_items
          USING (user_id = rls_user_id())
    """)

    op.create_table(
        "financial_transactions",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("external_id", sa.String(255), nullable=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("counterparty", sa.String(255), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("source", sa.String(20), nullable=False, server_default="manual"),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["financial_items.id"], ondelete="SET NULL"),
    )
    op.create_index("idx_financial_transactions_user", "financial_transactions", ["user_id"])
    op.create_index("idx_financial_transactions_date", "financial_transactions", ["date"])
    op.execute("ALTER TABLE financial_transactions ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON financial_transactions
          USING (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_table("financial_transactions")
    op.drop_table("financial_items")
