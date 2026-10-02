//! Background turn runner for AI chat (Unit B of the Rust port).
//!
//! Mirrors Python `apps/backend/app/services/ai_turn_runner.py`: one AI turn per
//! account, launched as an in-process task so a client disconnect does not kill
//! it. The SSE endpoint drains the job's event channel; a new message while a
//! turn is running gets HTTP 409. Persisted rows survive a process restart, so
//! the user can simply re-ask.
//!
//! RLS RULE: `app.user_id` is transaction-scoped. Every piece of work opens its
//! own transaction through [`begin_tx`], which re-applies `db::set_rls_user`
//! before any query. No transaction is ever held across a provider HTTP call, so
//! a fresh pooled connection always gets the RLS context it needs (the Rust
//! equivalent of Python's `commit_and_reapply_rls` helpers).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use sqlx::PgConnection;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::llm::{LlmClient, LlmError};
use crate::{
    ai_cache, ai_conversation, ai_entitlement, ai_execute, ai_prompt, ai_prompts, ai_text,
    ai_tools, db, memory_service, AppState,
};

/// Maximum tool rounds per turn (mirrors Python `MAX_TOOL_ROUNDS`).
pub const MAX_TOOL_ROUNDS: usize = 4;
/// Maximum model bumps/retries (mirrors Python `MAX_RETRY_BUMPS`).
pub const MAX_RETRY_BUMPS: usize = 2;
/// Cap on the human "applied actions" summary length.
const APPLIED_LINE_CAP: usize = 6;
/// SSE text chunk size (mirrors Python `_chunk_text` default).
const CHUNK_SIZE: usize = 400;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// One event emitted by a running turn, in the order the SSE endpoint relays it.
#[derive(Debug, Clone)]
pub enum TurnEvent {
    Token(String),
    ToolStart(Value),
    ToolResults(Vec<String>),
    Usage(Value),
    Error(String),
    Done,
}

// ---------------------------------------------------------------------------
// Job + registry
// ---------------------------------------------------------------------------

/// A single in-flight turn for one account.
pub struct TurnJob {
    /// Owning user.
    pub user_id: Uuid,
    /// Chat session id (client supplied or freshly generated).
    pub session_id: Uuid,
    /// Provider name (`openai`, `gemini`, `deepseek`, `openrouter`, `prysmai`).
    pub provider: String,
    /// Resolved API key for the provider.
    pub api_key: String,
    /// Hosted model chain (empty for BYOK).
    pub chain: Vec<String>,
    /// Sanitized prior turns.
    pub sanitized_history: Vec<Value>,
    /// The new user message.
    pub user_message: String,
    /// Optional client context block.
    pub context: Option<Value>,
    phase: Mutex<String>,
    status: Mutex<String>,
    cancel_requested: AtomicBool,
    applied_actions: Mutex<Vec<String>>,
    tx: mpsc::UnboundedSender<TurnEvent>,
    rx: Mutex<Option<mpsc::UnboundedReceiver<TurnEvent>>>,
}

impl TurnJob {
    /// Push one event to the SSE consumer (best-effort).
    pub fn send(&self, event: TurnEvent) {
        let _ = self.tx.send(event);
    }

    /// Take the event receiver (single consumer; the SSE handler owns it).
    pub fn take_events(&self) -> Option<mpsc::UnboundedReceiver<TurnEvent>> {
        self.rx.lock().ok().and_then(|mut guard| guard.take())
    }

    /// Current phase (`tools` | `final` | `done`).
    pub fn phase(&self) -> String {
        self.phase.lock().map(|g| g.clone()).unwrap_or_default()
    }

    fn set_phase(&self, value: &str) {
        if let Ok(mut guard) = self.phase.lock() {
            *guard = value.to_string();
        }
    }

    /// Ask the turn to stop at the next round boundary.
    pub fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancel_requested.load(Ordering::SeqCst)
    }

    fn applied(&self) -> Vec<String> {
        self.applied_actions
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    fn add_applied(&self, lines: Vec<String>) {
        if let Ok(mut guard) = self.applied_actions.lock() {
            for line in lines {
                if !guard.contains(&line) {
                    guard.push(line);
                }
            }
            if guard.len() > APPLIED_LINE_CAP {
                let overflow = guard.len() - APPLIED_LINE_CAP;
                guard.drain(0..overflow);
            }
        }
    }
}

/// Removes a job from the registry even if the runner panics (Drop runs during
/// unwind), so a crashed task can never leave a dangling 409 or a hung SSE.
struct Cleanup(Uuid);

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut map) = turns().lock() {
            map.remove(&self.0);
        }
    }
}

fn turns() -> &'static Mutex<HashMap<Uuid, Arc<TurnJob>>> {
    static TURNS: OnceLock<Mutex<HashMap<Uuid, Arc<TurnJob>>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The active turn for a user, if any.
pub fn get_active_turn(user_id: Uuid) -> Option<Arc<TurnJob>> {
    turns().lock().ok().and_then(|map| map.get(&user_id).cloned())
}

/// Request cancellation of the active turn. Returns false when none is running.
pub fn cancel_turn(user_id: Uuid) -> bool {
    match get_active_turn(user_id) {
        Some(job) => {
            job.request_cancel();
            true
        }
        None => false,
    }
}

