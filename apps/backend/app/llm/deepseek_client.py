import json
from typing import AsyncIterator

import httpx

from app.llm.base import LLMClient, register_provider


@register_provider("deepseek")
class DeepSeekClient(LLMClient):
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://api.deepseek.com/v1"
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        body = dict(model="deepseek-chat", messages=messages)
        if tools:
            body["tools"] = tools
        response = await self.client.post(
            "/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
        )
        return response.json()

    async def stream_chat(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[str]:
        body = dict(model="deepseek-chat", messages=messages, stream=True)
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
