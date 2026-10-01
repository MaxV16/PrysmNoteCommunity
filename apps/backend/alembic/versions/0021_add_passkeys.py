"""Add passkeys (WebAuthn credentials)

Revision ID: 0021
Revises: 0020

Parity/history only. The production/staging databases have no alembic_version
table and are converged by `create_all` + the startup hooks; the `Passkey`
model's `after_create` RLS hook creates the policy automatically there.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "passkeys",
        sa.Column("id", sa.UUID(), server_default=sa.func.gen_random_uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("credential_id", sa.String(255), nullable=False),
        sa.Column("public_key", sa.LargeBinary(), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("transports", sa.String(64), nullable=True),
        sa.Column("aaguid", sa.String(64), nullable=True),
        sa.Column("name", sa.String(100), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("credential_id", name="uq_passkeys_credential_id"),
    )
    op.create_index("ix_passkeys_user_id", "passkeys", ["user_id"])

    op.execute("ALTER TABLE passkeys ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE passkeys FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY user_isolation ON passkeys
          USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())
    """)


def downgrade() -> None:
    op.drop_index("ix_passkeys_user_id", table_name="passkeys")
    op.drop_table("passkeys")
