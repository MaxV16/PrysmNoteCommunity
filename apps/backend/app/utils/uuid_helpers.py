from uuid import UUID


def parse_uuid(value: str) -> UUID | None:
    """Return the UUID for a string, or None when it is malformed.

    Callers convert None to a 404/422 instead of letting a ValueError become a
    generic 500.
    """
    if not value:
        return None
    try:
        return UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


def require_uuid(value: str) -> UUID:
    """Parse a UUID or raise a 404 - the standard "invalid id" response (L4).

    Mirrors the `_require_uuid` helpers used across routers so malformed ids
    produce a clean 404 instead of an unhandled ValueError → 500.
    """
    from fastapi import HTTPException, status

    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    return parsed
