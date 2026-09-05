from abc import ABC, abstractmethod
from typing import AsyncIterator


def first_choice(payload: dict) -> dict:
    """Return the first ``choices`` entry from an OpenAI-style payload, or ``{}``.

    The ``dict.get("choices", [{}])`` pattern only guards a MISSING key, but
    providers (OpenRouter, reasoning/free-tier models, cap responses) can return
    a present-but-EMPTY ``"choices": []`` array, which would raise an IndexError
    on ``[0]``. Never trust the shape of a third-party payload.
    """
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        return {}
    return choices[0] if isinstance(choices[0], dict) else {}


class LLMClient(ABC):
    @abstractmethod
    async def chat(self, messages: list[dict], tools: list[dict] | None = None, **kwargs) -> dict:
        pass

    @abstractmethod
    async def stream_chat(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[str]:
        pass

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        pass

    async def aclose(self) -> None:
        """Release the underlying HTTP client, if any. No-op by default so
        providers that hold no pooled connection can skip the override."""
        pass


_providers: dict[str, type[LLMClient]] = {}


def register_provider(name: str):
    def decorator(cls: type[LLMClient]):
        _providers[name] = cls
        return cls
    return decorator


def get_provider(name: str, api_key: str, **kwargs) -> LLMClient:
    cls = _providers.get(name)
    if cls is None:
        raise ValueError(f"Unknown LLM provider: {name}")
    return cls(api_key=api_key, **kwargs)


def list_providers() -> list[str]:
    return list(_providers.keys())
