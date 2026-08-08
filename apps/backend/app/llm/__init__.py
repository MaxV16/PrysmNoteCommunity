from app.llm.base import LLMClient, get_provider, list_providers, register_provider

# Import the provider implementations so their @register_provider decorators run
# at package import time, making them available to get_provider().
from app.llm import deepseek_client  # noqa: F401  (registers "deepseek")
from app.llm import gemini_client  # noqa: F401   (registers "gemini")
from app.llm import openai_client  # noqa: F401   (registers "openai")
from app.llm import openrouter_client  # noqa: F401   (registers "openrouter")

__all__ = ["LLMClient", "get_provider", "list_providers", "register_provider"]
