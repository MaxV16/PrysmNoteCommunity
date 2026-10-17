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
            r"(?i)(?:(?:i'?ve )?(?:created|deleted|removed|scheduled|completed|added|marked)|(?:let me|i will|going to|i'?ll|i'?m going to)\s+(?:(?:try|attempt|start|begin|go ahead and|now)\s+)?(?:creat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|schedul(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|reschedul(?:e|es|ed|ing)|cancell?(?:s|ed|ing)?|add(?:s|ed|ing)?|mark(?:s|ed|ing)?|mov(?:e|es|ed|ing))\b)",
        )
        .expect("valid hallucination regex")
    })
}

fn action_keywords() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:delet\w*|remov\w*|creat\w*|schedul\w*|updat\w*|complet\w*|reschedul\w*|renam\w*|remind\w*|notif\w*|duplicat\w*|cancell?\w*|chang\w*|mark\w*|finish\w*|find|search\w*|mov\w*|add|ad|split|merge|post|send|share|dm|message|standup|stand|digest|slack|github|pull request|pr|issue|review|invite|react|comment|triage|repository|repo|channel)\b",
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

    #[test]
    fn money_intent_edge_cases() {
        for text in [
            "I get paid 3200 EUR on the 1st",
            "my salary arrives friday",
            "rent is overdue",
            "credit card debt",
            "coffee cost me €3.50",
            "£40 for the train",
            "250 usd invoice",
            "I need to budget for taxes",
            "loan payment",
            "savings goal",
        ] {
            assert!(money_intent(text), "expected money intent: {text}");
        }
        for text in [
            "",
            " ",
            "what is the weather",
            "call mum tomorrow",
            "review the design doc",
            "the number 42",
            "Eurovision is on saturday",
        ] {
            assert!(!money_intent(text), "expected no money intent: {text}");
        }
    }

    #[test]
    fn needs_tool_retry_ambiguous_and_hostile_inputs() {
        let retry = [
            "",
            "I don't have the necessary tools",
            "I cannot assist with that",
            "As an AI, I can't do that",
            "I've created and scheduled it",
            "I will delete the old tasks",
            "Found 3 matching tasks",
            "Sure! Let me update that for you",
            "I wasn't able to find it",
            "Failed to complete the operation",
            "No tools are available",
        ];
        for content in retry {
            assert!(
                needs_tool_retry(content, "create a task for tomorrow"),
                "expected retry for model output: {content}"
            );
        }

        let no_retry = [
            ("It is 18 degrees and sunny.", "what is the weather"),
            ("Recurrence repeats a task on a schedule.", "explain how recurrence works"),
            ("A task is a unit of work.", "what is a task"),
            ("Yes, that is possible.", "can I share a list"),
            ("Use the plus button.", "how do I add a task"),
        ];
        for (content, message) in no_retry {
            assert!(
                !needs_tool_retry(content, message),
                "expected no retry for {content:?} / {message:?}"
            );
        }

        let typo_actions = [
            "creat taks buy milk",
            "delet all done taks",
            "reschedul meeting to friday",
            "ad tag urgent",
            "complet the report",
            "schedul dentist next week",
            "updat due date",
            "remov duplicate",
            "find my notes",
            "mark as done",
        ];
        for message in typo_actions {
            assert!(
                needs_tool_retry("Here is a plain answer.", message),
                "expected retry for request: {message}"
            );
        }
    }

    #[test]
    fn refusal_and_hallucination_never_fire_on_clean_results() {
        let refusals = [
            "I don't have access",
            "I cannot assist",
            "I'm not able to do that",
            "I was not able to find it",
            "Unable to create the task",
            "Failed to update the task",
            "I cannot call tools",
            "No functions available",
            "I'm just an AI",
            "I do not have the ability",
        ];
        for text in refusals {
            assert!(is_tool_refusal(text), "expected refusal: {text}");
            assert!(needs_tool_retry(text, "do something"));
        }

        let clean = [
            "Added Buy milk for tomorrow.",
            "Done. The task is now in progress.",
            "I found your task and moved it to Friday.",
            "Here is a summary of your week.",
            "Your task was created successfully.",
        ];
        for text in clean {
            assert!(!is_tool_refusal(text), "unexpected refusal: {text}");
        }

        for text in [
            "I found 3 tasks",
            "I located 1 matching task.",
            "I noticed 2 tasks due today.",
        ] {
            assert!(
                !has_hallucinated_action(text),
                "read-only summary treated as a hallucinated action: {text}"
            );
        }

        for text in [
            "I've created the task",
            "I deleted the old one",
            "I scheduled it for Friday",
            "I've marked it complete",
            "I will create that now",
            "Let me update the due date",
            "I'm going to reschedule it",
            "I've added the tag",
            "I will move it to backlog",
        ] {
            assert!(has_hallucinated_action(text), "expected hallucination: {text}");
        }

        for text in [
            "Here is how you can create a task",
            "The task list is empty",
            "You can schedule it yourself",
            "This task is due Friday",
            "Your notes are below",
        ] {
            assert!(
                !has_hallucinated_action(text),
                "unexpected hallucination: {text}"
            );
        }
    }

    #[test]
    fn tool_registry_has_no_duplicate_names_and_stays_bounded() {
        let functions: Vec<&Value> = tool_definitions()
            .iter()
            .filter_map(|t| t.get("function"))
            .collect();
        assert_eq!(functions.len(), tool_definitions().len());
        let names: Vec<&str> = functions
            .iter()
            .filter_map(|f| f.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(names.len(), functions.len());
        assert!(!names.is_empty());
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "duplicate tool names");
        assert!(names.iter().all(|n| !n.trim().is_empty()));
        assert!(names.len() <= 64, "toolset unexpectedly large");
        for function in functions {
            assert!(function.get("description").and_then(Value::as_str).is_some());
            assert!(function.get("parameters").is_some());
        }
    }

    #[test]
    fn mutation_resource_never_flags_reads_or_unknown_names() {
        for name in [
            "search_tasks",
            "list_tags",
            "get_task_details",
            "get_subtasks",
            "list_tasks_by_date_range",
            "check_calendar",
            "suggest_best_time",
            "list_habits",
            "get_habit_logs",
            "list_watchlist",
            "search_titles",
            "list_memories",
            "",
            " ",
            "CREATE_TASK",
            "create-task",
            "delete_everything",
        ] {
            assert_eq!(mutation_resource(name), None, "unexpected resource for {name}");
        }
        let writes = [
            ("create_task", "tasks"),
            ("update_task", "tasks"),
            ("delete_task", "tasks"),
            ("complete_task", "tasks"),
            ("duplicate_task", "tasks"),
            ("add_tag_to_task", "tasks"),
            ("create_subtask", "tasks"),
            ("update_subtask", "tasks"),
            ("delete_subtask", "tasks"),
            ("reorder_subtasks", "tasks"),
            ("reschedule_task", "tasks"),
            ("batch_create_tasks", "tasks"),
            ("batch_delete_tasks", "tasks"),
            ("add_event", "tasks"),
            ("create_habit", "habits"),
            ("toggle_habit_log", "habits"),
            ("add_watchlist_item", "watchlist"),
            ("update_watchlist_item", "watchlist"),
            ("remove_watchlist_item", "watchlist"),
            ("create_list", "lists"),
        ];
        for (name, expected) in writes {
            assert_eq!(mutation_resource(name), Some(expected), "wrong resource for {name}");
        }
    }
}
