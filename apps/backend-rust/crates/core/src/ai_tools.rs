//! AI tool definitions and gating, mirroring app/services/ai_service.py.
//!
//! The core build ships the task-suite tools plus the watchlist and habit tool
//! modules. Enterprise tool modules (finance, OpenClaw, countdown, quadrant,
//! focus, GitHub, workflow, Slack) are appended by the private build; the
//! community core has none, so `tools_for_user` is a no-op filter here.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::ai_execute::ToolResult;
use crate::AppState;

/// The tool definitions shipped by the open core (47 tools).
pub const TOOL_DEFINITIONS_JSON: &str = include_str!("ai_tools.json");

static TOOL_DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();

/// Parse and cache the embedded tool definitions.
pub fn tool_definitions() -> &'static [Value] {
    TOOL_DEFINITIONS
        .get_or_init(|| {
            serde_json::from_str(TOOL_DEFINITIONS_JSON)
                .expect("ai_tools.json must contain a JSON array")
        })
        .as_slice()
}

/// Boxed future returned by the EE agent-tool dispatcher.
pub type EeToolFuture<'a> = Pin<Box<dyn Future<Output = Option<ToolResult>> + Send + 'a>>;

/// Enterprise agent-tool provider. The private build registers one; the
/// community core registers none, so `tools_for_user` is a no-op filter and
/// `ee_dispatch` always falls through (mirrors the Python EE tool modules
/// appended to `TOOL_DEFINITIONS` in the paid build).
pub trait EeAgentTools: Send + Sync {
    /// JSON tool definitions to append for the in-app agent.
    fn tool_definitions(&self) -> Vec<Value>;
    /// All EE tool names (removed for free users).
    fn tool_names(&self) -> Vec<String>;
    /// EE tool names that stay available to free users even though they are
    /// enterprise-provided (for example the free-capped countdown tools).
    fn free_names(&self) -> Vec<String>;
    /// EE finance tool names (the money-routing safety net).
    fn finance_names(&self) -> Vec<String>;
    /// Dispatch an EE tool, returning None when the name is not handled here.
    fn call<'a>(
        &'a self,
        state: &'a AppState,
        user_id: Uuid,
        name: &'a str,
        args: &'a Value,
    ) -> EeToolFuture<'a>;
}

static EE_AGENT_TOOLS: OnceLock<Box<dyn EeAgentTools>> = OnceLock::new();

/// Install the EE agent-tool provider (called once by the private build).
pub fn register_ee_agent_tools(tools: Box<dyn EeAgentTools>) {
    let _ = EE_AGENT_TOOLS.set(tools);
}

fn ee_agent_tools() -> Option<&'static dyn EeAgentTools> {
    EE_AGENT_TOOLS.get().map(|boxed| boxed.as_ref())
}

/// Dispatch an EE agent tool, if the EE build registered one.
pub async fn ee_dispatch(
    state: &AppState,
    user_id: Uuid,
    name: &str,
    args: &Value,
) -> Option<ToolResult> {
    let tools = ee_agent_tools()?;
    tools.call(state, user_id, name, args).await
}

/// Map a CORE mutating tool name to the change-bus resource it affects, so a
/// successful AI or MCP tool call can publish the same `GET /api/events`
/// signal an HTTP mutation would. Read-only tools and EE tools return `None`.
pub fn mutation_resource(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "create_task" | "update_task" | "delete_task" | "batch_delete_tasks"
        | "delete_matching_tasks" | "reschedule_task" | "batch_create_tasks" | "add_event"
        | "cancel_task_by_keywords" | "complete_task" | "duplicate_task" | "restore_task"
        | "add_tag_to_task" | "create_subtask" | "update_subtask" | "delete_subtask"
        | "reorder_subtasks" | "convert_description_to_subtasks"
        | "convert_subtasks_to_description" | "link_tasks" => Some("tasks"),
        "organize_timeline_into_sections" => Some("board_sections"),
        "create_list" | "rename_list" | "delete_list" => Some("lists"),
        "add_watchlist_item" | "update_watchlist_item" | "remove_watchlist_item" => {
            Some("watchlist")
        }
        "create_habit" | "update_habit" | "delete_habit" | "toggle_habit_log" => Some("habits"),
        _ => None,
    }
}

