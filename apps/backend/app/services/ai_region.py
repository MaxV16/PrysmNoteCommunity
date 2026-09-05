"""Regional compliance routing for hosted PrysmAI (core).

Decides which model chain serves a user based on the Cloudflare ``cf-ipcountry``
request header. Three outcomes, in order:

1. Restricted jurisdiction (Russia/Belarus/etc.) -> ``RegionBlockedError``; the
   router maps it to HTTP 403 and no model call or usage row ever happens.
2. DeepSeek allowlist country -> the DeepSeek chain (opt-in: empty allowlist =
   DeepSeek disabled everywhere, the default).
3. Anything else (logged-in-but-unlisted country, missing or unknown header) ->
   the global GDPR-safe default chain, which never contains a Chinese-origin
   provider.

``cf-ipcountry`` is best-effort (VPNs can spoof it) - this is a compliance
model-routing + business-denial control, not a sanctions enforcement system.
Fail-safe on unknown: any request we cannot classify gets the compliant chain
and is never blocked. RegionBlockedError is raised only for an explicit,
configured blocklist match.
"""
from __future__ import annotations

from app.config import settings


class RegionBlockedError(Exception):
    """Raised when a request's country is explicitly denied PrysmAI."""


def parse_country_list(raw: str) -> set[str]:
    """Split a comma-separated ISO alpha-2 list into an upper-cased, trimmed set.

    Empty input yields an empty set; garbage entries are dropped.
    """
    if not raw:
        return set()
    out: set[str] = set()
    for part in raw.split(","):
        part = part.strip().upper()
        if len(part) == 2 and part.isalpha():
            out.add(part)
    return out


def parse_chain(raw: str) -> list[str]:
    """Split a comma-separated model chain into an ordered, non-empty list.

    Empty input yields an empty list (the caller falls back to the default
    chain); entries are trimmed and empties dropped so ``"a, ,b"`` parses to
    ``["a", "b"]``.
    """
    if not raw:
        return []
    return [m.strip() for m in raw.split(",") if m.strip()]


def _restricted() -> set[str]:
    return parse_country_list(settings.prysm_ai_restricted_countries)


def _deepseek_countries() -> set[str]:
    return parse_country_list(settings.prysm_ai_deepseek_countries)


def _default_chain() -> list[str]:
    return parse_chain(settings.prysm_ai_default_chain)


def _deepseek_chain() -> list[str]:
    return parse_chain(settings.prysm_ai_deepseek_chain)


def is_region_blocked(cf_country: str | None) -> bool:
    """True when the country code is explicitly denied PrysmAI."""
    if not cf_country:
        return False
    return cf_country.strip().upper() in _restricted()


def uses_deepseek(cf_country: str | None) -> bool:
    """True when the country code is on the DeepSeek allowlist."""
    if not cf_country:
        return False
    return cf_country.strip().upper() in _deepseek_countries()


def resolve_ai_chain(cf_country: str | None) -> tuple[str, list[str]]:
    """Resolve ``(primary_model, fallback_models)`` for a request's country.

    Raises ``RegionBlockedError`` for restricted countries. Never returns a
    DeepSeek model for an un-listed/missing/unknown country. A deprecated
    single-model override (``prysm_ai_region_model``) pins the default chain to
    that one model with no fallbacks.
    """
    if is_region_blocked(cf_country):
        raise RegionBlockedError(cf_country)

    if uses_deepseek(cf_country):
        chain = _deepseek_chain()
    else:
        chain = _default_chain()
        if settings.prysm_ai_region_model:
            chain = [settings.prysm_ai_region_model]

    # Always land on a usable chain even if config was emptied: fall back to the
    # default chain, then to a hardcoded safe pair so a misconfigured box never
    # routes to nothing.
    if not chain:
        chain = _default_chain()
    if not chain:
        chain = ["thinkingmachines/inkling:free", "thinkingmachines/inkling"]

    return chain[0], chain[1:]