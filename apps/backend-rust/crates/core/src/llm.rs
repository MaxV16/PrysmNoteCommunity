//! LLM provider adapters.
//!
//! Mirrors Python `app/llm/` (base + the five clients). Every provider is
//! reached over HTTP with `reqwest`; requests and responses use the
//! OpenAI-compatible chat shape so callers can treat them uniformly.
//!
//! A client is cheap to build and holds no background state; call [`LlmClient::new`]
//! for a BYOK provider or [`LlmClient::prysm_ai`] for the hosted gateway.

use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;

pub const OPENAI_MODEL: &str = "gpt-4o";
pub const OPENAI_EMBED_MODEL: &str = "text-embedding-3-small";
pub const GEMINI_MODEL: &str = "gemini-2.0-flash";
pub const GEMINI_EMBED_MODEL: &str = "text-embedding-004";
pub const DEEPSEEK_MODEL: &str = "deepseek-chat";
pub const DEEPSEEK_EMBED_MODEL: &str = "deepseek-embedding";
pub const OPENROUTER_DEFAULT_MODEL: &str = "deepseek/deepseek-v4-flash-0731";
pub const PRYSMAI_MODEL: &str = "thinkingmachines/inkling:free";

/// The four BYOK providers a user can store a key for.
pub const BYOK_PROVIDERS: [&str; 4] = ["openai", "gemini", "deepseek", "openrouter"];

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("unknown LLM provider: {0}")]
    UnknownProvider(String),
    #[error("embeddings are not available for provider {0}")]
    NoEmbeddings(String),
    #[error("request failed: {0}")]
    Request(String),
    #[error("invalid response: {0}")]
    Response(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenAI,
    Gemini,
    DeepSeek,
    OpenRouter,
    PrysmAi,
}

impl Provider {
    pub fn parse(name: &str) -> Option<Provider> {
        match name {
            "openai" => Some(Provider::OpenAI),
            "gemini" => Some(Provider::Gemini),
            "deepseek" => Some(Provider::DeepSeek),
            "openrouter" => Some(Provider::OpenRouter),
            "prysmai" => Some(Provider::PrysmAi),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::OpenAI => "openai",
            Provider::Gemini => "gemini",
            Provider::DeepSeek => "deepseek",
            Provider::OpenRouter => "openrouter",
            Provider::PrysmAi => "prysmai",
        }
    }

    /// Whether the provider can produce embeddings. The hosted gateway and
    /// OpenRouter proxy chat only, so embeddings there are unsupported.
    pub fn supports_embeddings(&self) -> bool {
        matches!(self, Provider::OpenAI | Provider::Gemini | Provider::DeepSeek)
    }

    fn base_url(&self) -> &'static str {
        match self {
            Provider::OpenAI => "https://api.openai.com/v1",
            Provider::DeepSeek => "https://api.deepseek.com",
            Provider::OpenRouter => "https://openrouter.ai/api/v1",
            Provider::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Provider::PrysmAi => "",
        }
    }
}

/// A configured provider client.
#[derive(Clone)]
pub struct LlmClient {
    provider: Provider,
    api_key: String,
    base_url: String,
    model: String,
    fallbacks: Vec<String>,
    zdr: bool,
    http: Client,
}

