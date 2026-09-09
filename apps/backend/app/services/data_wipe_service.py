"""Anonymizing account wipe that preserves the ``users`` row and premium status.

Used by ``scripts/wipe_user_data.py`` (the prod operator tool called when the
owner wants a clean dev account). It runs over ``system_session_factory``
(BYPASSRLS ``prysm_system`` role): the normal request path enforces RLS FORCE
and cannot delete another user's rows.

Company rules honored here:
- The ``users`` row is NEVER deleted - it is the FK target for premium rows (and
  others); deleting it would destroy the permanent subscription. Instead the
  account is anonymized and its JWT version bumped so every existing session dies.
- The premium subscription table is intentionally absent from every delete list.
- Tables without a direct ``user_id`` column are reached through their owner:
  ``task_tags``/``task_embeddings`` via the user's tasks, ``team_invites`` via
  ``invited_by``, ``teams`` via ``owner_id``, ``task_shares`` via ``shared_by``
  (task-scoped shares cascade when the tasks are deleted).
- Child rows first, then owners, so no FK is left dangling mid-transaction.

The EE-only table list and the premium-preservation helpers are wrapped in
marker blocks that ``strip-community.sh`` deletes: a community build has no EE
tables, so the wipe simply covers the core tables and reports no premium row.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import Uuid as SATypeUuid
from sqlalchemy import bindparam, select, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

# Typed bind for the user id so every statement goes through SQLAlchemy's Uuid
# bind processor (UUID object on PostgreSQL, dash-less hex on SQLite), exactly
# like the ORM models - a raw string would never match on SQLite.
_uid_param = bindparam("uid", type_=SATypeUuid(as_uuid=True))

# (table, where-clause body). ``uid`` is bound per statement. Order matters for
# FK safety: join/child tables first, owners after. Both strings are from this
# fixed list - never user input - so interpolation is injection-safe.
CORE_WIPE_SPECS: list[tuple[str, str]] = [
    ("task_tags", "task_id IN (SELECT id FROM tasks WHERE user_id = :uid)"),
    ("task_embeddings", "task_id IN (SELECT id FROM tasks WHERE user_id = :uid)"),
    ("tasks", "user_id = :uid"),
    ("task_links", "user_id = :uid"),
    ("calendar_events", "user_id = :uid"),
    ("notification_logs", "user_id = :uid"),
    ("task_shares", "shared_by = :uid"),
    ("lists", "user_id = :uid"),
    ("board_sections", "user_id = :uid"),
    ("tags", "user_id = :uid"),
    ("habits", "user_id = :uid"),
    ("habit_logs", "user_id = :uid"),
    ("notes", "user_id = :uid"),
    ("watchlist_items", "user_id = :uid"),
    ("api_keys", "user_id = :uid"),
    ("user_tokens", "user_id = :uid"),
    ("user_preferences", "user_id = :uid"),
    ("user_notification_prefs", "user_id = :uid"),
    ("push_subscriptions", "user_id = :uid"),
    ("ai_sessions", "user_id = :uid"),
    ("ai_conversations", "user_id = :uid"),
    ("ai_memories", "user_id = :uid"),
    ("ai_cache", "user_id = :uid"),
    ("ai_usage", "user_id = :uid"),
    ("analytics_events", "user_id = :uid"),
    ("token_blacklist", "user_id = :uid"),
    ("team_members", "user_id = :uid"),
    ("team_invites", "invited_by = :uid"),
    ("teams", "owner_id = :uid"),
]



def _wipe_specs() -> list[tuple[str, str]]:
    specs = list(CORE_WIPE_SPECS)
    return specs


def _table_missing(exc: Exception) -> bool:
    """True only when the failure is a missing table, never a real DB error.

    SQLite says "no such table: x"; Postgres says 'relation "x" does not exist'
    (often nested in the driver's ProgrammingError/OperationalError). Anything
    else (FK violation, permission, malformed SQL) must surface - a wipe that
    silently skipped real rows would be worse than one that failed.
    """
    msg = str(getattr(exc, "orig", exc)).lower()
    return "no such table" in msg or "does not exist" in msg or "undefined_table" in msg


async def _row_count(session: AsyncSession, spec: tuple[str, str], user_id: UUID) -> int:
    table, where = spec
    result = await session.execute(
        text(f"SELECT COUNT(*) FROM {table} WHERE {where}").bindparams(_uid_param),
        {"uid": user_id},
    )
    return int(result.scalar_one())


async def _delete_all(session: AsyncSession, spec: tuple[str, str], user_id: UUID) -> int:
    table, where = spec
    result = await session.execute(
        text(f"DELETE FROM {table} WHERE {where}").bindparams(_uid_param),
        {"uid": user_id},
    )
    return result.rowcount or 0


async def wipe_user_data(
    session: AsyncSession,
    user_id: UUID,
    *,
    keep_premium: bool = True,
    dry_run: bool = False,
) -> dict:
    """Apply the wipe inside ``session`` (must be a BYPASSRLS connection).

    Deletes every user-scoped row across the wipe tables, then anonymizes the
    user (email, password, profile, provider, token_version bump). In dry-run
    mode nothing is deleted - the per-table row counts are returned instead.
    The premium subscription table is never touched; ``keep_premium`` reports
    whether the active premium row is still present afterwards.
    """
    user_id_str = str(user_id)
    counts: dict[str, int] = {}
    total = 0


    for spec in _wipe_specs():
        table = spec[0]
        try:
            if dry_run:
                n = await _row_count(session, spec, user_id)
            else:
                n = await _delete_all(session, spec, user_id)
        except (OperationalError, ProgrammingError) as exc:
            # A table that does not exist (e.g. EE tables absent in a community
            # build) is fine - skip it; anything else must not be swallowed.
            if not _table_missing(exc):
                raise
            continue
        counts[table] = n
        total += n


    anonymized = False
    if not dry_run:
        await session.execute(
            text(
                "UPDATE users SET "
                "email = :email, password_hash = NULL, display_name = :name, "
                "provider = NULL, email_verified = false, token_version = token_version + 1 "
                "WHERE id = :uid"
            ).bindparams(_uid_param),
            {
                "email": f"deleted-{user_id_str}@prysmnote.com",
                "name": "[Deleted User]",
                "uid": user_id,
            },
        )
        anonymized = True

    return {
        "user_id": user_id_str,
        "dry_run": dry_run,
        "counts": counts,
        "total_rows_deleted": total,
        "anonymized": anonymized,
    }
