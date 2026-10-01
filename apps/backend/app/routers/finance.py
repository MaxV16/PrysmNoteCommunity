"""Core finance API: manual items, transactions, and debts (ungated).

Premium-only concerns (cashflow projection, bank sync, AI tools) live in the
closed-source enterprise layer and extend this router at the same paths.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.finance import (
    FinancialItem,
    FinancialTransaction,
    ItemKind,
    TransactionSource,
)
from app.models.user import User
from app.services import finance_service
from app.utils.uuid_helpers import require_uuid

router = APIRouter(prefix="/api/finance", tags=["finance"])


class FinancialItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    direction: str = "expense"
    amount: float = Field(gt=0)
    kind: str = ItemKind.ONE_OFF.value
    start_date: date | None = None
    end_date: date | None = None
    frequency: str | None = None
    next_date: date | None = None
    payee: str | None = None
    category: str | None = None
    principal: float | None = None
    remaining_balance: float | None = None
    interest_rate: float | None = None
    paid_off_at: date | None = None
    repeat_count: int | None = None
    frequency_unit: str | None = None
    frequency_interval: int | None = None


class FinancialItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    direction: str | None = None
    amount: float | None = Field(default=None, gt=0)
    kind: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    frequency: str | None = None
    next_date: date | None = None
    payee: str | None = None
    category: str | None = None
    principal: float | None = None
    remaining_balance: float | None = None
    interest_rate: float | None = None
    paid_off_at: date | None = None
    repeat_count: int | None = None
    frequency_unit: str | None = None
    frequency_interval: int | None = None


class TransactionCreate(BaseModel):
    date: date
    amount: float
    counterparty: str | None = None
    description: str | None = None
    category: str | None = None


@router.get("/items")
async def list_items(
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_db)
) -> list[dict[str, Any]]:
    items = (
        await session.scalars(
            select(FinancialItem)
            .where(FinancialItem.user_id == user.id)
            .order_by(FinancialItem.created_at)
        )
    ).all()
    return [finance_service.serialize_item(i) for i in items]


@router.post("/items", status_code=201)
async def create_item(
    payload: FinancialItemCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    item = FinancialItem(user_id=user.id, **payload.model_dump())
    finance_service.default_remaining_balance(item)
    session.add(item)
    await session.commit()
    await session.refresh(item)
    return finance_service.serialize_item(item)


@router.get("/items/{item_id}")
async def get_item(
    item_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    item = await session.scalar(
        select(FinancialItem).where(
            FinancialItem.id == require_uuid(item_id), FinancialItem.user_id == user.id
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return finance_service.serialize_item(item)


@router.patch("/items/{item_id}")
async def update_item(
    item_id: str,
    payload: FinancialItemUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    item = await session.scalar(
        select(FinancialItem).where(
            FinancialItem.id == require_uuid(item_id), FinancialItem.user_id == user.id
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    finance_service.default_remaining_balance(item)
    await session.commit()
    await session.refresh(item)
    return finance_service.serialize_item(item)


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(
    item_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> None:
    item = await session.scalar(
        select(FinancialItem).where(
            FinancialItem.id == require_uuid(item_id), FinancialItem.user_id == user.id
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    await session.delete(item)
    await session.commit()


@router.post("/items/{item_id}/pay")
async def pay_item(
    item_id: str,
    body: dict[str, Any],
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    try:
        payment_date = date.fromisoformat(str(body.get("date", "")))
        amount = Decimal(str(body.get("amount")))
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="date (YYYY-MM-DD) and amount are required")
    result = await finance_service.record_payment(
        session, user.id, item_id, payment_date, amount
    )
    if result.get("error"):
        raise HTTPException(status_code=404, detail=result["error"])
    await session.commit()
    return result


@router.post("/items/{item_id}/pay-off")
async def payoff_item(
    item_id: str,
    body: dict[str, Any],
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    try:
        payment_date = date.fromisoformat(str(body.get("date", "")))
    except ValueError:
        raise HTTPException(status_code=422, detail="date (YYYY-MM-DD) is required")
    result = await finance_service.pay_off_item(session, user.id, item_id, payment_date)
    if result.get("error"):
        raise HTTPException(status_code=404, detail=result["error"])
    await session.commit()
    return result


@router.get("/debts")
async def list_debts(
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_db)
) -> list[dict[str, Any]]:
    items = (
        await session.scalars(
            select(FinancialItem)
            .where(
                FinancialItem.user_id == user.id,
                FinancialItem.principal.is_not(None),
                FinancialItem.paid_off_at.is_(None),
            )
            .order_by(FinancialItem.created_at)
        )
    ).all()
    return [finance_service.serialize_item(i) for i in items]


@router.get("/transactions")
async def list_transactions(
    item_id: str | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    stmt = select(FinancialTransaction).where(FinancialTransaction.user_id == user.id)
    if item_id:
        stmt = stmt.where(FinancialTransaction.item_id == require_uuid(item_id))
    stmt = stmt.order_by(FinancialTransaction.date.desc()).limit(500)
    txns = (await session.scalars(stmt)).all()
    return [
        {
            "id": str(t.id),
            "date": t.date.isoformat(),
            "amount": str(t.amount),
            "counterparty": t.counterparty,
            "description": t.description,
            "category": t.category,
            "source": t.source,
            "item_id": str(t.item_id) if t.item_id else None,
        }
        for t in txns
    ]


@router.post("/transactions", status_code=201)
async def create_transaction(
    payload: TransactionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    txn = FinancialTransaction(
        user_id=user.id,
        source=TransactionSource.MANUAL.value,
        **payload.model_dump(),
    )
    session.add(txn)
    await session.commit()
    await session.refresh(txn)
    return {
        "id": str(txn.id),
        "date": txn.date.isoformat(),
        "amount": str(txn.amount),
        "counterparty": txn.counterparty,
        "description": txn.description,
        "category": txn.category,
        "source": txn.source,
        "item_id": str(txn.item_id) if txn.item_id else None,
    }


@router.delete("/transactions/{transaction_id}")
async def delete_transaction(
    transaction_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await finance_service.reverse_transaction(session, user.id, transaction_id)
    if result.get("error"):
        status = 422 if result.get("code") == "invalid_transaction_id" else 404
        raise HTTPException(status_code=status, detail=result["error"])
    await session.commit()
    return result


__all__ = ["router"]
