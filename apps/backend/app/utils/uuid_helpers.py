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
