"""Product lifecycle email (core).

Sends a single, non-commercial welcome note after a successful registration.
The copy is strictly product usage ("here is how to get started"): no pricing,
no upsell, no commercial detail, so it stays community-safe. It no-ops when the
mailer is not configured (``send_email`` logs and returns False).
"""

import logging

from app.services.email import send_email

logger = logging.getLogger(__name__)

WELCOME_SUBJECT = "[Prysm Note] Welcome - here is how to get started"

WELCOME_BODY = """Welcome to Prysm Note.

Here is the quickest way to get value on day one:

1. Create your first task, or describe your day in the chat in plain language
   ("I cancelled dinner on the 25th and need to plan next week").
2. Everything you add lands on the timeline, where you can drag a task to move
   it to another day.
3. Switch between Timeline, Kanban, Calendar, List and Board whenever you like.
   They all read the same tasks, so your plan never duplicates.

A few things that help:
- Press Cmd/Ctrl+F to search, or ask the chat to find something for you.
- Import existing tasks from a CSV or ICS file under Settings, then Data.
- Pick a theme in Settings to make the workspace yours.

If anything is unclear, just reply to this email.

The Prysm Note team
"""


def send_welcome_email(to_address: str, display_name: str | None = None) -> bool:
    """Send the one-time welcome note. Never raises; returns False on failure."""
    body = WELCOME_BODY
    if display_name:
        body = f"Hi {display_name},\n\n{body}"
    try:
        return send_email(to_address, WELCOME_SUBJECT, body)
    except Exception:
        logger.exception("Welcome email send failed for %s", to_address)
        return False
