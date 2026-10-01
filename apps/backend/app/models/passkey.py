from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, LargeBinary, String, Uuid, event, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Passkey(Base):
    """A WebAuthn credential (passkey) registered by a user.

    Core feature (all users, free): a passkey is an alternative sign-in method
    for any account, including SSO-created ones. `credential_id` is the
    base64url-encoded raw credential id from the authenticator; `public_key` is
    the COSE public key used to verify assertions. One user may register several
    credentials (one per device/authenticator).

    Sign-in updates `sign_count` and `last_used_at`. Never log the raw
    assertion/attestation payloads.
    """

    __tablename__ = "passkeys"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[str] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    credential_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    sign_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0", default=0)
    # Comma-joined transport hints (e.g. "internal,hybrid") reported at creation.
    transports: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Authenticator AAGUID (base64url/hex string), used to suggest a device name.
    aaguid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


# RLS: passkeys are user-scoped. after_create (create_all cannot emit policies),
# idempotent, PostgreSQL-only (no-op on SQLite).
def _enable_rls(target, connection, **kw):
    if connection.dialect.name != "postgresql":
        return
    connection.execute(text(
        "CREATE OR REPLACE FUNCTION rls_user_id() RETURNS UUID AS $$ "
        "SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID; "
        "$$ LANGUAGE SQL STABLE"
    ))
    connection.execute(text(f"ALTER TABLE {target.name} ENABLE ROW LEVEL SECURITY"))
    connection.execute(text(f"ALTER TABLE {target.name} FORCE ROW LEVEL SECURITY"))
    connection.execute(text(f"DROP POLICY IF EXISTS user_isolation ON {target.name}"))
    connection.execute(text(
        f"CREATE POLICY user_isolation ON {target.name} "
        f"USING (user_id = rls_user_id()) "
        f"WITH CHECK (user_id = rls_user_id())"
    ))


event.listen(Passkey.__table__, "after_create", _enable_rls)