/// Parameters for a new turn.
pub struct TurnParams {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub provider: String,
    pub api_key: String,
    pub chain: Vec<String>,
    pub sanitized_history: Vec<Value>,
    pub user_message: String,
    pub context: Option<Value>,
}

/// Register and launch a background turn, or return `None` when the user
/// already has an active turn (the caller must reply 409).
pub fn start_turn(state: AppState, params: TurnParams) -> Option<Arc<TurnJob>> {
    let mut map = match turns().lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    if map.contains_key(&params.user_id) {
        return None;
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let job = Arc::new(TurnJob {
        user_id: params.user_id,
        session_id: params.session_id,
        provider: params.provider,
        api_key: params.api_key,
        chain: params.chain,
        sanitized_history: params.sanitized_history,
        user_message: params.user_message,
        context: params.context,
        phase: Mutex::new("tools".to_string()),
        status: Mutex::new("running".to_string()),
        cancel_requested: AtomicBool::new(false),
        applied_actions: Mutex::new(Vec::new()),
        tx,
        rx: Mutex::new(Some(rx)),
    });
    map.insert(params.user_id, job.clone());
    drop(map);

    let task_job = job.clone();
    tokio::spawn(async move {
        run_turn(state, task_job).await;
    });
    Some(job)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) enum RunnerError {
    Llm(LlmError),
    Db(sqlx::Error),
}

impl RunnerError {
    /// Map a runner failure to the same HTTP shape Python's chat endpoint uses
    /// (provider errors -> 502 with a safe, friendly message).
    pub(crate) fn into_api_error(self, provider: &str) -> crate::error::ApiError {
        match self {
            RunnerError::Llm(err) => {
                crate::error::ApiError::BadGateway(friendly_llm_error(&err, provider))
            }
            RunnerError::Db(err) => {
                crate::error::ApiError::Internal(format!("database error: {err}"))
            }
        }
    }
}

impl From<sqlx::Error> for RunnerError {
    fn from(err: sqlx::Error) -> Self {
        RunnerError::Db(err)
    }
}

impl From<LlmError> for RunnerError {
    fn from(err: LlmError) -> Self {
        RunnerError::Llm(err)
    }
}

/// Open a transaction with the caller's transaction-scoped RLS identity set.
async fn begin_tx<'a>(
    state: &'a AppState,
    user_id: Uuid,
) -> Result<sqlx::Transaction<'a, sqlx::Postgres>, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    db::set_rls_user(&mut *tx, user_id, "").await?;
    Ok(tx)
}

async fn run_turn(state: AppState, job: Arc<TurnJob>) {
    let user_id = job.user_id;
    let _cleanup = Cleanup(user_id);

    match run_turn_inner(&state, &job).await {
        Ok(()) => {}
        Err(err) => {
            let text = match &err {
                RunnerError::Llm(llm) => {
                    tracing::warn!(user = %user_id, error = %llm, "turn provider error");
                    friendly_llm_error(llm, &job.provider)
                }
                RunnerError::Db(db) => {
                    tracing::warn!(user = %user_id, error = %db, "turn database error");
                    "An unexpected error occurred.".to_string()
                }
            };
            persist_error(&state, &job, &text).await;
            job.send(TurnEvent::Error(text));
        }
    }

    job.set_phase("done");
    if let Ok(mut status) = job.status.lock() {
        if *status == "running" {
            *status = "done".to_string();
        }
    }
    job.send(TurnEvent::Done);
}

