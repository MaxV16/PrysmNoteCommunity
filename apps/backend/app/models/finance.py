"""Core finance models: manual financial items and transactions.

Amounts are ``Numeric(12, 2)`` (never float). Row-level security is provisioned
with an idempotent, dialect-guarded ``after_create`` DDL event so the community
build gets the same ``user_isolation`` policy as the rest of the schema, while
SQLite (tests) is a no-op.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from enum import Enum

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    Uuid,
    event,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Direction(str, Enum):
    INCOME = "income"
    EXPENSE = "expense"


class ItemKind(str, Enum):
    ONE_OFF = "one_off"
    RECURRING = "recurring"


class Frequency(str, Enum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"


class TransactionSource(str, Enum):
    MANUAL = "manual"
    GOCARDLESS = "gocardless"
    PLAID = "plaid"


class FinancialItem(Base):
    __tablename__ = "financial_items"
    __table_args__ = (
        Index("ix_financial_items_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default=ItemKind.ONE_OFF.value)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    frequency: Mapped[str | None] = mapped_column(String(10), nullable=True)
    next_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    payee: Mapped[str | None] = mapped_column(String(200), nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    principal: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    remaining_balance: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    interest_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 3), nullable=True)
    paid_off_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    repeat_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    frequency_unit: Mapped[str | None] = mapped_column(String(10), nullable=True)
    frequency_interval: Mapped[int | None] = mapped_column(Integer, nullable=True, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class FinancialTransaction(Base):
    __tablename__ = "financial_transactions"
    __table_args__ = (
        Index("ix_financial_transactions_user_date", "user_id", "date"),
        Index("ix_financial_transactions_item", "item_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    counterparty: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source: Mapped[str] = mapped_column(
        String(20), nullable=False, default=TransactionSource.MANUAL.value
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("financial_items.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


_RLS_FUNCTION = text(
    "CREATE OR REPLACE FUNCTION rls_user_id() RETURNS UUID AS $$ "
    "SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID; "
    "$$ LANGUAGE SQL STABLE"
)


def _enable_finance_rls(target, connection, **kw):  # noqa: ANN001
    """Provision RLS on a finance table at create time (Postgres only)."""
    if connection.dialect.name != "postgresql":
        return
    name = target.name
    connection.execute(_RLS_FUNCTION)
    connection.execute(text(f"ALTER TABLE {name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {name}"))
    connection.execute(
        text(
            f"CREATE POLICY user_isolation ON {name} "
            "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())"
        )
    )


for _table in (FinancialItem, FinancialTransaction):
    event.listen(_table.__table__, "after_create", _enable_finance_rls)
