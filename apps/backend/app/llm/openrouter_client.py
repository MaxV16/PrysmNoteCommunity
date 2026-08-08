from typing import AsyncIterator
from openai import AsyncOpenAI
from app.llm.base import LLMClient, register_provider

@register_provider("openrouter")
class OpenRouterClient(LLMClient):
    def __init__(self, api_key: str):
        self.client = AsyncOpenAI(
            api_key=api_key,
            base_url="https://openrouter.ai/api/v1"
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None, **overrides) -> dict:
        body = dict(model="google/gemini-2.0-flash-001", messages=messages)
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
        kwargs = dict(model="google/gemini-2.0-flash-001", messages=messages, stream=True)
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        
        stream = await self.client.chat.completions.create(**kwargs)
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content

    async def embed(self, text: str) -> list[float]:
        # OpenRouter support for embeddings varies by model. 
        # This is a placeholder or could be implemented if a specific embedding model is targeted.
        raise NotImplementedError("Embeddings not implemented for OpenRouter via this client.")
