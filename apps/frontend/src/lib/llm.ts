export type LLMProvider = "openai" | "gemini" | "deepseek";

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionDelta {
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

const API_URLS: Record<LLMProvider, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
};

const LOCAL_KEY_PREFIX = "prysm_key_";

export function getLocalApiKey(provider: LLMProvider): string | null {
  if (typeof window === "undefined") return null;
  const encoded = localStorage.getItem(`${LOCAL_KEY_PREFIX}${provider}`);
  if (!encoded) return null;
  try {
    return decodeURIComponent(
      atob(encoded)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
  } catch {
    return null;
  }
}

export function hasLocalKey(provider: LLMProvider): boolean {
  return getLocalApiKey(provider) !== null;
}

async function openAIStream(
  apiKey: string,
  messages: Array<{ role: string; content: string; tool_calls?: ToolCall[] }>,
  tools: Array<unknown> | undefined,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const body: Record<string, unknown> = {
    model: "gpt-4o",
    messages,
    stream: true,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(API_URLS.openai, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI error ${res.status}`);
  }

  return res.body!;
}

async function geminiStream(
  apiKey: string,
  messages: Array<{ role: string; content: string; tool_calls?: ToolCall[] }>,
  tools: Array<unknown> | undefined,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
  };

  if (tools) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const url = `${API_URLS.gemini}?alt=sse&key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini error ${res.status}`);
  }

  return res.body!;
}

async function deepseekStream(
  apiKey: string,
  messages: Array<{ role: string; content: string; tool_calls?: ToolCall[] }>,
  tools: Array<unknown> | undefined,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const body: Record<string, unknown> = {
    model: "deepseek-chat",
    messages,
    stream: true,
  };
  if (tools) body.tools = tools;

  const res = await fetch(API_URLS.deepseek, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `DeepSeek error ${res.status}`);
  }

  return res.body!;
}

export function streamChat(
  provider: LLMProvider,
  messages: Array<{ role: string; content: string; tool_calls?: ToolCall[] }>,
  tools?: Array<unknown>,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = getLocalApiKey(provider);
  if (!apiKey) {
    throw new Error(`No local API key for ${provider}`);
  }

  const abortController = signal || new AbortController().signal;

  switch (provider) {
    case "openai":
      return openAIStream(apiKey, messages, tools, abortController);
    case "gemini":
      return geminiStream(apiKey, messages, tools, abortController);
    case "deepseek":
      return deepseekStream(apiKey, messages, tools, abortController);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function chat(
  provider: LLMProvider,
  messages: Array<{ role: string; content: string; tool_calls?: ToolCall[] }>,
  tools?: Array<unknown>
): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const apiKey = getLocalApiKey(provider);
  if (!apiKey) {
    throw new Error(`No local API key for ${provider}`);
  }

  const body: Record<string, unknown> = {
    model: provider === "openai" ? "gpt-4o" : provider === "deepseek" ? "deepseek-chat" : "gemini-2.0-flash",
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let url: string;
  let headers: Record<string, string>;

  if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    headers = { "Content-Type": "application/json" };
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    body.contents = contents;
    delete body.messages;
    delete body.model;
  } else {
    url = provider === "openai" ? API_URLS.openai : API_URLS.deepseek;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `${provider} error ${res.status}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0] ?? data.candidates?.[0];
  const content = choice?.message?.content ?? choice?.content?.parts?.[0]?.text ?? "";

  return { content, tool_calls: choice?.message?.tool_calls };
}
