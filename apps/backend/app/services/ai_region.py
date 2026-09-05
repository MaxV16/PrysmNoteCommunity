"""Regional compliance routing for hosted PrysmAI (core).

Decides which model chain serves a user based on the Cloudflare ``cf-ipcountry``
request header. Three outcomes, in order:

1. Restricted jurisdiction (Russia/Belarus/etc.) -> ``RegionBlockedError``; the
   router maps it to HTTP 403 and no model call or usage row ever happens.
2. Known country NOT on the DeepSeek blocklist -> the DeepSeek chain (cheap
   overflow floor; the default for most of the world).
3. On the DeepSeek blocklist (EU/EEA + UK by default), OR a missing/unknown
   header -> the EU chain, which by construction never contains a Chinese-origin
   provider (fail-safe compliant routing for unknowns).

``cf-ipcountry`` is best-effort (VPNs can spoof it) - this is a compliance
model-routing + business-denial control, not a sanctions enforcement system.
Fail-safe on unknown: any request we cannot classify gets the compliant EU chain
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


def _deepseek_blocked() -> set[str]:
    return parse_country_list(settings.prysm_ai_deepseek_blocked_countries)


def _eu_chain() -> list[str]:
    return parse_chain(settings.prysm_ai_eu_chain)


def _deepseek_chain() -> list[str]:
    return parse_chain(settings.prysm_ai_deepseek_chain)


def is_region_blocked(cf_country: str | None) -> bool:
    """True when the country code is explicitly denied PrysmAI."""
    if not cf_country:
        return False
    return cf_country.strip().upper() in _restricted()


def uses_deepseek(cf_country: str | None) -> bool:
    """True when the country code may be served by the DeepSeek chain.

    DeepSeek is allowed for any KNOWN country (a clean ISO alpha-2 code) that is
    not restricted and not on the DeepSeek blocklist. It is False for blocklisted
    countries (EU/EEA/UK), for missing/empty headers, and for unclassifiable
    values, so those always fall through to the compliant EU chain.
    """
    if not cf_country:
        return False
    code = cf_country.strip().upper()
    if len(code) != 2 or not code.isalpha():
        return False  # unclassifiable header -> compliant EU chain
    if code in _restricted():
        return False
    return code not in _deepseek_blocked()


def resolve_ai_chain(cf_country: str | None) -> tuple[str, list[str]]:
    """Resolve ``(primary_model, fallback_models)`` for a request's country.

    Raises ``RegionBlockedError`` for restricted countries. Known non-restricted
    countries not on the DeepSeek blocklist get the DeepSeek chain; blocklisted,
    missing and unknown countries get the EU chain (never DeepSeek). A deprecated
    single-model override (``prysm_ai_region_model``) pins the EU chain to that
    one model with no fallbacks.
    """
    if is_region_blocked(cf_country):
        raise RegionBlockedError(cf_country)

    if uses_deepseek(cf_country):
        chain = _deepseek_chain()
    else:
        chain = _eu_chain()
        if settings.prysm_ai_region_model:
            chain = [settings.prysm_ai_region_model]

    # Always land on a usable chain even if config was emptied: fall back to the
    # EU chain, then to a hardcoded safe pair so a misconfigured box never
    # routes to nothing (EU floor = cheapest verified compliant paid model).
    if not chain:
        chain = _eu_chain()
    if not chain:
        chain = ["thinkingmachines/inkling:free", "mistralai/mistral-small-3.2-24b-instruct"]

    return chain[0], chain[1:]
