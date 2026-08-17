import pytest
from uuid import uuid4

from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.models.user_token import UserToken
from app.services.calendar_service import (
    backfill_encrypted_tokens,
    get_stored_tokens,
    store_tokens,
)

_FERNET_KEY = Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def _valid_encryption_key(monkeypatch):
    # CI sets a non-Fernet ENCRYPTION_KEY dummy; the token encryption path needs
    # a real 44-char Fernet key.
    monkeypatch.setattr(settings, "encryption_key", _FERNET_KEY)


async def _make_user(db_session: AsyncSession) -> uuid4:
    user = User(id=uuid4(), email=f"{uuid4()}@tokens.test", password_hash="fake")
    db_session.add(user)
    await db_session.flush()
    return user.id


@pytest.mark.asyncio
async def test_store_and_load_tokens_roundtrip_encrypted(db_session: AsyncSession):
    """store_tokens encrypts at rest; get_stored_tokens decrypts back to the
    original values (E1)."""
    user_id = await _make_user(db_session)
    await store_tokens(
        db_session,
        user_id,
        access_token="secret-access-token",
        refresh_token="secret-refresh-token",
        expiry=None,
    )
    await db_session.flush()

    # The row at rest must NOT contain the plaintext.
    result = await db_session.execute(
        UserToken.__table__.select().where(UserToken.user_id == user_id)
    )
    row = result.fetchone()
    assert row is not None
    assert row.access_token.startswith("enc:")
    assert "secret-access-token" not in row.access_token
    assert row.refresh_token.startswith("enc:")

    # Reading decrypts back to the original values.
    loaded = await get_stored_tokens(db_session, user_id)
    assert loaded == ("secret-access-token", "secret-refresh-token")


@pytest.mark.asyncio
async def test_backfill_encrypts_legacy_plaintext_tokens(db_session: AsyncSession):
    """Legacy plaintext rows (no enc: prefix) are encrypted idempotently (E2)."""
    user_id = await _make_user(db_session)
    db_session.add(
        UserToken(
            user_id=user_id,
            provider="google_calendar",
            access_token="legacy-plain-access",
            refresh_token="legacy-plain-refresh",
            token_uri="https://oauth2.googleapis.com/token",
        )
    )
    await db_session.flush()

    converted = await backfill_encrypted_tokens(db_session)
    assert converted == 1

    result = await db_session.execute(
        UserToken.__table__.select().where(UserToken.user_id == user_id)
    )
    row = result.fetchone()
    assert row.access_token.startswith("enc:")
    assert row.refresh_token.startswith("enc:")

    # Idempotent: a second pass converts nothing.
    converted_again = await backfill_encrypted_tokens(db_session)
    assert converted_again == 0

    # The decrypted values survive the round-trip.
    loaded = await get_stored_tokens(db_session, user_id)
    assert loaded == ("legacy-plain-access", "legacy-plain-refresh")


@pytest.mark.asyncio
async def test_backfill_skips_other_providers(db_session: AsyncSession):
    """Only google_calendar rows are considered for the token backfill."""
    user_id = await _make_user(db_session)
    db_session.add(
        UserToken(
            user_id=user_id,
            provider="some_other_provider",
            access_token="plaintext-elsewhere",
        )
    )
    await db_session.flush()
    converted = await backfill_encrypted_tokens(db_session)
    assert converted == 0
