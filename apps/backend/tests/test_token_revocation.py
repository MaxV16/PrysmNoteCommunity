"""Regression tests for the race-safe single-use token revocation.

The original code SELECTed ``token_blacklist.jti`` and then INSERTed it in a
separate statement. Two requests carrying the same token (several tabs, the
desktop app plus a phone, or a client retry) could both pass the SELECT and both
INSERT; the loser raised ``IntegrityError`` on ``token_blacklist_jti_key`` and
the endpoint returned 500 instead of 401, which stranded the client's session.
``app.utils.token_revocation.blacklist_jti`` performs the insert inside a
SAVEPOINT and reports the conflict as a boolean.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.token_blacklist import TokenBlacklist
from app.utils.token_revocation import blacklist_jti


@pytest.mark.asyncio
async def test_blacklist_jti_is_idempotent(db_session: AsyncSession, test_user):
    jti = f"race-{uuid4().hex}"
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)

    assert await blacklist_jti(db_session, jti, test_user.id, expires_at) is True

    # A concurrent request already revoked this jti: report it, never raise.
    assert await blacklist_jti(db_session, jti, test_user.id, expires_at) is False

    rows = (
        await db_session.execute(select(TokenBlacklist).where(TokenBlacklist.jti == jti))
    ).scalars().all()
    assert len(rows) == 1

    # The savepoint rollback must leave the surrounding transaction usable.
    await db_session.flush()


@pytest.mark.asyncio
async def test_refresh_replay_returns_401_not_500(auth_client):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "refresh_race@example.com",
        "password": "password123",
        "display_name": "Refresh Race",
    })
    assert reg.status_code == 200
    old_refresh = reg.cookies.get("refresh_token")
    assert old_refresh

    first = await auth_client.post("/api/auth/refresh", json={"refresh_token": old_refresh})
    assert first.status_code == 200

    # Replay the rotated token: it is already blacklisted, so the response must be
    # a clean 401 rather than a unique-constraint 500.
    replay = await auth_client.post(
        "/api/auth/refresh",
        json={"refresh_token": old_refresh},
        cookies={"refresh_token": old_refresh},
    )
    assert replay.status_code == 401, replay.text
    assert replay.status_code != 500


@pytest.mark.asyncio
async def test_logout_is_idempotent_for_the_same_tokens(auth_client):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "logout_race@example.com",
        "password": "password123",
        "display_name": "Logout Race",
    })
    assert reg.status_code == 200
    cookies = {
        "access_token": reg.cookies.get("access_token"),
        "refresh_token": reg.cookies.get("refresh_token"),
    }

    first = await auth_client.post("/api/auth/logout", cookies=cookies)
    assert first.status_code == 200

    # A second logout with the same already-blacklisted tokens must not 500.
    second = await auth_client.post("/api/auth/logout", cookies=cookies)
    assert second.status_code == 200, second.text