async fn run_turn_inner(state: &AppState, job: &Arc<TurnJob>) -> Result<(), RunnerError> {
    let user_id = job.user_id;

    // 1. Load the rolling summary + recalled memories.
    let (current_summary, memories) = {
        let mut tx = begin_tx(state, user_id).await?;
        let summary =
            ai_conversation::get_summary(&mut *tx, user_id, job.session_id).await?;
        let memories =
            memory_service::retrieve_relevant_memories(&mut *tx, user_id, &job.user_message)
                .await
                .unwrap_or_default();
        tx.commit().await?;
        (summary, memories)
    };

    let premium = ai_tools::is_premium();
    let tools = Value::Array(ai_tools::tools_for_user(premium));
    let mut messages = ai_prompt::build_messages(
        &job.sanitized_history,
        &job.user_message,
        job.context.as_ref(),
        current_summary.as_deref(),
        Some(&memories),
        premium,
    );

    // 2. Persist the user message before any provider call.
    {
        let mut tx = begin_tx(state, user_id).await?;
        ai_conversation::insert_conversation(
            &mut *tx,
            user_id,
            job.session_id,
            "user",
            &job.user_message,
            None,
        )
        .await?;
        tx.commit().await?;
    }

    // 3. Tool-round loop.
    let mut client = build_turn_client(state, job, 0)?;
    let mut content = String::new();
    let mut tool_calls: Option<Value> = None;
    // True once a mutating tool call actually committed (a payload with no
    // error). Only then may the model narrate the action as done; a failed or
    // read-only tool call must not let a hallucinated success slip through.
    let mut action_succeeded = false;
    let mut money_nudged = false;
    let mut tool_nudged = false;
    let mut current_model_index = 0usize;

    for round in 0..MAX_TOOL_ROUNDS {
        if job.cancelled() {
            finish_cancelled(state, job).await;
            return Ok(());
        }

        let model = job.chain.get(current_model_index).cloned();
        let response = chat_with_cache(
            state,
            user_id,
            &job.provider,
            &client,
            &messages,
            Some(&tools),
            model.as_deref(),
        )
        .await?;

        let choice = LlmClient::first_choice(&response);
        let assistant = choice.get("message").cloned().unwrap_or_else(|| json!({}));
        content = assistant
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        tool_calls = assistant
            .get("tool_calls")
            .filter(|v| !v.is_null())
            .cloned();

        if tool_calls.is_none() {
            if let Some(parsed) = ai_text::parse_text_tool_calls(&content) {
                content = ai_text::strip_text_tool_calls(&content);
                tool_calls = Some(Value::Array(parsed));
            }
        }

        if tool_calls.is_none() && ai_tools::needs_tool_retry(&content, &job.user_message) {
            if should_bump_model(premium, &job.provider, current_model_index, job.chain.len()) {
                if premium
                    && !money_nudged
                    && ai_tools::money_intent(&job.user_message)
                    && ai_tools::is_tool_refusal(&content)
                {
                    money_nudged = true;
                    messages.push(json!({"role": "system", "content": ai_prompts::MONEY_NUDGE}));
                }
                current_model_index += 1;
                client = build_turn_client(state, job, current_model_index)?;
                continue;
            }

            if !tool_nudged {
                tool_nudged = true;
                messages.push(json!({"role": "system", "content": ai_prompts::TOOL_NUDGE}));
                continue;
            }
        }

        if should_money_nudge(
            premium,
            tool_calls.as_ref(),
            ai_tools::money_intent(&job.user_message),
            money_nudged,
            current_model_index,
            job.chain.len(),
        ) {
            money_nudged = true;
            messages.push(json!({"role": "system", "content": ai_prompts::MONEY_NUDGE}));
            current_model_index += 1;
            client = build_turn_client(state, job, current_model_index)?;
            continue;
        }

        let Some(calls) = tool_calls.clone() else {
            break;
        };

        messages.push(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": calls,
        }));

        let start_info: Vec<Value> = calls
            .as_array()
            .map(|calls| {
                calls
                    .iter()
                    .map(|tc| {
                        json!({
                            "name": tc.get("function").and_then(|f| f.get("name")),
                            "arguments": tc.get("function").and_then(|f| f.get("arguments")),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        job.send(TurnEvent::ToolStart(Value::Array(start_info)));

        let call_list = calls.as_array().cloned().unwrap_or_default();
        let (tool_results, round_action_succeeded) =
            ai_execute::execute_tool_calls_outcome(state, user_id, &call_list).await;
        if round_action_succeeded {
            action_succeeded = true;
        }
        let contents: Vec<String> = tool_results
            .iter()
            .map(|r| {
                r.get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        messages.extend(tool_results.iter().cloned());
        job.send(TurnEvent::ToolResults(contents.clone()));
        job.add_applied(extract_applied_actions(&tool_results));

        if round == MAX_TOOL_ROUNDS - 1 {
            let messages_value = Value::Array(messages.clone());
            let fallback = client.chat(&messages_value, None, None, None).await?;
            record_response_usage(state, job, &fallback).await?;
            content = LlmClient::first_choice(&fallback)
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            tool_calls = None;
        }
    }

    // 4. Persist the assistant placeholder BEFORE streaming (no drop-on-abort).
    job.set_phase("final");
    let placeholder_id = {
        let mut tx = begin_tx(state, user_id).await?;
        let id = ai_conversation::insert_conversation_returning_id(
            &mut *tx,
            user_id,
            job.session_id,
            "assistant",
            "",
            tool_calls.as_ref(),
        )
        .await?;
        tx.commit().await?;
        id
    };

    // 5. Final answer: stream it for real.
    let force_honest = unmet_action(&content, &job.user_message, action_succeeded);
    let mut streamed = String::new();

    if force_honest {
        streamed = "I could not make that change, so nothing was saved. \
Tell me the exact item and what you want changed and I will do it."
            .to_string();
        for chunk in ai_text::chunk_text(&streamed, CHUNK_SIZE) {
            job.send(TurnEvent::Token(chunk));
        }
    } else {
        let messages_value = Value::Array(messages.clone());
        match client.stream_chat(&messages_value).await {
            Ok(mut rx) => {
                while let Some(chunk) = rx.recv().await {
                    streamed.push_str(&chunk);
                    job.send(TurnEvent::Token(chunk));
                }
            }
            Err(err) => {
                if streamed.trim().is_empty() {
                    streamed = stream_fallback_reply(&content, &job.applied(), "Interrupted.");
                    if streamed == "Interrupted." {
                        if let Some(retried) =
                            retry_final_non_streaming(state, job, &client, &messages).await?
                        {
                            if !retried.is_empty() {
                                streamed = retried;
                            }
                        }
                    }
                    for chunk in ai_text::chunk_text(&streamed, CHUNK_SIZE) {
                        job.send(TurnEvent::Token(chunk));
                    }
                }
                let final_text =
                    ai_text::normalize_reply_markdown(&ai_text::strip_text_tool_calls(&streamed));
                update_placeholder(state, job, placeholder_id, &final_text).await;
                if streamed == "Interrupted." {
                    job.send(TurnEvent::Error(friendly_llm_error(&err, &job.provider)));
                }
                return Ok(());
            }
        }
    }

    if streamed.trim().is_empty() {
        let mut fallback = stream_fallback_reply(
            &content,
            &job.applied(),
            "I couldn't get a response from the AI on that turn. \
Please try again or rephrase your request.",
        );
        if content.trim().is_empty() && job.applied().is_empty() {
            if let Some(retried) =
                retry_final_non_streaming(state, job, &client, &messages).await?
            {
                if !retried.is_empty() {
                    fallback = retried;
                }
            }
        }
        streamed = fallback;
        for chunk in ai_text::chunk_text(&streamed, CHUNK_SIZE) {
            job.send(TurnEvent::Token(chunk));
        }
    }

    let final_text = ai_text::normalize_reply_markdown(&ai_text::strip_text_tool_calls(&streamed));
    update_placeholder(state, job, placeholder_id, &final_text).await;

    // 6. Usage + rolling summary + durable memories.
    let estimated = estimate_tokens(&messages, Some(&streamed));
    record_estimated_usage(state, job, &messages, &streamed).await?;
    job.send(TurnEvent::Usage(json!({ "estimated_tokens": estimated })));

    maybe_update_summary(
        state,
        user_id,
        job.session_id,
        &client,
        &job.sanitized_history,
        &job.user_message,
        &final_text,
        current_summary.as_deref(),
    )
    .await;

    maybe_extract_memories(
        state,
        user_id,
        job.session_id,
        &client,
        &job.sanitized_history,
        &job.user_message,
        &final_text,
    )
    .await;

    Ok(())
}

async fn finish_cancelled(state: &AppState, job: &Arc<TurnJob>) {
    if let Ok(mut status) = job.status.lock() {
        *status = "cancelled".to_string();
    }
    job.set_phase("done");
    if let Ok(mut tx) = begin_tx(state, job.user_id).await {
        let _ = ai_conversation::insert_conversation(
            &mut *tx,
            job.user_id,
            job.session_id,
            "assistant",
            "Interrupted.",
            None,
        )
        .await;
        let _ = tx.commit().await;
    }
}

async fn persist_error(state: &AppState, job: &Arc<TurnJob>, text: &str) {
    if let Ok(mut tx) = begin_tx(state, job.user_id).await {
        let _ = ai_conversation::insert_conversation(
            &mut *tx,
            job.user_id,
            job.session_id,
            "assistant",
            text,
            None,
        )
        .await;
        let _ = tx.commit().await;
    }
}

async fn update_placeholder(
    state: &AppState,
    job: &Arc<TurnJob>,
    placeholder_id: Uuid,
    text: &str,
) {
    if let Ok(mut tx) = begin_tx(state, job.user_id).await {
        let _ = ai_conversation::update_conversation_content(
            &mut *tx,
            job.user_id,
            placeholder_id,
            text,
        )
        .await;
        let _ = tx.commit().await;
    }
}

fn build_turn_client(state: &AppState, job: &TurnJob, index: usize) -> Result<LlmClient, LlmError> {
    if job.provider == "prysmai" && !job.chain.is_empty() {
        let model = job.chain.get(index).cloned().unwrap_or_default();
        let fallbacks = if index + 1 < job.chain.len() {
            job.chain[index + 1..].to_vec()
        } else {
            Vec::new()
        };
        Ok(LlmClient::prysm_ai(
            &job.api_key,
            &state.settings.prysm_ai_base_url(),
            &model,
            fallbacks,
            state.settings.prysm_ai_zdr(),
        ))
    } else {
        LlmClient::new(&job.provider, &job.api_key)
    }
}

// ---------------------------------------------------------------------------
// Provider call with response cache + usage
// ---------------------------------------------------------------------------

/// Run one tool-round provider call, served from the response cache when the
/// exact request was answered recently. Usage is recorded only for real calls.
/// Unlike Python, the cross-request in-flight coalescing is omitted: the single
/// active turn per account already serializes hosted turns.
pub(crate) async fn chat_with_cache(
    state: &AppState,
    user_id: Uuid,
    provider: &str,
    client: &LlmClient,
    messages: &[Value],
    tools: Option<&Value>,
    model: Option<&str>,
) -> Result<Value, RunnerError> {
    let model_owned = match model {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => client.model().to_string(),
    };
    let messages_value = Value::Array(messages.to_vec());
    let key = ai_cache::make_cache_key(user_id, provider, &model_owned, &messages_value, tools);

    {
        let mut tx = begin_tx(state, user_id).await?;
        let cached = ai_cache::get_cached_response(&mut *tx, user_id, provider, &key).await?;
        tx.commit().await?;
        if let Some(hit) = cached {
            return Ok(hit);
        }
    }

    let response = client.chat(&messages_value, tools, None, None).await?;

    {
        let mut tx = begin_tx(state, user_id).await?;
        // Cache write is best-effort: a cache failure must not fail the turn.
        let _ = ai_cache::cache_response(&mut *tx, user_id, provider, &key, &response).await;
        if provider == "prysmai" {
            record_response_usage_conn(&mut *tx, user_id, &response).await?;
        }
        tx.commit().await?;
    }

    Ok(response)
}

async fn record_response_usage_conn(
    conn: &mut PgConnection,
    user_id: Uuid,
    response: &Value,
) -> Result<(), sqlx::Error> {
    let usage = ai_entitlement::parse_usage(response);
    if usage.input != 0 || usage.output != 0 {
        ai_entitlement::record_usage_conn(
            conn,
            user_id,
            "prysmai",
            usage.input,
            usage.output,
            usage.cached_input,
        )
        .await?;
    }
    Ok(())
}

async fn record_response_usage(
    state: &AppState,
    job: &TurnJob,
    response: &Value,
) -> Result<(), RunnerError> {
    if job.provider != "prysmai" {
        return Ok(());
    }
    let mut tx = begin_tx(state, job.user_id).await?;
    record_response_usage_conn(&mut *tx, job.user_id, response).await?;
    tx.commit().await?;
    Ok(())
}

async fn record_estimated_usage(
    state: &AppState,
    job: &TurnJob,
    messages: &[Value],
    streamed: &str,
) -> Result<(), RunnerError> {
    if job.provider != "prysmai" {
        return Ok(());
    }
    let input = estimate_tokens(messages, None);
    let completion = Value::Array(vec![json!({"role": "assistant", "content": streamed})]);
    let output = estimate_tokens(completion.as_array().map(|v| v.as_slice()).unwrap_or(&[]), None);
    let mut tx = begin_tx(state, job.user_id).await?;
    ai_entitlement::record_usage_conn(&mut *tx, job.user_id, "prysmai", input, output, 0).await?;
    tx.commit().await?;
    Ok(())
}

async fn retry_final_non_streaming(
    state: &AppState,
    job: &TurnJob,
    client: &LlmClient,
    messages: &[Value],
) -> Result<Option<String>, RunnerError> {
    let messages_value = Value::Array(messages.to_vec());
    match client.chat(&messages_value, None, None, None).await {
        Ok(response) => {
            record_response_usage(state, job, &response).await?;
            let content = LlmClient::first_choice(&response)
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            Ok(Some(content))
        }
        Err(_) => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Summary + memory distillation
// ---------------------------------------------------------------------------

/// Distill a compact rolling summary of the conversation. Fail-open.
pub async fn summarize_conversation(
    client: &LlmClient,
    history: &[Value],
    existing_summary: Option<&str>,
) -> String {
    let prior = match existing_summary {
        Some(s) if !s.is_empty() => format!("\nExisting summary:\n{s}"),
        _ => String::new(),
    };
    let recent: Vec<&Value> = history.iter().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
    let transcript = recent
        .iter()
        .filter(|m| {
            matches!(
                m.get("role").and_then(|r| r.as_str()),
                Some("user") | Some("assistant") | Some("tool")
            )
        })
        .map(|m| {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
            let content: String = m
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .chars()
                .take(800)
                .collect();
            format!("{role}: {content}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "You maintain a compact rolling summary of a task-management chat. \
Distill the ABSOLUTE essentials only: tasks discussed or created (title, date, priority), \
scheduling decisions, conflicts, dates resolved, and user preferences. \
Keep it to one concise paragraph (under ~120 words). \
Do NOT invent facts not in the conversation. Drop trivia.\n\n\
{prior}\n\nLatest messages:\n{transcript}\n\nUpdated one-paragraph summary:",
        prior = prior.trim(),
        transcript = transcript.trim()
    );
    let messages = json!([{"role": "user", "content": prompt}]);
    match client.chat(&messages, None, Some(0.2), Some(300)).await {
        Ok(response) => {
            let content = LlmClient::first_choice(&response)
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if content.is_empty() || content.chars().count() < 20 {
                existing_summary.unwrap_or("").to_string()
            } else {
                content
            }
        }
        Err(_) => existing_summary.unwrap_or("").to_string(),
    }
}

/// Fold the latest turns into a rolling summary. Fail-open.
#[allow(clippy::too_many_arguments)]
pub async fn maybe_update_summary(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
    client: &LlmClient,
    sanitized_history: &[Value],
    user_message: &str,
    assistant_content: &str,
    current_summary: Option<&str>,
) {
    let total_turns = sanitized_history.len() + 2;
    if total_turns < 8 && current_summary.is_none() {
        return;
    }
    let mut combined = sanitized_history.to_vec();
    combined.push(json!({"role": "user", "content": user_message}));
    combined.push(json!({"role": "assistant", "content": assistant_content}));
    let new_summary = summarize_conversation(client, &combined, current_summary).await;

    match begin_tx(state, user_id).await {
        Ok(mut tx) => {
            let _ = ai_conversation::create_summary_if_missing(&mut *tx, user_id, session_id).await;
            let _ = ai_conversation::update_summary(&mut *tx, user_id, session_id, &new_summary).await;
            let _ = tx.commit().await;
        }
        Err(err) => tracing::debug!(error = %err, "summary update skipped"),
    }
}

/// Distill durable cross-session facts. Fail-open.
pub async fn maybe_extract_memories(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
    client: &LlmClient,
    sanitized_history: &[Value],
    user_message: &str,
    assistant_content: &str,
) {
    if assistant_content.is_empty() || assistant_content.chars().count() < 20 {
        return;
    }
    if user_message.trim().is_empty() && sanitized_history.is_empty() {
        return;
    }
    let facts =
        memory_service::extract_memories(client, sanitized_history, user_message, assistant_content)
            .await;
    if facts.is_empty() {
        return;
    }
    match begin_tx(state, user_id).await {
        Ok(mut tx) => {
            memory_service::store_memories(&mut *tx, user_id, Some(session_id), &facts).await;
            let _ = tx.commit().await;
        }
        Err(err) => tracing::debug!(error = %err, "memory store skipped"),
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (ported decision logic)
// ---------------------------------------------------------------------------

/// True when an action-y turn only narrated an action it never actually
/// committed. `action_succeeded` must be true only when a mutating tool call
/// really persisted a change; a failed or read-only tool call cannot excuse a
/// success narration.
pub fn unmet_action(content: &str, user_message: &str, action_succeeded: bool) -> bool {
    if action_succeeded || content.is_empty() {
        return false;
    }
    ai_tools::has_hallucinated_action(content) && ai_tools::needs_tool_retry(content, user_message)
}

/// Reply when the final stream died: prefer the tool-round content, else a
/// summary of the committed actions, else the cold text.
pub fn stream_fallback_reply(content: &str, applied_actions: &[String], cold: &str) -> String {
    let fallback = ai_text::normalize_reply_markdown(&ai_text::strip_text_tool_calls(content))
        .trim()
        .to_string();
    if !fallback.is_empty() {
        return fallback;
    }
    if !applied_actions.is_empty() {
        let mut out = String::from("Done before the stream cut out:");
        for action in applied_actions {
            out.push_str(&format!("\n- {action}"));
        }
        return out;
    }
    cold.to_string()
}

/// Whether to nudge a premium money turn toward the finance tools once.
pub fn should_money_nudge(
    premium: bool,
    tool_calls: Option<&Value>,
    money_hit: bool,
    money_nudged: bool,
    current_model_index: usize,
    chain_len: usize,
) -> bool {
    if !premium || money_nudged || !money_hit {
        return false;
    }
    let Some(calls) = tool_calls.and_then(|v| v.as_array()) else {
        return false;
    };
    let finance = ai_tools::finance_tool_names();
    if calls.iter().any(|tc| {
        let name = tc
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        finance.iter().any(|f| f == name)
    }) {
        return false;
    }
    (current_model_index as isize) < (chain_len as isize - 1).min(MAX_RETRY_BUMPS as isize)
}

/// Whether to retry a refused/empty round on a stronger hosted model.
pub fn should_bump_model(
    premium: bool,
    provider: &str,
    current_model_index: usize,
    chain_len: usize,
) -> bool {
    if !premium || provider != "prysmai" {
        return false;
    }
    (current_model_index as isize) < (chain_len as isize - 1).min(MAX_RETRY_BUMPS as isize)
}

/// Turn one tool-result JSON into a short human line, or `None` when the result
/// records no user-visible side effect (a read-only listing, an error, a no-op).
pub fn summarize_tool_result(content: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(content).ok()?;
    let obj = payload.as_object()?;
    if obj.get("error").map(|e| !e.is_null()).unwrap_or(false) {
        return None;
    }
    let action_keys = [
        "created",
        "created_count",
        "updated",
        "deleted",
        "completed",
        "cancelled",
        "cancelled_count",
    ];
    if !action_keys.iter().any(|k| obj.contains_key(*k)) {
        return None;
    }
    if let Some(count) = obj.get("created_count").and_then(|v| v.as_i64()) {
        if count != 0 {
            return Some(format!("Added {count} task(s)"));
        }
    }
    if let Some(count) = obj.get("cancelled_count").and_then(|v| v.as_i64()) {
        if count != 0 {
            return Some(format!("Cancelled {count} task(s)"));
        }
        return None;
    }
    let task = obj.get("task").and_then(|v| v.as_object());
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| task.and_then(|t| t.get("title")).and_then(|v| v.as_str()))
        .or_else(|| obj.get("title").and_then(|v| v.as_str()));
    let label = if obj.get("created") == Some(&Value::Bool(true)) {
        "Added"
    } else if obj.get("completed") == Some(&Value::Bool(true)) {
        "Completed"
    } else if obj.get("deleted") == Some(&Value::Bool(true)) {
        "Deleted"
    } else if obj.get("updated") == Some(&Value::Bool(true)) {
        "Updated"
    } else if obj.get("cancelled") == Some(&Value::Bool(true)) {
        "Cancelled"
    } else {
        return None;
    };
    match name {
        Some(name) => {
            let date = task
                .and_then(|t| t.get("start_date"))
                .and_then(|v| v.as_str())
                .or_else(|| obj.get("start_date").and_then(|v| v.as_str()));
            let suffix = date.map(|d| format!(" ({d})")).unwrap_or_default();
            Some(format!("{label} \"{name}\"{suffix}"))
        }
        None => Some(format!("{label} an item")),
    }
}

/// Human summaries of the committed side-effects in one tool round, preserving
/// order and dropping duplicates.
pub fn extract_applied_actions(tool_results: &[Value]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for result in tool_results {
        let content = result.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if let Some(line) = summarize_tool_result(content) {
            if !lines.contains(&line) {
                lines.push(line);
            }
        }
    }
    lines
}

/// Rough token estimate over a prompt and optional completion (mirrors Python
/// `_estimate_tokens`; about 4 characters per token).
pub fn estimate_tokens(prompt_messages: &[Value], completion: Option<&str>) -> i64 {
    const CHARS_PER_TOKEN: i64 = 4;
    let mut chars = 0i64;
    for message in prompt_messages {
        if let Some(content) = message.get("content").and_then(|c| c.as_str()) {
            chars += content.chars().count() as i64;
        }
        if let Some(calls) = message.get("tool_calls").and_then(|t| t.as_array()) {
            for call in calls {
                let function = call.get("function");
                let name = function
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                chars += name.chars().count() as i64;
                if let Some(args) = function.and_then(|f| f.get("arguments")) {
                    chars += match args.as_str() {
                        Some(s) => s.chars().count() as i64,
                        None => args.to_string().chars().count() as i64,
                    };
                }
            }
        }
    }
    let mut prompt_tokens = (chars / CHARS_PER_TOKEN).max(1);
    if let Some(completion) = completion {
        prompt_tokens += (completion.chars().count() as i64 / CHARS_PER_TOKEN).max(0);
    }
    prompt_tokens
}

// ---------------------------------------------------------------------------
// Friendly provider-error mapping
// ---------------------------------------------------------------------------

/// Extract the numeric status from an `HTTP <code>: ...` provider error string.
fn http_status(raw: &str) -> Option<u16> {
    let rest = raw.split("HTTP ").nth(1)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Pull the provider's `"message"` field out of an error body, if present.
fn provider_error_message(raw: &str) -> String {
    let Some(start) = raw.find("\"message\":\"") else {
        return String::new();
    };
    let after = &raw[start + "\"message\":\"".len()..];
    let end = after.find('"').unwrap_or(after.len());
    after[..end].chars().take(300).collect()
}

/// Map a provider/transport error to a clear, actionable user message. Raw
/// provider text is never handed to the model; only this safe copy is.
pub fn friendly_llm_error(err: &LlmError, provider: &str) -> String {
    let raw = match err {
        LlmError::Response(s) => s.clone(),
        LlmError::Request(s) => format!("connection error: {s}"),
        LlmError::UnknownProvider(p) => format!("unknown provider: {p}"),
        LlmError::NoEmbeddings(p) => format!("embeddings unavailable: {p}"),
    };
    let lower = raw.to_lowercase();

    if lower.contains("http 401") || lower.contains("unauthorized") || lower.contains("authentication") {
        // Hosted PrysmAI uses a server-side provider key the user never sees or
        // manages, so a 401 there is our configuration problem, not theirs.
        if provider == "prysmai" {
            return "PrysmAI is temporarily unavailable right now. Please try again later."
                .to_string();
        }
        return "Your AI API key was rejected by the provider. Check the key in Settings.".to_string();
    }
    if lower.contains("http 429") || lower.contains("rate limit") {
        return "The AI provider is rate-limiting requests. Please wait a moment and try again."
            .to_string();
    }

    let status = http_status(&raw);
    if status == Some(402)
        || lower.contains("insufficient credit")
        || lower.contains("no credit")
        || lower.contains("payment required")
    {
        if provider == "prysmai" {
            return "Your PrysmAI token allowance is used up for this month. \
Upgrade your plan or wait for it to reset."
                .to_string();
        }
        return "Your AI provider account is out of credits, so the AI can't respond. \
Top up your account (e.g. at openrouter.ai) and try again."
            .to_string();
    }
    if let Some(code) = status {
        let detail = provider_error_message(&raw);
        return if detail.is_empty() {
            format!("The AI provider returned an error (HTTP {code}).")
        } else {
            format!("The AI provider returned an error (HTTP {code}). {detail}")
        };
    }
    if matches!(err, LlmError::Request(_)) {
        return "Could not reach the AI provider. Check your internet connection and try again."
            .to_string();
    }
    "AI request failed. Please try again.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_created_and_completed_results() {
        assert_eq!(
            summarize_tool_result(r#"{"created": true, "task": {"title": "Buy milk", "start_date": "2026-09-07"}}"#),
            Some("Added \"Buy milk\" (2026-09-07)".to_string())
        );
        assert_eq!(
            summarize_tool_result(r#"{"completed": true, "title": "Work"}"#),
            Some("Completed \"Work\"".to_string())
        );
        assert_eq!(
            summarize_tool_result(r#"{"created_count": 3}"#),
            Some("Added 3 task(s)".to_string())
        );
        assert_eq!(summarize_tool_result(r#"{"cancelled_count": 0}"#), None);
        assert_eq!(summarize_tool_result(r#"{"error": "nope"}"#), None);
        assert_eq!(summarize_tool_result(r#"{"tasks": []}"#), None);
        assert_eq!(summarize_tool_result("not json"), None);
    }

    #[test]
    fn applied_actions_dedupes_in_order() {
        let results = vec![
            json!({"content": r#"{"created": true, "title": "A"}"#}),
            json!({"content": r#"{"created": true, "title": "A"}"#}),
            json!({"content": r#"{"created": true, "title": "B"}"#}),
            json!({"content": r#"{"ok": true}"#}),
        ];
        assert_eq!(
            extract_applied_actions(&results),
            vec!["Added \"A\"".to_string(), "Added \"B\"".to_string()]
        );
    }

    #[test]
    fn friendly_llm_error_is_honest_for_hosted_prysmai_401() {
        let err = LlmError::Response(
            "HTTP 401: {\"error\":{\"message\":\"Invalid API key\"}}".to_string(),
        );
        let msg = friendly_llm_error(&err, "prysmai");
        // The user does not own the hosted key, so never point them at Settings.
        assert!(!msg.to_lowercase().contains("settings"));
        assert!(!msg.to_lowercase().contains("your ai api key"));
        assert!(msg.contains("temporarily unavailable"));
    }

    #[test]
    fn friendly_llm_error_keeps_settings_copy_for_byok_401() {
        let err = LlmError::Response("HTTP 401: unauthorized".to_string());
        let msg = friendly_llm_error(&err, "openrouter");
        assert!(msg.contains("Check the key in Settings"));
    }

    #[test]
    fn unmet_action_flags_hallucinated_plan_without_tools() {
        assert!(unmet_action("Let me try deleting it", "delete the task", false));
        assert!(!unmet_action("Let me try deleting it", "delete the task", true));
        assert!(!unmet_action("It is sunny today", "what is the weather", false));
        assert!(!unmet_action("", "delete the task", false));
    }

    /// A failed (or read-only) tool call must not excuse a success narration:
    /// this is the "AI says it created the task but nothing was saved" bug.
    #[test]
    fn unmet_action_flags_success_narration_without_committed_action() {
        assert!(unmet_action("I've created the task for you:", "testing", false));
        assert!(!unmet_action("I've created the task for you:", "testing", true));
    }

    #[test]
    fn stream_fallback_prefers_content_then_actions_then_cold() {
        assert_eq!(stream_fallback_reply("hello", &[], "cold"), "hello");
        assert_eq!(
            stream_fallback_reply("", &["Added \"A\"".to_string()], "cold"),
            "Done before the stream cut out:\n- Added \"A\""
        );
        assert_eq!(stream_fallback_reply("", &[], "cold"), "cold");
    }

    #[test]
    fn bump_and_money_nudge_respect_the_chain() {
        // BYOK (chain empty) never bumps.
        assert!(!should_bump_model(true, "openai", 0, 0));
        // Hosted, index 0, chain of 3 -> bump allowed (up to 2).
        assert!(should_bump_model(true, "prysmai", 0, 3));
        assert!(!should_bump_model(true, "prysmai", 2, 3));
        assert!(!should_bump_model(false, "prysmai", 0, 3));

        // Money nudge guards: free users, already-nudged, no money intent, no
        // tool calls, no bump left (index at/over the cap), and the BYOK
        // (empty-chain, unreachable-for-prysmai) case all stay false.
        let calls = json!([{"function": {"name": "create_task"}}]);
        assert!(!should_money_nudge(false, Some(&calls), true, false, 0, 3));
        assert!(!should_money_nudge(true, Some(&calls), true, true, 0, 3));
        assert!(!should_money_nudge(true, Some(&calls), false, false, 0, 3));
        assert!(!should_money_nudge(true, None, true, false, 0, 3));
        assert!(!should_money_nudge(true, Some(&calls), true, false, 2, 3));
        assert!(!should_money_nudge(true, Some(&calls), true, false, 0, 0));
    }

    #[test]
    fn estimate_tokens_counts_content_and_tool_args() {
        let messages = vec![
            json!({"role": "user", "content": "abcdefgh"}),
            json!({"role": "assistant", "tool_calls": [{"function": {"name": "f", "arguments": "{}"}}]}),
        ];
        // (8 + 1 + 2) chars / 4 = 2, bumped to at least 1.
        assert_eq!(estimate_tokens(&messages, None), 2);
        assert_eq!(estimate_tokens(&[], Some("abcdefgh")), 3);
    }

    #[test]
    fn friendly_errors_are_safe_and_actionable() {
        let auth = LlmError::Response("HTTP 401: {\"error\":{\"message\":\"bad key\"}}".to_string());
        assert!(friendly_llm_error(&auth, "openai").contains("rejected"));
        let credits = LlmError::Response("HTTP 402: {\"error\":{\"message\":\"Insufficient Credits\"}}".to_string());
        assert!(friendly_llm_error(&credits, "openai").contains("out of credits"));
        assert!(friendly_llm_error(&credits, "prysmai").contains("PrysmAI token allowance"));
        let conn = LlmError::Request("timeout".to_string());
        assert!(friendly_llm_error(&conn, "openai").contains("Could not reach"));
    }

    #[test]
    fn http_status_and_provider_message_parse() {
        assert_eq!(http_status("HTTP 503: boom"), Some(503));
        assert_eq!(http_status("nope"), None);
        assert_eq!(
            provider_error_message("HTTP 402: {\"error\":{\"message\":\"Insufficient Credits\"}}"),
            "Insufficient Credits"
        );
    }
}
