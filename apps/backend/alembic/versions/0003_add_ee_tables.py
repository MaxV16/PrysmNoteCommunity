"""No-op chain placeholder.

The `feature_requests` and `ee_contact_submissions` tables it once created are
now provisioned by their models via ``create_all`` at app startup, so no DDL is
needed here. This revision is kept only to preserve the linear alembic lineage
(0004 depends on 0003).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