/// Enterprise-only tool names. The private build appends these definitions and
/// overrides this list; the community core ships none of them.
pub fn ee_tool_names() -> Vec<String> {
    match ee_agent_tools() {
        Some(tools) => tools.tool_names(),
        None => Vec::new(),
    }
}

fn ee_tool_definitions() -> Vec<Value> {
    match ee_agent_tools() {
        Some(tools) => tools.tool_definitions(),
        None => Vec::new(),
    }
}

/// EE tool names that remain available to free users (the EE provider decides
/// which, for example the free-capped countdown tools).
fn ee_free_names() -> Vec<String> {
    match ee_agent_tools() {
        Some(tools) => tools.free_names(),
        None => Vec::new(),
    }
}

/// Tool definitions for a request, minus the premium EE tools for free users.
/// EE tools the provider marks as free (`free_names`) are kept. In the community
/// build `ee_tool_names()` is empty, so this is the full core set (mirrors the
/// Python `tools_for_user`).
pub fn tools_for_user(premium: bool) -> Vec<Value> {
    let mut all = tool_definitions().to_vec();
    all.extend(ee_tool_definitions());
    if premium {
        return all;
    }
    let ee = ee_tool_names();
    if ee.is_empty() {
        return all;
    }
    let free = ee_free_names();
    all.retain(|t| {
        let name = t
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        if !ee.iter().any(|n| n == name) {
            return true; // core tool
        }
        // Enterprise tool: keep it only when the provider marks it free.
        free.iter().any(|n| n == name)
    });
    all
}

/// Premium-check provider installed by the private build. The community build
/// registers none, so every user is treated as eligible for the full core set.
pub trait AiPremiumCheck: Send + Sync {
    fn is_premium<'a>(
        &'a self,
        pool: &'a PgPool,
        user_id: Uuid,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

static AI_PREMIUM_CHECK: OnceLock<Box<dyn AiPremiumCheck>> = OnceLock::new();

/// Install the Premium-check provider (called once by the private build).
pub fn register_premium_check(check: Box<dyn AiPremiumCheck>) {
    let _ = AI_PREMIUM_CHECK.set(check);
}

/// Whether the caller's subscription grants Premium (active plan or 14-day
/// trial). The private build installs the subscription-backed check; the
/// community build has none, so the full core tool set is available.
pub async fn is_premium_for(pool: &PgPool, user_id: Uuid) -> bool {
    match AI_PREMIUM_CHECK.get() {
        Some(check) => check.is_premium(pool, user_id).await,
        None => true,
    }
}

fn refusal_patterns() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?:don't have the necessary tools|don't have (?:access|any tools|a tool|the tools|tools to|tools for)|don't have the (?:necessary |required |needed |proper |sufficient )?(?:access|tools?|permissions?|ability|capability)|i (?:do not|don'?t) have (?:the )?(?:access|tools?|permissions?|ability|capability)|(?:can'?t|cannot|not able to|unable to) (?:post|send|share|message|dm|invite|comment|react|stand ?up)|cannot assist|can't assist|as an ai|not able to|was(?:n'?t| not) able to|unable to (?:do|help|assist|complete|perform|process|find|locate|update|delete|remove|create|add|change|schedule|access)|(?:could not|couldn'?t) (?:do|help|complete|perform|process|find|locate|update|delete|remove|create|add|change|schedule|access)|failed to (?:do|complete|perform|process|find|locate|update|delete|remove|create|add|change|schedule|access)|i'?m (?:just |merely )?an ai|i (?:am |'m )?not (?:able|capable|equipped|designed)|i cannot (?:call|execute|use|access) tools|no (?:tools?|functions?) (?:available|defined|provided))",
        )
        .expect("valid refusal regex")
    })
}

