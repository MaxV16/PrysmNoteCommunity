"""Regression: the Google Calendar OAuth flow must not use a PKCE challenge.

The connect route and its callback each build their own ``Flow`` (one per
request, no shared session state). A ``code_verifier`` generated at connect time
therefore does not exist when the callback exchanges the code, and Google
rejects the exchange with ``(invalid_grant) Missing code verifier``. That raised
an unhandled 500, so "Connect Google Calendar" appeared to do nothing.
"""
from urllib.parse import unquote_plus

from app.services.calendar_service import GOOGLE_CALENDAR_SCOPES, get_google_oauth_flow

REDIRECT = "https://prysmnote.com/settings"


def test_flow_requests_every_scope_the_integration_needs():
    """`calendarList.list` needs the calendar-list scope, which `calendar.events`
    does not imply; a flow that omits it 403s on the calendars endpoint."""
    flow = get_google_oauth_flow(REDIRECT)
    url, _ = flow.authorization_url(state="state-token")
    decoded = unquote_plus(url)

    for scope in GOOGLE_CALENDAR_SCOPES:
        assert scope in decoded


def test_authorization_url_includes_every_requested_scope():
    flow = get_google_oauth_flow(REDIRECT)
    url, _ = flow.authorization_url(state="state-token")

    assert "calendar.events" in url
    assert "calendar.calendarlist.readonly" in url


def test_authorization_url_omits_pkce_challenge():
    flow = get_google_oauth_flow(REDIRECT)
    url, _ = flow.authorization_url(state="state-token")

    assert "code_challenge" not in url
    assert "code_challenge_method" not in url


def test_flow_never_generates_a_code_verifier():
    flow = get_google_oauth_flow(REDIRECT)
    flow.authorization_url(state="state-token")

    assert flow.code_verifier is None


def test_callback_side_flow_matches_connect_side_flow():
    connect_flow = get_google_oauth_flow(REDIRECT)
    connect_flow.authorization_url(state="state-token")
    callback_flow = get_google_oauth_flow(REDIRECT)

    assert callback_flow.code_verifier == connect_flow.code_verifier
