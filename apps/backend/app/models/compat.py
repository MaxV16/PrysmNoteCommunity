"""Cross-dialect type compatibility for local SQLite test runs.

Production uses PostgreSQL (JSONB, pgvector). The model layer references those
Postgres-specific types, which cannot compile when tests run against an in-memory
SQLite database. These compiler registrations let tables be created on SQLite
without altering the Postgres behaviour used at runtime.
"""

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles


def register_sqlite_compilers() -> None:
    """Import-time no-op: the @compiles registrations below are applied when this
    module is imported. Exposed as a function so callers are explicit about
    pulling in the cross-dialect compiler shims before table metadata is used."""


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


try:
    from pgvector.sqlalchemy.vector import VECTOR as PGVectorType
except ImportError:  # pragma: no cover - pgvector is always installed in prod
    PGVectorType = None


if PGVectorType is not None:

    @compiles(PGVectorType, "sqlite")
    def _compile_vector_sqlite(type_, compiler, **kw):
        return "TEXT"
