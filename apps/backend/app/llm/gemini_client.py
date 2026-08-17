from typing import AsyncIterator

from google import genai
from google.genai import types

from app.llm.base import LLMClient, register_provider


@register_provider("gemini")
class GeminiClient(LLMClient):
    def __init__(self, api_key: str):
        self.client = genai.aio.Client(api_key=api_key)

    def _convert_messages(self, messages: list[dict]) -> list[types.Content]:
        contents = []
        for msg in messages:
            role = "user"
            if msg.get("role") == "assistant":
                role = "model"
            elif msg.get("role") == "system":
                continue
            contents.append(types.Content(role=role, parts=[types.Part(text=msg["content"])]))
        return contents

    def _convert_tools(self, tools: list[dict] | None) -> list[types.Tool] | None:
        if not tools:
            return None
        converted = []
        for tool in tools:
            func = tool.get("function", {})
            converted.append(types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name=func["name"],
                    description=func.get("description", ""),
                    parameters=func.get("parameters"),
                )
            ]))
        return converted or None

    async def chat(self, messages: list[dict], tools: list[dict] | None = None, **overrides) -> dict:
        contents = self._convert_messages(messages)
        config_kwargs = {}
        gemini_tools = self._convert_tools(tools)
        if gemini_tools:
            config_kwargs["tools"] = gemini_tools
        temperature = overrides.get("temperature")
        if temperature is not None:
            config_kwargs["temperature"] = temperature
        max_tokens = overrides.get("max_tokens")
        if max_tokens is not None:
            config_kwargs["max_output_tokens"] = max_tokens
        response = await self.client.models.generate_content(
            model="gemini-2.0-flash",
            contents=contents,
            config=types.GenerateContentConfig(**config_kwargs),
        )
        return {"choices": [{"message": {"content": response.text or ""}}]}

    async def stream_chat(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[str]:
        contents = self._convert_messages(messages)
        config_kwargs = {}
        gemini_tools = self._convert_tools(tools)
        if gemini_tools:
            config_kwargs["tools"] = gemini_tools
        response = await self.client.models.generate_content_stream(
            model="gemini-2.0-flash",
            contents=contents,
            config=types.GenerateContentConfig(**config_kwargs),
        )
        async for chunk in response:
            if chunk.text:
                yield chunk.text

    async def embed(self, text: str) -> list[float]:
        result = await self.client.models.embed_content(
            model="text-embedding-004",
            contents=text,
        )
        return result.embeddings[0].values