fn hallucinated_action_patterns() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?:i'?ve )?(?:found|identified|located|noticed) \d+|(?:i'?ve )?(?:created|deleted|removed|scheduled|completed|added|marked)|(?:let me|i will|going to|i'?ll|i'?m going to)\s+(?:(?:try|attempt|start|begin|go ahead and|now)\s+)?(?:creat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|schedul(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|reschedul(?:e|es|ed|ing)|cancell?(?:s|ed|ing)?|add(?:s|ed|ing)?|mark(?:s|ed|ing)?|mov(?:e|es|ed|ing))\b)",
        )
        .expect("valid hallucination regex")
    })
}

fn action_keywords() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:delete|remove|create|schedule|add|update|mark|complete|finish|find|search|move|reschedule|cancel|change|rename|remind|notify|duplicate|split|merge|post|send|share|dm|message|standup|stand|digest|slack|github|pull request|pr|issue|review|invite|react|comment|triage|repository|repo|channel)\b",
        )
        .expect("valid action regex")
    })
}

fn question_only_start() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)^(?:what|who|when|where|why|how|is|are|can|could|would|will|do|does|did)\b")
            .expect("valid question regex")
    })
}

fn money_intent_pattern() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\b(?:income|salary|wage|payday|paycheck|earn|expense|spend|bill|debt|loan|mortgage|rent|credit|payment|overdue|overdraft|savings|afford|budget|tax|euros?|dollars?|pounds?|eur|usd)\b)|(?:€|\$|£)\s?\d|\d[\d.,]*\s?(?:€|\$|£|eur|usd)\b",
        )
        .expect("valid money regex")
    })
}

/// True when the message mentions money (income, bills, debts, amounts,
/// currency) that should route to the finance tools rather than tasks.
pub fn money_intent(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    money_intent_pattern().is_match(text)
}

/// Enterprise finance tool names. The private build appends these definitions;
/// the community core ships none, so the money-routing safety net never fires
/// here (mirrors the Python `finance_tool_names()` returning an empty set).
pub fn finance_tool_names() -> Vec<String> {
    match ee_agent_tools() {
        Some(tools) => tools.finance_names(),
        None => Vec::new(),
    }
}

/// True when the model's text is a tool refusal (mirrors the Python
/// `_TOOL_REFUSAL_PATTERNS.search`).
pub fn is_tool_refusal(content: &str) -> bool {
    refusal_patterns().is_match(content)
}

/// True when the model narrated an action it never actually took (mirrors the
/// Python `_HALLUCINATED_ACTION_PATTERNS.search`).
pub fn has_hallucinated_action(content: &str) -> bool {
    hallucinated_action_patterns().is_match(content)
}

