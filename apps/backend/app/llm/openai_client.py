from typing import AsyncIterator

from openai import AsyncOpenAI

from app.llm.base import LLMClient, register_provider


@register_provider("openai")
class OpenAIClient(LLMClient):
    def __init__(self, api_key: str):
        self.client = AsyncOpenAI(api_key=api_key)

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        kwargs = dict(model="gpt-4o", messages=messages)
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        response = await self.client.chat.completions.create(**kwargs)
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
