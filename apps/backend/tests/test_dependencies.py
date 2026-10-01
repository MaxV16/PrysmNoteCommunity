"""Regression test for the merged RLS setup in ``get_current_user``.

The perf change collapsed two ``set_config`` round trips (app.user_id, then
app.user_email) into ONE statement. This test asserts that exactly one
``set_config`` statement runs and it sets both variables, so RLS reads keep
working end to end.
"""
import os

import pytest
from jose import jwt
from starlette.requests import Request

from app.config import settings
from app.dependencies import get_current_user

IS_PG = os.getenv("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:").startswith("postgresql")

pytestmark = pytest.mark.skipif(not IS_PG, reason="RLS set_config is PostgreSQL-only")


def _request_with_cookie(token: str) -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/tasks/",
        "headers": [(b"cookie", f"access_token={token}".encode())],
    })


@pytest.mark.asyncio
async def test_get_current_user_sets_both_rls_vars_in_one_statement(
    test_user, db_session, monkeypatch
):
    statements: list[str] = []
    original_execute = db_session.execute

    async def spy_execute(*args, **kwargs):
        if args:
            statements.append(str(args[0]))
        return await original_execute(*args, **kwargs)

    monkeypatch.setattr(db_session, "execute", spy_execute)

    token = jwt.encode(
        {"sub": str(test_user.id), "type": "access", "tv": test_user.token_version},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    user = await get_current_user(
        request=_request_with_cookie(token),
        credentials=None,
        session=db_session,
    )
    assert user.id == test_user.id

    set_config = [s for s in statements if "set_config" in s]
    assert len(set_config) == 1, set_config
    assert "app.user_id" in set_config[0]
    assert "app.user_email" in set_config[0]