impl LlmClient {
    /// Build a BYOK client for a known provider with its default model.
    pub fn new(provider: &str, api_key: &str) -> Result<Self, LlmError> {
        let provider = Provider::parse(provider).ok_or_else(|| LlmError::UnknownProvider(provider.to_string()))?;
        let model = match provider {
            Provider::OpenAI => OPENAI_MODEL,
            Provider::Gemini => GEMINI_MODEL,
            Provider::DeepSeek => DEEPSEEK_MODEL,
            Provider::OpenRouter => OPENROUTER_DEFAULT_MODEL,
            Provider::PrysmAi => PRYSMAI_MODEL,
        }
        .to_string();
        let http = Client::builder()
            .timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| LlmError::Request(e.to_string()))?;
        Ok(Self {
            provider,
            api_key: api_key.to_string(),
            base_url: provider.base_url().to_string(),
            model,
            fallbacks: Vec::new(),
            zdr: true,
            http,
        })
    }

    /// Build the hosted gateway client with an optional model chain.
    pub fn prysm_ai(
        api_key: &str,
        base_url: &str,
        region_model: &str,
        fallbacks: Vec<String>,
        zdr: bool,
    ) -> Self {
        let model = if region_model.is_empty() {
            PRYSMAI_MODEL.to_string()
        } else {
            region_model.to_string()
        };
        let http = Client::builder()
            .timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self {
            provider: Provider::PrysmAi,
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
            model,
            fallbacks,
            zdr,
            http,
        }
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// The model this client targets (mirrors Python's `getattr(client, "model")`).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The first entry of an OpenAI-shaped response's `choices` array, or an
    /// empty object when there is none (mirrors `first_choice`).
    pub fn first_choice(payload: &Value) -> Value {
        payload
            .get("choices")
            .and_then(|choices| choices.as_array())
            .and_then(|choices| choices.first())
            .cloned()
            .unwrap_or_else(|| json!({}))
    }

    /// Non-streaming chat. Returns an OpenAI-shaped
    /// `{"choices":[{"message":{...}}]}` object.
    pub async fn chat(
        &self,
        messages: &Value,
        tools: Option<&Value>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
    ) -> Result<Value, LlmError> {
        if self.provider == Provider::Gemini {
            return self.gemini_chat(messages, tools, temperature, max_tokens).await;
        }
        let body = self.openai_body(messages, tools, temperature, max_tokens, false);
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Request(e.to_string()))?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|e| LlmError::Response(e.to_string()))?;
        if !status.is_success() {
            return Err(LlmError::Response(format!("HTTP {status}: {value}")));
        }
        Ok(value)
    }

    /// Streaming chat. Returns a channel that yields text deltas as they
    /// arrive; the receiver closes when the stream ends.
    pub async fn stream_chat(&self, messages: &Value) -> Result<mpsc::Receiver<String>, LlmError> {
        let body = self.openai_body(messages, None, None, None, true);
        let url = if self.provider == Provider::Gemini {
            format!(
                "{}/models/{}:streamGenerateContent?alt=sse&key={}",
                self.base_url.trim_end_matches('/'),
                self.model,
                self.api_key
            )
        } else {
            format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
        };
        let mut request = self.http.post(url).json(&body);
        if self.provider != Provider::Gemini {
            request = request.bearer_auth(&self.api_key).header("accept", "text/event-stream");
        }
        let response = request.send().await.map_err(|e| LlmError::Request(e.to_string()))?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(LlmError::Response(format!("HTTP {status}: {text}")));
        }

        let provider = self.provider;
        let (tx, rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                let Ok(bytes) = chunk else { break };
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(newline) = buffer.find('\n') {
                    let line = buffer[..newline].trim().to_string();
                    buffer.drain(..=newline);
                    let Some(payload) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let payload = payload.trim();
                    if payload.is_empty() || payload == "[DONE]" {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(payload) else {
                        continue;
                    };
                    if let Some(text) = extract_delta(provider, &value) {
                        if tx.send(text).await.is_err() {
                            return;
                        }
                    }
                }
            }
        });
        Ok(rx)
    }

    /// Embed `text` into a vector. Only OpenAI, Gemini and DeepSeek support it.
    pub async fn embed(&self, text: &str) -> Result<Vec<f32>, LlmError> {
        if !self.provider.supports_embeddings() {
            return Err(LlmError::NoEmbeddings(self.provider.as_str().to_string()));
        }
        if self.provider == Provider::Gemini {
            return self.gemini_embed(text).await;
        }
        let model = match self.provider {
            Provider::OpenAI => OPENAI_EMBED_MODEL,
            Provider::DeepSeek => DEEPSEEK_EMBED_MODEL,
            _ => OPENAI_EMBED_MODEL,
        };
        let url = format!("{}/embeddings", self.base_url.trim_end_matches('/'));
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&json!({ "model": model, "input": text }))
            .send()
            .await
            .map_err(|e| LlmError::Request(e.to_string()))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| LlmError::Response(e.to_string()))?;
        if !status.is_success() {
            return Err(LlmError::Response(format!("HTTP {status}: {value}")));
        }
        parse_embedding(&value)
    }

    /// Build the request body for OpenAI-compatible providers, and (when
    /// `provider == Gemini`) the Gemini wire body.
    fn openai_body(
        &self,
        messages: &Value,
        tools: Option<&Value>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
        stream: bool,
    ) -> Value {
        if self.provider == Provider::Gemini {
            return gemini_body(&self.model, messages, tools, temperature, max_tokens, stream);
        }
        let mut body = json!({ "model": self.model, "messages": messages });
        if self.provider == Provider::PrysmAi && !self.fallbacks.is_empty() {
            let mut models = vec![Value::String(self.model.clone())];
            models.extend(self.fallbacks.iter().cloned().map(Value::String));
            body["models"] = Value::Array(models);
        }
        if self.provider == Provider::PrysmAi && self.zdr {
            body["provider"] = json!({ "data_collection": "deny" });
        }
        if stream {
            body["stream"] = json!(true);
        }
        if let Some(tools) = tools {
            body["tools"] = tools.clone();
            body["tool_choice"] = json!("auto");
        }
        if let Some(t) = temperature {
            body["temperature"] = json!(t);
        }
        if let Some(m) = max_tokens {
            body["max_tokens"] = json!(m);
        }
        body
    }

    async fn gemini_chat(
        &self,
        messages: &Value,
        tools: Option<&Value>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
    ) -> Result<Value, LlmError> {
        let body = gemini_body(&self.model, messages, tools, temperature, max_tokens, false);
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            self.base_url.trim_end_matches('/'),
            self.model,
            self.api_key
        );
        let response = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Request(e.to_string()))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| LlmError::Response(e.to_string()))?;
        if !status.is_success() {
            return Err(LlmError::Response(format!("HTTP {status}: {value}")));
        }
        Ok(json!({ "choices": [{ "message": { "content": gemini_text(&value) } }] }))
    }

    async fn gemini_embed(&self, text: &str) -> Result<Vec<f32>, LlmError> {
        let url = format!(
            "{}/models/{}:embedContent?key={}",
            self.base_url.trim_end_matches('/'),
            GEMINI_EMBED_MODEL,
            self.api_key
        );
        let response = self
            .http
            .post(url)
            .json(&json!({ "content": { "parts": [{ "text": text }] } }))
            .send()
            .await
            .map_err(|e| LlmError::Request(e.to_string()))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| LlmError::Response(e.to_string()))?;
        if !status.is_success() {
            return Err(LlmError::Response(format!("HTTP {status}: {value}")));
        }
        let values = value
            .pointer("/embedding/values")
            .and_then(|v| v.as_array())
            .ok_or_else(|| LlmError::Response("missing embedding values".to_string()))?;
        Ok(values.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect())
    }
}

