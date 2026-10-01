"""Core finance service: manual financial items, transactions, and debts.

Postgres-only helpers guard themselves; the core SQL stays portable to SQLite
so the EE test suite (in-memory SQLite) can exercise it.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.finance import (
    FinancialItem,
    FinancialTransaction,
    ItemKind,
    TransactionSource,
)
from app.utils.uuid_helpers import parse_uuid


def _as_uuid(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return value


def _candidate(item: FinancialItem) -> dict[str, Any]:
    return {"id": str(item.id), "name": item.name, "amount": str(item.amount)}


def serialize_item(item: FinancialItem) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "name": item.name,
        "direction": item.direction,
        "amount": str(item.amount),
        "kind": item.kind,
        "start_date": item.start_date.isoformat() if item.start_date else None,
        "end_date": item.end_date.isoformat() if item.end_date else None,
        "frequency": item.frequency,
        "next_date": item.next_date.isoformat() if item.next_date else None,
        "payee": item.payee,
        "category": item.category,
        "principal": str(item.principal) if item.principal is not None else None,
        "remaining_balance": (
            str(item.remaining_balance) if item.remaining_balance is not None else None
        ),
        "interest_rate": str(item.interest_rate) if item.interest_rate is not None else None,
        "paid_off_at": item.paid_off_at.isoformat() if item.paid_off_at else None,
        "repeat_count": item.repeat_count,
        "frequency_unit": item.frequency_unit,
        "frequency_interval": item.frequency_interval,
    }


async def resolve_financial_item(
    session: AsyncSession, user_id: Any, ref: str | None
) -> tuple[FinancialItem | None, dict[str, Any] | None]:
    """Resolve a financial item by UUID or by (case-insensitive) name."""
    if not ref or not str(ref).strip():
        return None, {"error": "item_id or name is required.", "code": "missing_ref"}
    ref = str(ref).strip()

    as_uuid = parse_uuid(ref)
    if as_uuid is not None:
        item = await session.scalar(
            select(FinancialItem).where(
                FinancialItem.id == as_uuid, FinancialItem.user_id == user_id
            )
        )
        if item is None:
            return None, {"error": "Item not found", "code": "not_found"}
        return item, None

    lowered = ref.lower()
    exact = await session.scalar(
        select(FinancialItem).where(
            FinancialItem.user_id == user_id, func.lower(FinancialItem.name) == lowered
        )
    )
    if exact is not None:
        return exact, None

    matches = (
        await session.scalars(
            select(FinancialItem)
            .where(
                FinancialItem.user_id == user_id,
                func.lower(FinancialItem.name).like(f"%{lowered}%"),
            )
            .limit(10)
        )
    ).all()
    if not matches:
        return None, {"error": "Item not found", "code": "not_found"}
    if len(matches) > 1:
        return None, {
            "error": "Multiple items match that name",
            "code": "ambiguous",
            "candidates": [_candidate(i) for i in matches],
        }
    return matches[0], None


async def record_payment(
    session: AsyncSession,
    user_id: Any,
    item_id: str,
    payment_date: date,
    amount: Decimal | float,
) -> dict[str, Any]:
    item, err = await resolve_financial_item(session, user_id, item_id)
    if err:
        return err
    assert item is not None
    amount = Decimal(str(amount))
    if amount <= 0:
        return {"error": "Amount must be positive", "code": "invalid_amount"}

    txn = FinancialTransaction(
        user_id=user_id,
        date=payment_date,
        amount=amount,
        counterparty=item.name,
        description=f"Payment toward {item.name}",
        category=item.category,
        source=TransactionSource.MANUAL.value,
        item_id=item.id,
    )
    session.add(txn)

    paid_off = False
    if item.remaining_balance is not None:
        new_balance = Decimal(item.remaining_balance) - amount
        if new_balance <= 0:
            new_balance = Decimal("0.00")
            item.paid_off_at = payment_date
            item.end_date = payment_date
            paid_off = True
        item.remaining_balance = new_balance

    await session.flush()
    return {
        "recorded": True,
        "item_id": str(item.id),
        "transaction_id": str(txn.id),
        "remaining_balance": (
            str(item.remaining_balance) if item.remaining_balance is not None else None
        ),
        "paid_off": paid_off,
    }


async def pay_off_item(
    session: AsyncSession, user_id: Any, item_id: str, payment_date: date
) -> dict[str, Any]:
    item, err = await resolve_financial_item(session, user_id, item_id)
    if err:
        return err
    assert item is not None

    remaining = item.remaining_balance or item.principal or item.amount
    remaining = Decimal(remaining)
    if remaining > 0:
        session.add(
            FinancialTransaction(
                user_id=user_id,
                date=payment_date,
                amount=remaining,
                counterparty=item.name,
                description=f"Paid off in full: {item.name}",
                category=item.category,
                source=TransactionSource.MANUAL.value,
                item_id=item.id,
            )
        )
    item.remaining_balance = Decimal("0.00")
    item.paid_off_at = payment_date
    item.end_date = payment_date
    await session.flush()
    return {"paid_off": True, "item_id": str(item.id), "amount_paid": str(remaining)}


async def reverse_transaction(
    session: AsyncSession, user_id: Any, transaction_id: str
) -> dict[str, Any]:
    as_uuid = parse_uuid(transaction_id)
    if as_uuid is None:
        return {"error": "Invalid transaction_id format", "code": "invalid_transaction_id"}
    txn = await session.scalar(
        select(FinancialTransaction).where(
            FinancialTransaction.id == as_uuid, FinancialTransaction.user_id == user_id
        )
    )
    if txn is None:
        return {"error": "Transaction not found", "code": "not_found"}

    amount = Decimal(txn.amount)
    item_id = None
    remaining_balance = None
    if txn.item_id:
        item = await session.scalar(
            select(FinancialItem).where(
                FinancialItem.id == txn.item_id, FinancialItem.user_id == user_id
            )
        )
        if item is not None:
            item_id = str(item.id)
            if item.remaining_balance is not None:
                restored = Decimal(item.remaining_balance) + amount
                if item.principal is not None:
                    restored = min(restored, Decimal(item.principal))
                item.remaining_balance = restored
                item.paid_off_at = None
                if item.end_date == txn.date:
                    item.end_date = None
                remaining_balance = str(item.remaining_balance)

    await session.delete(txn)
    await session.flush()
    return {
        "reversed": True,
        "transaction_id": str(as_uuid),
        "item_id": item_id,
        "remaining_balance": remaining_balance,
    }


def default_remaining_balance(item: FinancialItem) -> None:
    """Mirror the EE default: a principal implies a starting balance."""
    if item.principal is not None and item.remaining_balance is None:
        item.remaining_balance = item.principal


__all__ = [
    "Direction",
    "ItemKind",
    "Frequency",
    "TransactionSource",
    "FinancialItem",
    "FinancialTransaction",
    "default_remaining_balance",
    "pay_off_item",
    "record_payment",
    "resolve_financial_item",
    "reverse_transaction",
    "serialize_item",
]
