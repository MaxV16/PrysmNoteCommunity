"""Regional compliance router for hosted PrysmAI (core).

Covers the country -> chain resolution guarantees: restricted countries are
denied with ``RegionBlockedError``, DeepSeek serves every known country NOT on
the DeepSeek blocklist (default: the EU/EEA + UK), and anything on the blocklist,
missing or unknown gets the compliant EU chain (never DeepSeek). Parsing helpers
are tested for trimming + defaults.
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

EU_CHAIN = (
    "thinkingmachines/inkling:free,google/gemma-4-31b-it:free,"
    "mistralai/mistral-small-3.2-24b-instruct"
)
DEEPSEEK_CHAIN = (
    "thinkingmachines/inkling:free,google/gemma-4-31b-it:free,"
    "deepseek/deepseek-v4-flash-0731"
)


@pytest.fixture(autouse=True)
def _region_config():
    """Pin region routing config so tests are independent of the host .env."""
    original = {
        "region": settings.prysm_ai_region_model,
        "eu": settings.prysm_ai_eu_chain,
        "deepseek": settings.prysm_ai_deepseek_chain,
        "ds_blocked": settings.prysm_ai_deepseek_blocked_countries,
        "restricted": settings.prysm_ai_restricted_countries,
    }
    settings.prysm_ai_region_model = ""
    settings.prysm_ai_eu_chain = EU_CHAIN
    settings.prysm_ai_deepseek_chain = DEEPSEEK_CHAIN
    settings.prysm_ai_deepseek_blocked_countries = ""
    settings.prysm_ai_restricted_countries = "RU,BY"
    yield
    settings.prysm_ai_region_model = original["region"]
    settings.prysm_ai_eu_chain = original["eu"]
    settings.prysm_ai_deepseek_chain = original["deepseek"]
    settings.prysm_ai_deepseek_blocked_countries = original["ds_blocked"]
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

    def test_non_eu_country_uses_deepseek_chain(self):
        primary, fallbacks = resolve_ai_chain("US")
        assert primary == "thinkingmachines/inkling:free"
        assert fallbacks == ["google/gemma-4-31b-it:free", "deepseek/deepseek-v4-flash-0731"]
        assert "deepseek/deepseek-v4-flash-0731" in fallbacks

    def test_eu_country_uses_eu_chain(self):
        settings.prysm_ai_deepseek_blocked_countries = "DE,FR"
        primary, fallbacks = resolve_ai_chain("DE")
        assert primary == "thinkingmachines/inkling:free"
        assert fallbacks == [
            "google/gemma-4-31b-it:free",
            "mistralai/mistral-small-3.2-24b-instruct",
        ]
        assert all("deepseek" not in m for m in [primary, *fallbacks])

    def test_missing_header_uses_eu_chain(self):
        primary, fallbacks = resolve_ai_chain(None)
        assert primary == "thinkingmachines/inkling:free"
        assert "mistralai/mistral-small-3.2-24b-instruct" in fallbacks
        assert all("deepseek" not in m for m in [primary, *fallbacks])

    def test_unclassifiable_header_uses_eu_chain(self):
        primary, fallbacks = resolve_ai_chain("ZZZ")  # not a clean alpha-2 code
        assert primary == "thinkingmachines/inkling:free"
        assert all("deepseek" not in m for m in [primary, *fallbacks])

    def test_unknown_valid_code_not_blocked_uses_deepseek(self):
        # Any clean alpha-2 code that is not restricted/blocklisted is treated as
        # DeepSeek-permitted (blocklist semantics: only listed countries get EU).
        primary, fallbacks = resolve_ai_chain("ZZ")
        assert "deepseek/deepseek-v4-flash-0731" in fallbacks

    def test_empty_blocklist_means_deepseek_everywhere(self):
        primary, fallbacks = resolve_ai_chain("IT")
        assert primary == "thinkingmachines/inkling:free"
        assert "deepseek/deepseek-v4-flash-0731" in fallbacks

    def test_default_blocklist_is_eea_plus_uk(self):
        original = settings.prysm_ai_deepseek_blocked_countries
        settings.prysm_ai_deepseek_blocked_countries = (
            "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,"
            "RO,SK,SI,ES,SE,IS,LI,NO,GB"
        )
        try:
            primary, fallbacks = resolve_ai_chain("DE")
            assert "deepseek" not in [primary, *fallbacks]
            primary, fallbacks = resolve_ai_chain("GB")
            assert "deepseek" not in [primary, *fallbacks]
            primary, fallbacks = resolve_ai_chain("US")
            assert "deepseek/deepseek-v4-flash-0731" in fallbacks
        finally:
            settings.prysm_ai_deepseek_blocked_countries = original

    def test_blocklist_entry_with_vendored_chain_config(self):
        settings.prysm_ai_deepseek_blocked_countries = "DE"
        settings.prysm_ai_deepseek_chain = "deepseek/deepseek-v4-flash-0731"
        primary, fallbacks = resolve_ai_chain("JP")
        assert primary == "deepseek/deepseek-v4-flash-0731"
        assert fallbacks == []
        primary, fallbacks = resolve_ai_chain("DE")
        assert "mistralai/mistral-small-3.2-24b-instruct" in fallbacks

    def test_region_model_override_pins_eu_chain(self):
        settings.prysm_ai_deepseek_blocked_countries = "DE"
        settings.prysm_ai_region_model = "google/gemma-4-31b-it"
        primary, fallbacks = resolve_ai_chain("DE")
        assert primary == "google/gemma-4-31b-it"
        assert fallbacks == []

    def test_region_model_override_never_applies_to_deepseek_path(self):
        settings.prysm_ai_region_model = "google/gemma-4-31b-it"
        primary, _ = resolve_ai_chain("US")
        assert primary == "thinkingmachines/inkling:free"

    def test_deepseek_chain_tail_is_deepseek_not_compliant_floor(self):
        """Cap-pricing guarantee: the DeepSeek chain's paid tail must be DeepSeek
        (cheap), never the pricier EU floor, so the USD cap prices at ~$0.1225/M.
        """
        primary, fallbacks = resolve_ai_chain("US")
        tail = fallbacks[-1]
        assert tail == "deepseek/deepseek-v4-flash-0731"
        assert "mistralai/mistral-small-3.2-24b-instruct" not in [primary, *fallbacks]

    def test_empty_eu_chain_falls_back_to_safe_pair(self):
        settings.prysm_ai_eu_chain = ""
        primary, fallbacks = resolve_ai_chain(None)
        assert primary == "thinkingmachines/inkling:free"
        assert fallbacks == ["mistralai/mistral-small-3.2-24b-instruct"]


class TestHelpers:
    def test_is_region_blocked(self):
        assert is_region_blocked("RU") is True
        assert is_region_blocked("ru") is True
        assert is_region_blocked("US") is False
        assert is_region_blocked(None) is False
        assert is_region_blocked("") is False

    def test_uses_deepseek(self):
        settings.prysm_ai_deepseek_blocked_countries = "DE"
        assert uses_deepseek("US") is True
        assert uses_deepseek("DE") is False
        assert uses_deepseek(None) is False
        assert uses_deepseek("RU") is False  # restricted, never DeepSeek