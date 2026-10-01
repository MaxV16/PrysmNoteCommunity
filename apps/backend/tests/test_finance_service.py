"""Tests for the core finance service and router (SQLite-portable)."""
import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.finance import FinancialItem, FinancialTransaction
from app.services import finance_service


async def _make_item(session, user_id, **overrides):
    item = FinancialItem(
        user_id=user_id,
        name=overrides.pop("name", "Rent"),
        direction=overrides.pop("direction", "expense"),
        amount=overrides.pop("amount", Decimal("1000.00")),
        kind=overrides.pop("kind", "recurring"),
        **overrides,
    )
    session.add(item)
    await session.flush()
    return item


async def test_create_and_list_items(db_session, ai_user):
    await _make_item(db_session, ai_user, name="Rent")
    await _make_item(db_session, ai_user, name="Salary", direction="income")
    await db_session.flush()

    rows = (
        await db_session.execute(
            select(FinancialItem).where(FinancialItem.user_id == ai_user)
        )
    ).scalars().all()
    assert len(rows) == 2
    assert {r.name for r in rows} == {"Rent", "Salary"}


async def test_serialize_item_shape(db_session, ai_user):
    item = await _make_item(db_session, ai_user)
    payload = finance_service.serialize_item(item)
    assert payload["id"] == str(item.id)
    assert payload["amount"] == "1000.00"
    assert payload["kind"] == "recurring"


async def test_default_remaining_balance(db_session, ai_user):
    item = await _make_item(
        db_session, ai_user, principal=Decimal("5000.00"), amount=Decimal("500.00")
    )
    assert item.remaining_balance is None
    finance_service.default_remaining_balance(item)
    assert item.remaining_balance == Decimal("5000.00")
    # Existing balance is preserved.
    item.remaining_balance = Decimal("4000.00")
    finance_service.default_remaining_balance(item)
    assert item.remaining_balance == Decimal("4000.00")


async def test_resolve_by_name_and_ambiguous(db_session, ai_user):
    await _make_item(db_session, ai_user, name="Car Loan")
    await db_session.flush()

    item, err = await finance_service.resolve_financial_item(db_session, ai_user, "car loan")
    assert err is None
    assert item is not None and item.name == "Car Loan"

    item, err = await finance_service.resolve_financial_item(db_session, ai_user, "loan")
    assert err is None and item is not None

    await _make_item(db_session, ai_user, name="Bike Loan")
    await db_session.flush()
    item, err = await finance_service.resolve_financial_item(db_session, ai_user, "loan")
    assert item is None
    assert err is not None and err["code"] == "ambiguous"
    assert len(err["candidates"]) == 2


async def test_resolve_missing_ref(db_session, ai_user):
    item, err = await finance_service.resolve_financial_item(db_session, ai_user, "  ")
    assert item is None
    assert err is not None and err["code"] == "missing_ref"


async def test_record_payment_decrements_balance(db_session, ai_user):
    item = await _make_item(
        db_session,
        ai_user,
        principal=Decimal("1000.00"),
        remaining_balance=Decimal("1000.00"),
    )
    await db_session.flush()

    result = await finance_service.record_payment(
        db_session, ai_user, str(item.id), date(2026, 1, 15), Decimal("300.00")
    )
    assert result["recorded"] is True
    assert result["remaining_balance"] == "700.00"
    assert result["paid_off"] is False

    txn = (
        await db_session.execute(
            select(FinancialTransaction).where(FinancialTransaction.item_id == item.id)
        )
    ).scalars().one()
    assert txn.amount == Decimal("300.00")
    assert txn.source == "manual"


async def test_record_payment_pays_off(db_session, ai_user):
    item = await _make_item(
        db_session,
        ai_user,
        principal=Decimal("500.00"),
        remaining_balance=Decimal("500.00"),
    )
    await db_session.flush()

    result = await finance_service.record_payment(
        db_session, ai_user, str(item.id), date(2026, 2, 1), Decimal("500.00")
    )
    assert result["paid_off"] is True
    assert result["remaining_balance"] == "0.00"
    await db_session.refresh(item)
    assert item.paid_off_at == date(2026, 2, 1)
    assert item.end_date == date(2026, 2, 1)