/// Pull a text delta out of one streamed SSE frame for the given provider.
fn extract_delta(provider: Provider, value: &Value) -> Option<String> {
    if provider == Provider::Gemini {
        let text = gemini_text(value);
        return if text.is_empty() { None } else { Some(text) };
    }
    let content = value.pointer("/choices/0/delta/content").and_then(|c| c.as_str());
    match content {
        Some(text) if !text.is_empty() => Some(text.to_string()),
        _ => None,
    }
}

fn gemini_text(value: &Value) -> String {
    value
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn gemini_body(
    model: &str,
    messages: &Value,
    tools: Option<&Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    stream: bool,
) -> Value {
    let mut contents = Vec::new();
    if let Value::Array(items) = messages {
        for message in items {
            let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            if role == "system" {
                continue;
            }
            let gemini_role = if role == "assistant" { "model" } else { "user" };
            let text = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
            contents.push(json!({ "role": gemini_role, "parts": [{ "text": text }] }));
        }
    }
    let mut body = json!({ "model": model, "contents": contents });
    if stream {
        // Gemini streams via the :streamGenerateContent endpoint, not a flag.
    }
    let mut generation = serde_json::Map::new();
    if let Some(t) = temperature {
        generation.insert("temperature".to_string(), json!(t));
    }
    if let Some(m) = max_tokens {
        generation.insert("maxOutputTokens".to_string(), json!(m));
    }
    if !generation.is_empty() {
        body["generationConfig"] = Value::Object(generation);
    }
    if let Some(tools) = tools {
        if let Some(declarations) = gemini_tools(tools) {
            body["tools"] = json!([{ "functionDeclarations": declarations }]);
        }
    }
    body
}

fn gemini_tools(tools: &Value) -> Option<Vec<Value>> {
    let array = tools.as_array()?;
    let declarations: Vec<Value> = array
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            let name = function.get("name")?.clone();
            let description = function
                .get("description")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
            let parameters = function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({ "name": name, "description": description, "parameters": parameters }))
        })
        .collect();
    if declarations.is_empty() {
        None
    } else {
        Some(declarations)
    }
}

fn parse_embedding(value: &Value) -> Result<Vec<f32>, LlmError> {
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|d| d.first())
        .and_then(|d| d.get("embedding"))
        .and_then(|e| e.as_array())
        .ok_or_else(|| LlmError::Response("missing embedding".to_string()))?;
    Ok(data.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_providers_parse_and_round_trip() {
        for name in BYOK_PROVIDERS {
            let provider = Provider::parse(name).unwrap();
            assert_eq!(provider.as_str(), name);
        }
        assert!(Provider::parse("anthropic").is_none());
    }

    #[test]
    fn unknown_provider_is_rejected() {
        assert!(matches!(LlmClient::new("nope", "key"), Err(LlmError::UnknownProvider(_))));
    }

    #[test]
    fn openrouter_and_gateway_cannot_embed() {
        assert!(!Provider::OpenRouter.supports_embeddings());
        assert!(!Provider::PrysmAi.supports_embeddings());
        assert!(Provider::OpenAI.supports_embeddings());
    }

    #[test]
    fn gemini_body_maps_roles_and_builds_tools() {
        let messages = json!([
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "yo"},
        ]);
        let tools = json!([{ "type": "function", "function": { "name": "f", "description": "d", "parameters": {"type":"object","properties":{}} } }]);
        let body = gemini_body("gemini-2.0-flash", &messages, Some(&tools), Some(0.5), Some(100), false);
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(body["generationConfig"]["temperature"], 0.5);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "f");
    }

    #[test]
    fn gateway_body_adds_fallbacks_and_zdr() {
        let client = LlmClient::prysm_ai("k", "https://example.test/v1", "", vec!["m2".into()], true);
        let body = client.openai_body(&json!([]), None, None, None, false);
        assert_eq!(body["model"], PRYSMAI_MODEL);
        assert_eq!(body["models"][1], "m2");
        assert_eq!(body["provider"]["data_collection"], "deny");
    }
}
