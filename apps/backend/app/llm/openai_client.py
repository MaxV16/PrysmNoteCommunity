from typing import AsyncIterator

import httpx
from openai import AsyncOpenAI

from app.llm.base import LLMClient, register_provider


@register_provider("openai")
class OpenAIClient(LLMClient):
    def __init__(self, api_key: str):
        # Explicit bounded timeout: agentic tool loops make several round-trips,
        # but a hung provider must surface an error and close the stream rather
        # than leave the chat "loading" for the SDK's ~10-minute default.
        self.client = AsyncOpenAI(
            api_key=api_key,
            timeout=httpx.Timeout(90.0, connect=15.0),
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None, **overrides) -> dict:
        body = dict(model="gpt-4o", messages=messages)
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        temperature = overrides.get("temperature")
        if temperature is not None:
            body["temperature"] = temperature
        max_tokens = overrides.get("max_tokens")
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        response = await self.client.chat.completions.create(**body)
        return response.model_dump()

    async def stream_chat(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[str]:
        kwargs = dict(model="gpt-4o", messages=messages, stream=True)
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        stream = await self.client.chat.completions.create(**kwargs)
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content

    async def embed(self, text: str) -> list[float]:
        response = await self.client.embeddings.create(model="text-embedding-3-small", input=text)
        return response.data[0].embedding