async def test_record_payment_rejects_non_positive(db_session, ai_user):
    item = await _make_item(db_session, ai_user, remaining_balance=Decimal("10.00"))
    await db_session.flush()
    result = await finance_service.record_payment(
        db_session, ai_user, str(item.id), date(2026, 1, 1), Decimal("0")
    )
    assert result["code"] == "invalid_amount"


async def test_pay_off_item(db_session, ai_user):
    item = await _make_item(
        db_session, ai_user, principal=Decimal("800.00"), remaining_balance=Decimal("800.00")
    )
    await db_session.flush()

    result = await finance_service.pay_off_item(
        db_session, ai_user, str(item.id), date(2026, 3, 1)
    )
    assert result["paid_off"] is True
    assert result["amount_paid"] == "800.00"
    await db_session.refresh(item)
    assert item.remaining_balance == Decimal("0.00")
    assert item.paid_off_at == date(2026, 3, 1)


async def test_reverse_transaction_restores_balance(db_session, ai_user):
    item = await _make_item(
        db_session,
        ai_user,
        principal=Decimal("1000.00"),
        remaining_balance=Decimal("1000.00"),
    )
    await db_session.flush()
    await finance_service.record_payment(
        db_session, ai_user, str(item.id), date(2026, 1, 15), Decimal("400.00")
    )
    txn = (
        await db_session.execute(
            select(FinancialTransaction).where(FinancialTransaction.item_id == item.id)
        )
    ).scalars().one()

    result = await finance_service.reverse_transaction(db_session, ai_user, str(txn.id))
    assert result["reversed"] is True
    assert result["remaining_balance"] == "1000.00"
    await db_session.refresh(item)
    assert item.remaining_balance == Decimal("1000.00")

    remaining = (
        await db_session.execute(
            select(FinancialTransaction).where(FinancialTransaction.id == txn.id)
        )
    ).scalars().all()
    assert remaining == []


async def test_reverse_transaction_invalid_id(db_session, ai_user):
    result = await finance_service.reverse_transaction(db_session, ai_user, "not-a-uuid")
    assert result["code"] == "invalid_transaction_id"


async def test_direction_enum_values_are_stored_as_strings(db_session, ai_user):
    item = await _make_item(db_session, ai_user, direction="expense")
    await db_session.flush()
    assert item.direction == "expense"


# --- Router-level (ungated) -------------------------------------------------


async def test_router_crud_flow(client: AsyncClient):
    created = await client.post(
        "/api/finance/items",
        json={"name": "Phone Bill", "direction": "expense", "amount": 45.5, "kind": "recurring"},
    )
    assert created.status_code == 201, created.text
    item_id = created.json()["id"]

    listed = await client.get("/api/finance/items")
    assert listed.status_code == 200
    assert any(i["id"] == item_id for i in listed.json())

    patched = await client.patch(
        f"/api/finance/items/{item_id}", json={"amount": 50.0}
    )
    assert patched.status_code == 200
    assert patched.json()["amount"] == "50.00"

    pay = await client.post(
        f"/api/finance/items/{item_id}/pay",
        json={"date": "2026-04-01", "amount": 25.0},
    )
    assert pay.status_code == 200, pay.text
    assert pay.json()["recorded"] is True

    txns = await client.get("/api/finance/transactions")
    assert txns.status_code == 200
    assert len(txns.json()) == 1

    deleted = await client.delete(f"/api/finance/items/{item_id}")
    assert deleted.status_code == 204


async def test_router_pay_rejects_bad_date(client: AsyncClient):
    created = await client.post(
        "/api/finance/items", json={"name": "Gym", "amount": 30}
    )
    item_id = created.json()["id"]
    bad = await client.post(
        f"/api/finance/items/{item_id}/pay",
        json={"date": "not-a-date", "amount": 5},
    )
    assert bad.status_code == 422


async def test_router_debts_endpoint(client: AsyncClient):
    created = await client.post(
        "/api/finance/items",
        json={"name": "Student Loan", "amount": 200, "principal": 4000},
    )
    assert created.status_code == 201
    assert created.json()["remaining_balance"] == "4000.00"

    debts = await client.get("/api/finance/debts")
    assert debts.status_code == 200
    assert len(debts.json()) == 1


async def test_router_has_no_projection_endpoint(client: AsyncClient):
    resp = await client.get("/api/finance/projection")
    assert resp.status_code == 404
