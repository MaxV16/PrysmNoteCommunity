"""PrysmAI - the hosted provider routed through OpenRouter (GDPR-safe by default).

Used when a user's plan/trial entitles them to hosted AI instead of bringing
their own key. Talks to the OpenAI-compatible endpoint configured by
``settings.prysm_ai_base_url`` (OpenRouter by default) with a per-user sub-key
created by the EE key service (community build: the legacy server key).

The default model chain never contains a Chinese-origin provider (DeepSeek/GLM/
MiniMax/inclusionAI are excluded by default), a ``models`` array gives ordered
fallbacks on OpenRouter congestion/free-tier caps, and ZDR routing
(``provider.data_collection="deny"``) is enforced so no prompt/completion is
stored or trained on. The server-side key is resolved in the router (never
exposed to the client); usage is recorded by the AI entitlement service so
per-plan token allowances can be enforced.
"""
import json
from typing import AsyncIterator

import httpx

from app.config import settings
from app.llm.base import LLMClient, register_provider

# Fallback model if every configured chain is empty (kept for back-compat).
MODEL = "thinkingmachines/inkling:free"


@register_provider("prysmai")
class PrysmAIClient(LLMClient):
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        model: str | None = None,
        fallbacks: tuple | list = (),
        zdr: bool = True,
    ):
        self.api_key = api_key
        self.model = model or settings.prysm_ai_region_model or MODEL
        self.fallbacks = list(fallbacks or ())
        self.zdr = zdr
        self.client = httpx.AsyncClient(
            base_url=base_url or settings.prysm_ai_base_url,
            timeout=httpx.Timeout(90.0, connect=10.0),
        )

    def _body(self, messages: list[dict], tools: list[dict] | None = None, stream: bool = False, **overrides) -> dict:
        body = dict(model=self.model, messages=messages)
        if stream:
            body["stream"] = True
        # Ordered fallback chain: OpenRouter walks ``models`` on 429/downtime/
        # moderation/context errors and bills only the model that served.
        if self.fallbacks:
            body["models"] = [self.model, *self.fallbacks]
        # Zero-Data-Retention routing: only route to providers that deny data
        # collection (best-effort; not every provider on OpenRouter honors it).
        if self.zdr:
            body["provider"] = {"data_collection": "deny"}
        if tools:
            body["tools"] = tools
        temperature = overrides.get("temperature")
        if temperature is not None:
            body["temperature"] = temperature
        max_tokens = overrides.get("max_tokens")
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        return body

    async def chat(self, messages: list[dict], tools: list[dict] | None = None, **overrides) -> dict:
        body = self._body(messages, tools=tools, **overrides)
        response = await self.client.post(
            "/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
        )
        return response.json()

    async def stream_chat(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[str]:
        body = self._body(messages, tools=tools, stream=True)
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
                    except json.JSONDecodeError:
                        continue
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    # Only the visible answer text is yielded. Reasoning/thinking
                    # deltas carry ``message.reasoning`` or an empty ``content``
                    # ("") and must be skipped so reasoning models stream the
                    # final answer (a null content is also falsy, so this is safe).
                    content = delta.get("content")
                    if content:
                        yield content

    async def embed(self, text: str) -> list[float]:
        # Hosted PrysmAI embeddings are not reachable in practice: embeddings
        # flow through user BYOK keys in embedding_service.py.
        raise NotImplementedError("Embeddings are not available for the hosted PrysmAI provider.")

    async def aclose(self) -> None:
        await self.client.aclose()