/// True when the model's text reply is a refusal or a hallucinated completion
/// for an action-y user request, so the caller should retry on the paid floor
/// model. False for clean Q&A where a tool-free answer is fine.
pub fn needs_tool_retry(content: &str, user_message: &str) -> bool {
    if content.is_empty() {
        return true;
    }
    if refusal_patterns().is_match(content) {
        return true;
    }
    if hallucinated_action_patterns().is_match(content) {
        return true;
    }
    if money_intent(user_message) && !question_only_start().is_match(user_message) {
        return true;
    }
    if question_only_start().is_match(user_message) && !user_message.contains('$') {
        return false;
    }
    action_keywords().is_match(user_message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_are_well_formed() {
        let defs = tool_definitions();
        assert_eq!(defs.len(), 47);
        for def in defs {
            let name = def
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str());
            assert!(name.is_some(), "every tool needs a function name");
        }
    }

    #[test]
    fn core_tools_exclude_enterprise_names() {
        let names: Vec<&str> = tool_definitions()
            .iter()
            .filter_map(|t| t.get("function").and_then(|f| f.get("name")).and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"search_tasks"));
        assert!(names.contains(&"list_habits"));
        assert!(names.contains(&"search_titles"));
        assert!(!names.contains(&"add_financial_item"));
        assert!(!names.contains(&"send_slack_message"));
    }

    #[test]
    fn tools_for_user_returns_all_for_premium() {
        assert_eq!(tools_for_user(true).len(), tool_definitions().len());
        assert_eq!(tools_for_user(false).len(), tool_definitions().len());
    }

    #[test]
    fn community_has_no_ee_tools_or_free_names() {
        // No EE provider is registered in the core build.
        assert!(ee_tool_names().is_empty());
        assert!(ee_free_names().is_empty());
    }

    #[tokio::test]
    async fn premium_check_defaults_to_true_without_a_provider() {
        // No provider registered: every user is eligible for the full set. A
        // lazy pool is enough because the default path never touches the DB.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://prysm:prysm@localhost:5432/prysm")
            .expect("lazy pool");
        assert!(is_premium_for(&pool, uuid::Uuid::nil()).await);
    }

    #[test]
    fn money_intent_detects_amounts_and_keywords() {
        assert!(money_intent("I pay 40 euros a month"));
        assert!(money_intent("my rent is due"));
        assert!(money_intent("I spent $250"));
        assert!(!money_intent("what is the weather"));
        assert!(!money_intent(""));
    }

    #[test]
    fn needs_tool_retry_flags_refusals_and_actions() {
        assert!(needs_tool_retry("", "create a task"));
        assert!(needs_tool_retry("I don't have access to that", "create a task"));
        assert!(needs_tool_retry("I've created the task", "create a task"));
        assert!(!needs_tool_retry("It is sunny today", "what is the weather"));
    }

    /// Battery of real, messy user phrasings: when the model answers with plain
    /// text (or a refusal) instead of calling a tool, the retry safety net must
    /// fire so the request is re-driven with the toolset.
    #[test]
    fn needs_tool_retry_covers_misspelled_and_abbreviated_requests() {
        let action_phrases = [
            "add taks buy milk tomorow",
            "mark the report done",
            "remind me pay rent on the 1st",
            "delete all the work taks",
            "mark severance watched",
            "move it to friday",
            "create a doc ap next tuesday",
            "update my wrk schedule",
            "schedule my workout every monday",
        ];
        for phrase in action_phrases {
            assert!(
                needs_tool_retry("Sure, here is some text instead.", phrase),
                "expected a tool retry for: {phrase}"
            );
        }

        let qa_phrases = [
            "what is the weather today",
            "who won the game last night",
            "explain how recurrence works",
        ];
        for phrase in qa_phrases {
            assert!(
                !needs_tool_retry("Here is a plain answer.", phrase),
                "expected no tool retry for: {phrase}"
            );
        }
    }

    #[test]
    fn refusal_detection_handles_casual_and_typoed_output() {
        assert!(is_tool_refusal("I don't have the tools for that"));
        assert!(is_tool_refusal("I cannot assist with that"));
        assert!(is_tool_refusal("I'm not able to do that"));
        assert!(!is_tool_refusal("Added Buy milk for tomorrow."));
    }

    #[test]
    fn hallucinated_action_is_flagged() {
        assert!(has_hallucinated_action("I've created the task for you."));
        assert!(has_hallucinated_action("Done! I scheduled it."));
    }

    #[test]
    fn mutation_resource_covers_writes_only() {
        assert_eq!(mutation_resource("create_task"), Some("tasks"));
        assert_eq!(mutation_resource("add_event"), Some("tasks"));
        assert_eq!(mutation_resource("delete_task"), Some("tasks"));
        assert_eq!(mutation_resource("create_habit"), Some("habits"));
        assert_eq!(mutation_resource("add_watchlist_item"), Some("watchlist"));
        assert_eq!(mutation_resource("create_list"), Some("lists"));
        // Read-only tools must never publish a change signal.
        assert_eq!(mutation_resource("search_tasks"), None);
        assert_eq!(mutation_resource("list_tags"), None);
        assert_eq!(mutation_resource("get_task_details"), None);
        assert_eq!(mutation_resource("unknown_tool"), None);
    }
}
