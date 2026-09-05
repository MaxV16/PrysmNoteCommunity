from abc import ABC, abstractmethod
from typing import AsyncIterator


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
