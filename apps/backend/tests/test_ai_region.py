"""Regional compliance router for hosted PrysmAI (core).

Covers the country -> chain resolution guarantees: restricted countries are
denied with ``RegionBlockedError``, DeepSeek only ever serves explicitly
allowlisted countries (default: none), and anything else/missing/unknown gets the
global GDPR-safe chain. Parsing helpers are tested for trimming + defaults.
"""
import pytest

from app.config import settings
from app.services.ai_region import (
    RegionBlockedError,
    is_region_blocked,
    parse_chain,
    parse_country_list,
    resolve_ai_chain,
    uses_deepseek,
)


@pytest.fixture(autouse=True)
def _region_config():
    """Pin region routing config so tests are independent of the host .env."""
    original = {
        "region": settings.prysm_ai_region_model,
        "default": settings.prysm_ai_default_chain,
        "deepseek": settings.prysm_ai_deepseek_chain,
        "ds_countries": settings.prysm_ai_deepseek_countries,
        "restricted": settings.prysm_ai_restricted_countries,
    }
    settings.prysm_ai_region_model = ""
    settings.prysm_ai_default_chain = (
        "thinkingmachines/inkling:free,google/gemma-4-31b-it:free,thinkingmachines/inkling"
    )
    settings.prysm_ai_deepseek_chain = (
        "deepseek/deepseek-v4-flash-0731,thinkingmachines/inkling:free,thinkingmachines/inkling"
    )
    settings.prysm_ai_deepseek_countries = ""
    settings.prysm_ai_restricted_countries = "RU,BY"
    yield
    settings.prysm_ai_region_model = original["region"]
    settings.prysm_ai_default_chain = original["default"]
    settings.prysm_ai_deepseek_chain = original["deepseek"]
    settings.prysm_ai_deepseek_countries = original["ds_countries"]
    settings.prysm_ai_restricted_countries = original["restricted"]


class TestParseCountryList:
    def test_empty(self):
        assert parse_country_list("") == set()

    def test_trims_and_uppercases(self):
        assert parse_country_list(" ru, us,DE ") == {"RU", "US", "DE"}

    def test_drops_garbage(self):
        assert parse_country_list("russia, US") == {"US"}


class TestParseChain:
    def test_empty(self):
        assert parse_chain("") == []

    def test_splits_and_trims(self):
        assert parse_chain(" a , b ,c ") == ["a", "b", "c"]

    def test_drops_inner_empties(self):
        assert parse_chain("a, ,b") == ["a", "b"]


class TestResolveAiChain:
    def test_restricted_raises(self):
        with pytest.raises(RegionBlockedError):
            resolve_ai_chain("RU")
        with pytest.raises(RegionBlockedError):
            resolve_ai_chain("by")  # case-insensitive

    def test_non_restricted_uses_global_default_chain(self):
        primary, fallbacks = resolve_ai_chain("US")
        assert primary == "thinkingmachines/inkling:free"
        assert fallbacks == ["google/gemma-4-31b-it:free", "thinkingmachines/inkling"]
        assert "deepseek" not in [primary, *fallbacks]

    def test_missing_header_uses_global_default_chain(self):
        primary, fallbacks = resolve_ai_chain(None)
        assert primary == "thinkingmachines/inkling:free"
        assert "deepseek" not in [primary, *fallbacks]

    def test_unknown_country_uses_global_default_chain(self):
        primary, fallbacks = resolve_ai_chain("ZZ")
        assert primary == "thinkingmachines/inkling:free"

    def test_deepseek_only_on_allowlist(self):
        settings.prysm_ai_deepseek_countries = "IT"
        primary, fallbacks = resolve_ai_chain("IT")
        assert primary == "deepseek/deepseek-v4-flash-0731"
        assert "thinkingmachines/inkling" in fallbacks

    def test_deepseek_empty_allowlist_means_anyone_gets_default(self):
        primary, _ = resolve_ai_chain("IT")
        assert primary == "thinkingmachines/inkling:free"

    def test_region_model_override_pins_default_chain(self):
        settings.prysm_ai_region_model = "google/gemma-4-31b-it"
        primary, fallbacks = resolve_ai_chain("US")
        assert primary == "google/gemma-4-31b-it"
        assert fallbacks == []

    def test_region_model_override_never_applies_to_deepseek_path(self):
        settings.prysm_ai_region_model = "google/gemma-4-31b-it"
        settings.prysm_ai_deepseek_countries = "DE"
        primary, _ = resolve_ai_chain("DE")
        assert primary == "deepseek/deepseek-v4-flash-0731"


class TestHelpers:
    def test_is_region_blocked(self):
        assert is_region_blocked("RU") is True
        assert is_region_blocked("ru") is True
        assert is_region_blocked("US") is False
        assert is_region_blocked(None) is False
        assert is_region_blocked("") is False

    def test_uses_deepseek(self):
        settings.prysm_ai_deepseek_countries = "IT"
        assert uses_deepseek("IT") is True
        assert uses_deepseek("US") is False
        assert uses_deepseek(None) is False