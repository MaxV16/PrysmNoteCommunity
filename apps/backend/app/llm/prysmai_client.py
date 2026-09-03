"""PrysmAI - the hosted DeepSeek provider (v4-flash).

Used when a user's plan/trial entitles them to hosted AI instead of bringing
their own key. Sends against DeepSeek's OpenAI-format endpoint with the
``deepseek-v4-flash`` model. The server-side API key is resolved in the router
(never exposed to the client); usage is recorded by the AI entitlement service so
per-plan token allowances can be enforced.
"""
import json
from typing import AsyncIterator

import httpx

from app.llm.base import LLMClient, register_provider

MODEL = "deepseek-v4-flash"
BASE_URL = "https://api.deepseek.com"


@register_provider("prysmai")
class PrysmAIClient(LLMClient):
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.client = httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=httpx.Timeout(90.0, connect=10.0),
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None, **overrides) -> dict:
        body = dict(model=MODEL, messages=messages)
        if tools:
            body["tools"] = tools
        temperature = overrides.get("temperature")
        if temperature is not None:
            body["temperature"] = temperature
        max_tokens = overrides.get("max_tokens")
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        response = await self.client.post(
            "/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
        )
        return response.json()

    async def stream_chat(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[str]:
        body = dict(model=MODEL, messages=messages, stream=True)
        if tools:
            body["tools"] = tools
        async with self.client.stream(
            "POST",
            "/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("data: ") and line != "data: [DONE]":
                    try:
                        chunk = json.loads(line[6:])
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                    except json.JSONDecodeError:
                        continue

    async def embed(self, text: str) -> list[float]:
        response = await self.client.post(
            "/embeddings",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={"model": "deepseek-embedding", "input": text},
        )
        data = response.json()
        return data["data"][0]["embedding"]

    async def aclose(self) -> None:
        await self.client.aclose()
