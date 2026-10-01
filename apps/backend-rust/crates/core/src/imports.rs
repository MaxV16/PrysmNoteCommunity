//! Task imports (CSV / ICS) mirroring the Python `app/routers/imports.py`.
//!
//! Supports TickTick, Todoist, ICS and a generic CSV shape. The parser output
//! is normalized into `ImportRow`s which are then inserted inside a single
//! transaction, tagged and deduplicated the same way the Python service does.
//! Recurring templates are imported as plain rows (occurrence expansion is
//! still deferred, matching the rest of the Rust port).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use axum::extract::{Multipart, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::{db, error::ApiError, AppState};

pub const VALID_FORMATS: [&str; 5] = ["auto", "ticktick", "todoist", "generic", "ics"];
const MAX_ERRORS: usize = 50;

/// Per-user single-flight guard (mirrors Python `_active_imports`).
fn active_imports() -> &'static Mutex<HashSet<Uuid>> {
    static ACTIVE: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

#[allow(dead_code)]
fn is_unique_violation(err: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db_err) = err {
        return db_err.code().as_deref() == Some("23505");
    }
    false
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ImportRow {
    pub title: String,
    pub description: Option<String>,
    pub start_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    pub recurrence_rule: Option<String>,
    pub priority: i16,
    pub status: String,
    pub is_archived: bool,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub tags: Vec<String>,
    pub list_title: Option<String>,
    pub source_key: Option<String>,
    pub parent_key: Option<String>,
    pub is_note: bool,
    pub note_content: Option<String>,
    pub warning: Option<String>,
    pub list_id: Option<Uuid>,
}

// ---------------------------------------------------------------------------
// Decoding / date parsing
// ---------------------------------------------------------------------------

fn decode(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.trim_start_matches('\u{feff}').to_string();
    }
    bytes.iter().map(|b| *b as char).collect()
}

/// Parse a free-form date/datetime string into a UTC instant, mirroring the
/// Python `_parse_dt` fallback chain.
fn parse_dt(value: &str) -> Option<DateTime<Utc>> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if let Ok(d) = NaiveDate::parse_from_str(v, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap()));
    }
    let candidates: [&str; 6] = [
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ];
    for fmt in candidates {
        if fmt.ends_with("%z") {
            if let Ok(dt) = DateTime::parse_from_str(v, fmt) {
                return Some(dt.with_timezone(&Utc));
            }
        } else if let Ok(dt) = NaiveDateTime::parse_from_str(v, fmt) {
            return Some(Utc.from_utc_datetime(&dt));
        }
    }
    for fmt in ["%H:%M:%S", "%H:%M"] {
        if let Ok(t) = NaiveTime::parse_from_str(v, fmt) {
            let today = Utc::now().date_naive();
            return Some(Utc.from_utc_datetime(&today.and_time(t)));
        }
    }
    // RFC3339 last.
    if let Ok(dt) = DateTime::parse_from_rfc3339(v) {
        return Some(dt.with_timezone(&Utc));
    }
    None
}

/// Convert a parsed datetime to a local date in `tz` (fallback UTC).
fn to_local_date(dt: DateTime<Utc>, tz: Option<&str>) -> NaiveDate {
    if let Some(tz) = tz {
        if let Ok(parsed) = tz.parse::<Tz>() {
            return dt.with_timezone(&parsed).date_naive();
        }
    }
    dt.date_naive()
}

fn parse_date_value(value: &str, tz: Option<&str>) -> Option<NaiveDate> {
    parse_dt(value).map(|dt| to_local_date(dt, tz))
}

/// ICS datetime parser (YYYYMMDD, YYYYMMDDTHHMM[SS][Z]).
fn parse_ics_dt(value: &str, tz: Option<&str>) -> Option<NaiveDate> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if v.len() == 8 && v.bytes().all(|b| b.is_ascii_digit()) {
        return NaiveDate::parse_from_str(v, "%Y%m%d").ok();
    }
    let (body, is_utc) = match v.strip_suffix('Z') {
        Some(b) => (b, true),
        None => (v, false),
    };
    for fmt in ["%Y%m%dT%H%M%S", "%Y%m%dT%H%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(body, fmt) {
            if is_utc {
                let utc = Utc.from_utc_datetime(&dt);
                return Some(to_local_date(utc, tz));
            }
            return Some(dt.date());
        }
    }
    let normalized = v.replace('Z', "+00:00");
    DateTime::parse_from_str(&normalized, "%Y%m%dT%H%M%S%z")
        .ok()
        .map(|dt| to_local_date(dt.with_timezone(&Utc), tz))
}

/// Validate an RRULE-ish string. Requires a `FREQ=` token, like a successful
/// `dateutil.rrulestr` parse would.
fn valid_rrule(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let stripped = raw.strip_prefix("RRULE:").unwrap_or(raw).trim();
    if stripped.is_empty() || !stripped.to_uppercase().contains("FREQ=") {
        return None;
    }
    Some(raw.to_string())
}

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

fn map_priority(raw: &str, scale: &str) -> i16 {
    let v = raw.trim().to_lowercase();
    if v.is_empty() {
        return 2;
    }
    match v.as_str() {
        "urgent" | "high" | "p1" | "p2" => return 1,
        "medium" | "normal" | "p3" => return 2,
        "low" | "p4" | "p5" | "none" => return 3,
        _ => {}
    }
    let n: i64 = match v.parse() {
        Ok(n) => n,
        Err(_) => return 2,
    };
    match scale {
        "ticktick" => match n {
            x if x <= 0 => 2,
            x if x <= 2 => 3,
            x if x <= 4 => 2,
            _ => 1,
        },
        "todoist" => match n {
            x if x <= 1 => 3,
            x if x <= 3 => 2,
            _ => 1,
        },
        "ics" => match n {
            0 => 2,
            x if x <= 2 => 1,
            x if x <= 6 => 2,
            _ => 3,
        },
        _ => {
            // generic
            match n {
                x if x <= 1 => 1,
                2 => 2,
                _ => 3,
            }
        }
    }
}

/// Returns (status, is_archived).
fn normalize_status(value: &str) -> (String, bool) {
    let v = value.trim().to_lowercase();
    if v.is_empty() {
        return ("todo".to_string(), false);
    }
    match v.as_str() {
        "done" | "completed" | "complete" | "finished" | "x" | "1" | "true" => {
            ("done".to_string(), false)
        }
        "archived" | "archive" => ("todo".to_string(), true),
        "in_progress" | "in progress" | "doing" => ("in_progress".to_string(), false),
        "cancelled" | "canceled" => ("cancelled".to_string(), false),
        "backlog" => ("backlog".to_string(), false),
        _ => ("todo".to_string(), false),
    }
}

fn split_tags(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn unescape_ics(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn first_content_line(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------
// Format detection + CSV helpers
// ---------------------------------------------------------------------------

fn detect_format(filename: &str, content: &str) -> String {
    let lower = filename.to_lowercase();
    if lower.ends_with(".ics") {
        return "ics".to_string();
    }
    if lower.contains("todoist") {
        return "todoist".to_string();
    }
    if lower.contains("ticktick") {
        return "ticktick".to_string();
    }
    let first = first_content_line(content).to_uppercase();
    if first.contains("BEGIN:VCALENDAR") {
        return "ics".to_string();
    }
    let header = first.to_lowercase();
    let has = |needle: &str| header.contains(needle);
    if has("folder name") && has("list name") && has("title") {
        return "ticktick".to_string();
    }
    if header.starts_with("type") && has("content") {
        return "todoist".to_string();
    }
    "generic".to_string()
}

fn csv_read_all(content: &str) -> Vec<Vec<String>> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(content.as_bytes());
    let mut rows = Vec::new();
    for rec in rdr.records().flatten() {
        let row: Vec<String> = rec.iter().map(|f| f.to_string()).collect();
        if row.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        rows.push(row);
    }
    rows
}

fn pick(map: &HashMap<String, String>, aliases: &[&str]) -> Option<String> {
    for alias in aliases {
        if let Some(v) = map.get(&alias.to_lowercase()) {
            return Some(v.clone());
        }
    }
    None
}

fn pick_nonempty(map: &HashMap<String, String>, aliases: &[&str]) -> Option<String> {
    pick(map, aliases).filter(|v| !v.trim().is_empty())
}

fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "y" | "yes" | "true" | "1"
    )
}

// ---------------------------------------------------------------------------
// TickTick parser
// ---------------------------------------------------------------------------

fn is_ticktick_header(map: &HashMap<String, String>) -> bool {
    if !map.contains_key("title") {
        return false;
    }
    let mut markers = 0;
    for key in ["task id", "parent id", "checklist", "folder name", "list name"] {
        if map.contains_key(key) {
            markers += 1;
        }
    }
    markers >= 2
}

#[allow(dead_code)]
fn parse_checklist_items(content: &str) -> Vec<(String, bool)> {
    let single = content.trim();
    let mut items = Vec::new();
    if !single.contains('\n') {
        let c = single.trim_start_matches(['\u{25ab}', '\u{25aa}', '\u{2022}', '*', '-']);
        if c.len() < single.len() {
            for part in c.split(['\u{25ab}', '\u{25aa}', '\u{2022}']) {
                let p = part.trim();
                if !p.is_empty() {
                    items.push((p.to_string(), false));
                }
            }
            if !items.is_empty() {
                return items;
            }
        }
    }
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let stripped = t.trim_start_matches(['\u{25ab}', '\u{25aa}', '\u{2022}', '-', '*']);
        if stripped.len() != t.len() || t.starts_with('[') {
            let mut body = stripped.trim();
            let mut done = false;
            if body.starts_with('[') {
                if let Some(end) = body.find(']') {
                    let mark = body[1..end].trim();
                    done = mark.eq_ignore_ascii_case("x");
                    body = body[end + 1..].trim();
                }
            }
            if body.starts_with('[') {
                if let Some(end) = body.find(']') {
                    let mark = body[1..end].trim();
                    done = mark.eq_ignore_ascii_case("x");
                    body = body[end + 1..].trim();
                }
            }
            if !body.is_empty() {
                items.push((body.to_string(), done));
            }
        }
    }
    items
}

fn checklist_stripped(content: &str) -> String {
    let mut kept = Vec::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let marker = t.starts_with(['\u{25ab}', '\u{25aa}', '\u{2022}', '-', '*']) || t.starts_with('[');
        if !marker {
            kept.push(t);
        }
    }
    kept.join("\n")
}

fn map_ticktick_status(status: &str, completed: Option<&str>) -> (String, bool) {
    if completed.is_some() {
        return ("done".to_string(), false);
    }
    match status.trim() {
        "1" => ("done".to_string(), false),
        "2" | "-1" => ("todo".to_string(), true),
        _ => ("todo".to_string(), false),
    }
}

fn parse_ticktick(content: &str) -> Vec<ImportRow> {
    let rows = csv_read_all(content);
    let mut out = Vec::new();
    let mut header: Option<Vec<String>> = None;
    let mut ordinal = 0usize;
    for row in &rows {
        if header.is_none() {
            let lower: Vec<String> = row.iter().map(|c| c.trim().to_lowercase()).collect();
            let probe: HashMap<String, String> = lower
                .iter()
                .enumerate()
                .map(|(i, k)| (k.clone(), i.to_string()))
                .collect();
            if is_ticktick_header(&probe) {
                header = Some(lower);
            }
            continue;
        }
        ordinal += 1;
        let h = header.as_ref().unwrap();
        let mut mapped: HashMap<String, String> = HashMap::new();
        for (i, key) in h.iter().enumerate() {
            if !key.is_empty() {
                mapped.insert(key.clone(), row.get(i).cloned().unwrap_or_default());
            }
        }
        parse_ticktick_row(&mapped, ordinal, &mut out);
    }
    out
}

fn parse_ticktick_row(map: &HashMap<String, String>, ordinal: usize, out: &mut Vec<ImportRow>) {
    let title = map.get("title").cloned().unwrap_or_default();
    let content = map.get("content").cloned().unwrap_or_default();
    let checklist = map.get("checklist").cloned().unwrap_or_default();
    if title.trim().is_empty() && content.trim().is_empty() {
        return;
    }
    let list_name = map
        .get("list name")
        .cloned()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| map.get("folder name").cloned().filter(|v| !v.trim().is_empty()));
    let is_note = list_name
        .as_deref()
        .map(|n| n.trim().eq_ignore_ascii_case("notes"))
        .unwrap_or(false);
    let completed = map
        .get("completed time")
        .cloned()
        .filter(|v| !v.trim().is_empty());
    let status = map.get("status").cloned().unwrap_or_default();
    let (status_value, archived) = map_ticktick_status(&status, completed.as_deref());
    let is_checklist = truthy(&map.get("is checklist").cloned().unwrap_or_default());
    let description = if is_checklist {
        checklist_stripped(&checklist)
    } else {
        content.clone()
    };
    let tz = map.get("timezone").cloned();
    let repeat = map.get("repeat").cloned().filter(|v| !v.trim().is_empty());
    let recurrence = repeat.as_deref().and_then(valid_rrule);
    let warning = if repeat.is_some() && recurrence.is_none() {
        Some("Invalid recurrence rule dropped".to_string())
    } else {
        None
    };
    let source_key = map
        .get("task id")
        .cloned()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("row-{ordinal}"));
    let parent_key = map
        .get("parent id")
        .cloned()
        .filter(|v| !v.trim().is_empty());
    let tags = split_tags(&map.get("tags").cloned().unwrap_or_default());
    out.push(ImportRow {
        title: if title.trim().is_empty() {
            first_content_line(&content).chars().take(500).collect()
        } else {
            title
        },
        description: Some(description).filter(|d| !d.trim().is_empty()),
        start_date: map
            .get("start date")
            .and_then(|v| parse_date_value(v, tz.as_deref())),
        due_date: map
            .get("due date")
            .and_then(|v| parse_date_value(v, tz.as_deref())),
        recurrence_rule: recurrence,
        priority: map_priority(&map.get("priority").cloned().unwrap_or_default(), "ticktick"),
        status: status_value,
        is_archived: archived,
        completed_at: completed.as_deref().and_then(parse_dt),
        created_at: map.get("created time").and_then(|v| parse_dt(v)),
        tags,
        list_title: list_name,
        source_key: Some(source_key.clone()),
        parent_key,
        is_note,
        note_content: Some(content).filter(|c| !c.trim().is_empty()),
        warning,
        list_id: None,
    });
}

// ---------------------------------------------------------------------------
// Todoist parser
// ---------------------------------------------------------------------------

fn parse_todoist(content: &str) -> Vec<ImportRow> {
    let rows = csv_read_all(content);
    let mut out = Vec::new();
    if rows.len() <= 1 {
        return out;
    }
    let header: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase()).collect();
    let mut stack: Vec<(i64, String)> = Vec::new();
    for row in &rows[1..] {
        let mut map: HashMap<String, String> = HashMap::new();
        for (i, key) in header.iter().enumerate() {
            if !key.is_empty() {
                map.insert(key.clone(), row.get(i).cloned().unwrap_or_default());
            }
        }
        let title = pick_nonempty(&map, &["content"]).unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        let indent: i64 = pick(&map, &["indent"])
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(1)
            .max(1);
        let source_key = Uuid::new_v4().simple().to_string();
        while let Some((top_indent, _)) = stack.last() {
            if *top_indent >= indent {
                stack.pop();
            } else {
                break;
            }
        }
        let parent_key = stack.last().map(|(_, key)| key.clone());
        stack.push((indent, source_key.clone()));
        let type_cell = pick(&map, &["type"]).unwrap_or_default().to_lowercase();
        let is_done = type_cell.contains("completed");
        let is_note = type_cell == "note";
        let due = pick(&map, &["date"]).and_then(|v| parse_date_value(&v, None));
        let mut tags = split_tags(&pick(&map, &["labels"]).unwrap_or_default());
        if let Some(project) = pick_nonempty(&map, &["project"]) {
            tags.push(format!("Project: {project}"));
        }
        out.push(ImportRow {
            title,
            description: pick_nonempty(&map, &["description"]),
            start_date: None,
            due_date: due,
            recurrence_rule: None,
            priority: 2,
            status: if is_done { "done".to_string() } else { "todo".to_string() },
            is_archived: false,
            completed_at: None,
            created_at: None,
            tags,
            list_title: None,
            source_key: Some(source_key),
            parent_key,
            is_note,
            note_content: pick_nonempty(&map, &["description"]),
            warning: None,
            list_id: None,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Generic parser
// ---------------------------------------------------------------------------

fn generic_header_map() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("title", vec!["title", "name", "task", "task name", "subject"]),
        ("due", vec!["due", "due date", "due_date", "deadline"]),
        ("start", vec!["start", "start date", "start_date", "date"]),
        ("desc", vec!["description", "desc", "notes", "content", "body"]),
        ("tags", vec!["tags", "labels", "categories", "category"]),
        ("parent", vec!["parent", "parent task", "parent_task", "project"]),
        ("priority", vec!["priority", "importance"]),
        ("status", vec!["status", "state"]),
        ("recurrence", vec!["recurrence", "repeat", "rrule", "recurrence_rule"]),
        ("completed", vec!["completed", "completed_at", "done"]),
        ("archived", vec!["archived", "is_archived", "archive"]),
    ]
}

fn parse_generic(content: &str) -> Vec<ImportRow> {
    let rows = csv_read_all(content);
    let mut out = Vec::new();
    if rows.len() <= 1 {
        return out;
    }
    let header: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase()).collect();
    let spec = generic_header_map();
    // Resolve each field to a column index once.
    let mut field_index: HashMap<&str, usize> = HashMap::new();
    for (field, aliases) in &spec {
        for (i, key) in header.iter().enumerate() {
            if aliases.contains(&key.as_str()) {
                field_index.entry(field).or_insert(i);
                break;
            }
        }
    }
    let get = |map: &HashMap<String, String>, field: &str| -> Option<String> {
        field_index
            .get(field)
            .and_then(|idx| map.get(&idx.to_string()))
            .cloned()
            .filter(|v| !v.trim().is_empty())
    };
    for row in &rows[1..] {
        let mut map: HashMap<String, String> = HashMap::new();
        for (i, _) in header.iter().enumerate() {
            map.insert(i.to_string(), row.get(i).cloned().unwrap_or_default());
        }
        let title = get(&map, "title").unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        let completed = get(&map, "completed");
        let status_raw = get(&map, "status");
        let (mut status, mut archived) = match status_raw {
            Some(s) => normalize_status(&s),
            None if completed.is_some() => ("done".to_string(), false),
            None => ("todo".to_string(), false),
        };
        if archived {
            status = "todo".to_string();
        }
        if get(&map, "archived").map(|v| truthy(&v)).unwrap_or(false) {
            archived = true;
        }
        out.push(ImportRow {
            title,
            description: get(&map, "desc"),
            start_date: get(&map, "start").and_then(|v| parse_date_value(&v, None)),
            due_date: get(&map, "due").and_then(|v| parse_date_value(&v, None)),
            recurrence_rule: get(&map, "recurrence").and_then(|v| valid_rrule(&v)),
            priority: map_priority(&get(&map, "priority").unwrap_or_default(), "generic"),
            status,
            is_archived: archived,
            completed_at: completed.as_deref().and_then(parse_dt),
            created_at: None,
            tags: split_tags(&get(&map, "tags").unwrap_or_default()),
            list_title: None,
            source_key: None,
            parent_key: get(&map, "parent"),
            is_note: false,
            note_content: None,
            warning: None,
            list_id: None,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// ICS parser
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct IcsComponent {
    name: String,
    props: Vec<(String, String, String)>,
}

fn parse_ics(content: &str) -> Vec<ImportRow> {
    // Unfold continuation lines.
    let mut unfolded: Vec<String> = Vec::new();
    for raw in content.lines() {
        if raw.starts_with(' ') || raw.starts_with('\t') {
            if let Some(last) = unfolded.last_mut() {
                last.push_str(&raw[1..]);
                continue;
            }
        }
        unfolded.push(raw.to_string());
    }
    // Component stack; only direct children of VTODO/VEVENT collect props.
    let mut stack: Vec<IcsComponent> = Vec::new();
    let mut components: Vec<IcsComponent> = Vec::new();
    for line in &unfolded {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(name) = trimmed.strip_prefix("BEGIN:") {
            stack.push(IcsComponent {
                name: name.trim().to_uppercase(),
                props: Vec::new(),
            });
            continue;
        }
        if trimmed.starts_with("END:") {
            if let Some(done) = stack.pop() {
                if done.name == "VTODO" || done.name == "VEVENT" {
                    components.push(done);
                }
            }
            continue;
        }
        let parent_name = stack
            .get(stack.len().saturating_sub(2))
            .map(|p| p.name.clone())
            .unwrap_or_default();
        if let Some(current) = stack.last_mut() {
            if parent_name == "VTODO" || parent_name == "VEVENT" {
                if let Some((key, params, value)) = split_ics_prop(trimmed) {
                    current.props.push((key, params, value));
                }
            }
        }
    }
    let mut out = Vec::new();
    for comp in components {
        if let Some(row) = ics_component_to_row(&comp) {
            out.push(row);
        }
    }
    out
}

fn split_ics_prop(line: &str) -> Option<(String, String, String)> {
    let colon = line.find(':')?;
    let head = &line[..colon];
    let value = &line[colon + 1..];
    let mut pieces = head.split(';');
    let key = pieces.next()?.trim().to_uppercase();
    let params: Vec<&str> = pieces.collect();
    Some((key, params.join(";"), unescape_ics(value)))
}

fn ics_component_to_row(comp: &IcsComponent) -> Option<ImportRow> {
    let prop = |name: &str| -> Option<&(String, String, String)> {
        comp.props.iter().find(|(k, _, _)| k == name)
    };
    let summary = prop("SUMMARY")?.2.clone();
    if summary.trim().is_empty() {
        return None;
    }
    let tz = comp
        .props
        .iter()
        .find(|(k, params, _)| k == "DTSTART" && params.contains("TZID="))
        .and_then(|(_, params, _)| {
            params
                .split(';')
                .find_map(|p| p.strip_prefix("TZID=").map(|s| s.to_string()))
        });
    let start = prop("DTSTART").and_then(|(_, _, v)| parse_ics_dt(v, tz.as_deref()));
    let due = prop("DTEND")
        .or_else(|| prop("DUE"))
        .and_then(|(_, _, v)| parse_ics_dt(v, tz.as_deref()));
    let status_raw = prop("STATUS").map(|(_, _, v)| v.clone()).unwrap_or_default();
    let completed_val = prop("COMPLETED").map(|(_, _, v)| v.clone());
    let is_done = status_raw.eq_ignore_ascii_case("COMPLETED") || completed_val.is_some();
    let rule = prop("RRULE").map(|(_, _, v)| v.clone());
    let recurrence = rule.as_deref().and_then(valid_rrule);
    let warning = if rule.is_some() && recurrence.is_none() {
        Some("Invalid recurrence rule dropped".to_string())
    } else {
        None
    };
    let tags = prop("CATEGORIES")
        .map(|(_, _, v)| split_tags(&v.replace("\\,", ",")))
        .unwrap_or_default();
    Some(ImportRow {
        title: summary,
        description: prop("DESCRIPTION").map(|(_, _, v)| v.clone()).filter(|d| !d.is_empty()),
        start_date: start,
        due_date: due,
        recurrence_rule: recurrence,
        priority: map_priority(
            &prop("PRIORITY").map(|(_, _, v)| v.clone()).unwrap_or_default(),
            "ics",
        ),
        status: if is_done { "done".to_string() } else { "todo".to_string() },
        is_archived: false,
        completed_at: if is_done {
            completed_val.as_deref().and_then(parse_ics_datetime_utc)
        } else {
            None
        },
        created_at: prop("CREATED")
            .and_then(|(_, _, v)| parse_dt(v))
            .or_else(|| {
                prop("CREATED")
                    .and_then(|(_, _, v)| parse_ics_datetime_utc(v))
            }),
        tags,
        list_title: None,
        source_key: None,
        parent_key: None,
        is_note: false,
        note_content: None,
        warning,
        list_id: None,
    })
}

fn parse_ics_datetime_utc(value: &str) -> Option<DateTime<Utc>> {
    let v = value.trim();
    let (body, is_utc) = match v.strip_suffix('Z') {
        Some(b) => (b, true),
        None => (v, false),
    };
    for fmt in ["%Y%m%dT%H%M%S", "%Y%m%dT%H%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(body, fmt) {
            return Some(Utc.from_utc_datetime(&dt));
        }
    }
    if is_utc {
        return parse_dt(v);
    }
    None
}

// ---------------------------------------------------------------------------
// Import execution
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Stats {
    total: i64,
    imported: i64,
    skipped: i64,
    failed: i64,
    notes_imported: i64,
}

async fn insert_task(
    conn: &mut PgConnection,
    user_id: Uuid,
    row: &ImportRow,
    batch_id: Uuid,
    list_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    let (status, _) = normalize_status(&row.status);
    let rec = sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, board_section_id, title, description, \
         status, priority, start_date, due_date, recurrence_rule, recurrence_end_date, list_id, \
         is_all_day, is_archived, sort_order, completed_at, created_at, updated_at, import_batch_id) \
         VALUES ($1, NULL, NULL, $2, $3, $4::task_status, $5, $6, $7, $8, NULL, $9, \
         false, $10, 0, $11, COALESCE($12, now()), now(), $13) \
         RETURNING id",
    )
    .bind(user_id)
    .bind(&row.title)
    .bind(&row.description)
    .bind(&status)
    .bind(row.priority)
    .bind(row.start_date)
    .bind(row.due_date)
    .bind(&row.recurrence_rule)
    .bind(list_id)
    .bind(row.is_archived)
    .bind(row.completed_at)
    .bind(row.created_at)
    .bind(batch_id)
    .fetch_one(&mut *conn)
    .await?;
    rec.try_get::<Uuid, _>("id")
}

async fn attach_tags(
    conn: &mut PgConnection,
    user_id: Uuid,
    task_id: Uuid,
    tags: &[String],
) -> Result<(), sqlx::Error> {
    for tag in tags {
        let name: String = tag.chars().take(50).collect();
        if name.trim().is_empty() {
            continue;
        }
        let tag_id: Uuid = if let Some(existing) = sqlx::query(
            "SELECT id FROM tags WHERE user_id = $1 AND name = $2 LIMIT 1",
        )
        .bind(user_id)
        .bind(&name)
        .fetch_optional(&mut *conn)
        .await?
        {
            existing.try_get::<Uuid, _>("id")?
        } else {
            sqlx::query("INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id")
                .bind(user_id)
                .bind(&name)
                .fetch_one(&mut *conn)
                .await?
                .try_get::<Uuid, _>("id")?
        };
        let _ = sqlx::query(
            "INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(task_id)
        .bind(tag_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

async fn insert_note(
    conn: &mut PgConnection,
    user_id: Uuid,
    row: &ImportRow,
    batch_id: Uuid,
) -> Result<(), sqlx::Error> {
    let note_id = format!("imp-{}", Uuid::new_v4().simple());
    let title: String = row.title.chars().take(300).collect();
    let content_raw = row
        .note_content
        .clone()
        .or_else(|| row.description.clone())
        .unwrap_or_default();
    let content: String = content_raw.chars().take(20000).collect();
    sqlx::query(
        "INSERT INTO notes (id, user_id, import_batch_id, title, content, color, x, y, width, \
         height, minimized, open, sort, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, '#fbbf24', 300, 200, 320, 240, false, false, 0, now(), now())",
    )
    .bind(&note_id)
    .bind(user_id)
    .bind(batch_id)
    .bind(&title)
    .bind(&content)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

struct ListCache {
    by_name: HashMap<String, Uuid>,
    next_position: i64,
}

async fn get_or_create_list(
    conn: &mut PgConnection,
    user_id: Uuid,
    name: &str,
    cache: &mut ListCache,
) -> Result<Option<Uuid>, sqlx::Error> {
    let key = name.trim().to_lowercase();
    if key.is_empty() {
        return Ok(None);
    }
    if let Some(id) = cache.by_name.get(&key) {
        return Ok(Some(*id));
    }
    if let Some(row) =
        sqlx::query("SELECT id FROM lists WHERE user_id = $1 AND lower(name) = $2 LIMIT 1")
            .bind(user_id)
            .bind(&key)
            .fetch_optional(&mut *conn)
            .await?
    {
        let id = row.try_get::<Uuid, _>("id")?;
        cache.by_name.insert(key, id);
        return Ok(Some(id));
    }
    if cache.by_name.len() >= 200 {
        return Ok(None);
    }
    let trimmed: String = name.trim().chars().take(200).collect();
    let rec =
        sqlx::query("INSERT INTO lists (user_id, name, position) VALUES ($1, $2, $3) RETURNING id")
            .bind(user_id)
            .bind(&trimmed)
            .bind(cache.next_position)
            .fetch_one(&mut *conn)
            .await?;
    let id = rec.try_get::<Uuid, _>("id")?;
    cache.by_name.insert(key, id);
    Ok(Some(id))
}

pub async fn run_import(
    conn: &mut PgConnection,
    user_id: Uuid,
    rows: &mut [ImportRow],
    notes_as_notes: bool,
    batch_id: Uuid,
) -> Result<(Value, Vec<Value>), ApiError> {
    let mut stats = Stats::default();
    stats.total = rows.len() as i64;
    let mut errors: Vec<Value> = Vec::new();

    // Existing task dedupe keys.
    let existing_rows = sqlx::query(
        "SELECT title, start_date, due_date FROM tasks \
         WHERE user_id = $1 AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;
    let mut existing: HashSet<String> = HashSet::new();
    for r in &existing_rows {
        let title: String = r.try_get("title").unwrap_or_default();
        let start: Option<NaiveDate> = r.try_get("start_date").ok();
        let due: Option<NaiveDate> = r.try_get("due_date").ok();
        existing.insert(format!(
            "{}|{}|{}",
            title,
            start.map(|d| d.to_string()).unwrap_or_default(),
            due.map(|d| d.to_string()).unwrap_or_default()
        ));
    }
    let existing_notes = sqlx::query("SELECT title, content FROM notes WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db_error)?;
    let mut note_keys: HashSet<String> = HashSet::new();
    for r in &existing_notes {
        note_keys.insert(format!(
            "{}|{}",
            r.try_get::<String, _>("title").unwrap_or_default(),
            r.try_get::<String, _>("content").unwrap_or_default()
        ));
    }

    let mut list_cache = ListCache {
        by_name: HashMap::new(),
        next_position: sqlx::query_scalar::<_, i32>(
            "SELECT COALESCE(MAX(position), 0) FROM lists WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db_error)? as i64,
    };

    // Resolve lists for every row up-front.
    for row in rows.iter_mut() {
        if let Some(list_title) = row.list_title.clone() {
            row.list_id = get_or_create_list(conn, user_id, &list_title, &mut list_cache)
                .await
                .map_err(db_error)?;
        }
    }
    // Rows without a list fall back to the user's default "My Tasks" list.
    let default_list = crate::task::default_list_id(&mut *conn, user_id)
        .await
        .map_err(db_error)?;
    for row in rows.iter_mut() {
        if !row.is_note && row.list_id.is_none() {
            row.list_id = Some(default_list);
        }
    }

    let mut source_ids: HashMap<String, Uuid> = HashMap::new();
    let mut title_ids: HashMap<String, Uuid> = HashMap::new();
    let mut pending_children: Vec<usize> = Vec::new();

    // Pass 1: notes + top-level tasks.
    for (idx, row) in rows.iter().enumerate() {
        if row.is_note && notes_as_notes {
            let content_raw = row
                .note_content
                .clone()
                .or_else(|| row.description.clone())
                .unwrap_or_default();
            let key = format!("{}|{}", row.title, content_raw);
            if note_keys.contains(&key) {
                stats.skipped += 1;
                continue;
            }
            note_keys.insert(key);
            match insert_note(conn, user_id, row, batch_id).await {
                Ok(_) => stats.notes_imported += 1,
                Err(e) => {
                    stats.failed += 1;
                    if errors.len() < MAX_ERRORS {
                        errors.push(json!({"title": row.title, "error": e.to_string()}));
                    }
                }
            }
            continue;
        }
        if row.parent_key.is_some() {
            pending_children.push(idx);
            continue;
        }
        import_one(conn, user_id, row, batch_id, &mut stats, &mut errors, &mut existing, &mut source_ids, &mut title_ids).await;
    }

    // Pass 2: children with multi-round resolution.
    let mut remaining = pending_children;
    loop {
        let mut progressed = false;
        let mut still: Vec<usize> = Vec::new();
        for idx in remaining {
            let row = &rows[idx];
            let parent = row
                .parent_key
                .as_ref()
                .and_then(|k| source_ids.get(k).or_else(|| title_ids.get(k)).copied());
            match parent {
                Some(parent_id) => {
                    import_child(conn, user_id, row, batch_id, parent_id, &mut stats, &mut errors, &mut existing, &mut source_ids, &mut title_ids).await;
                    progressed = true;
                }
                None => still.push(idx),
            }
        }
        remaining = still;
        if !progressed || remaining.is_empty() {
            break;
        }
    }
    // Orphans promoted to top level.
    for idx in remaining {
        stats.failed += 1;
        if errors.len() < MAX_ERRORS {
            errors.push(json!({
                "title": rows[idx].title,
                "error": "Parent task not found; imported as a top-level task"
            }));
        }
        let row = &rows[idx];
        let mut promoted = row.clone();
        promoted.parent_key = None;
        import_one(conn, user_id, &promoted, batch_id, &mut stats, &mut errors, &mut existing, &mut source_ids, &mut title_ids).await;
    }

    Ok((
        json!({
            "total_rows": stats.total,
            "imported": stats.imported,
            "skipped": stats.skipped,
            "failed": stats.failed,
            "notes_imported": stats.notes_imported,
            "errors": errors,
        }),
        errors,
    ))
}

#[allow(clippy::too_many_arguments)]
async fn import_one(
    conn: &mut PgConnection,
    user_id: Uuid,
    row: &ImportRow,
    batch_id: Uuid,
    stats: &mut Stats,
    errors: &mut Vec<Value>,
    existing: &mut HashSet<String>,
    source_ids: &mut HashMap<String, Uuid>,
    title_ids: &mut HashMap<String, Uuid>,
) {
    if row.title.trim().is_empty() || row.title.chars().count() > 500 {
        stats.skipped += 1;
        return;
    }
    let key = format!(
        "{}|{}|{}",
        row.title,
        row.start_date.map(|d| d.to_string()).unwrap_or_default(),
        row.due_date.map(|d| d.to_string()).unwrap_or_default()
    );
    if existing.contains(&key) {
        stats.skipped += 1;
        return;
    }
    existing.insert(key);
    let list_id = row.list_id.unwrap_or_else(Uuid::nil);
    match insert_task(conn, user_id, row, batch_id, list_id).await {
        Ok(id) => {
            stats.imported += 1;
            if let Some(sk) = &row.source_key {
                source_ids.insert(sk.clone(), id);
            }
            title_ids.entry(row.title.clone()).or_insert(id);
            if let Err(e) = attach_tags(conn, user_id, id, &row.tags).await {
                if errors.len() < MAX_ERRORS {
                    errors.push(json!({"title": row.title, "error": e.to_string()}));
                }
            }
            if row.recurrence_rule.is_some() {
                if let Ok(Some(created)) =
                    crate::task::find_task(conn, id, user_id, false).await
                {
                    let _ = crate::recurring::expand_task_occurrences(conn, &created).await;
                }
            }
        }
        Err(e) => {
            stats.failed += 1;
            if errors.len() < MAX_ERRORS {
                errors.push(json!({"title": row.title, "error": e.to_string()}));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn import_child(
    conn: &mut PgConnection,
    user_id: Uuid,
    row: &ImportRow,
    batch_id: Uuid,
    parent_id: Uuid,
    stats: &mut Stats,
    errors: &mut Vec<Value>,
    _existing: &mut HashSet<String>,
    source_ids: &mut HashMap<String, Uuid>,
    title_ids: &mut HashMap<String, Uuid>,
) {
    if row.title.trim().is_empty() || row.title.chars().count() > 500 {
        stats.skipped += 1;
        return;
    }
    let (status, _) = normalize_status(&row.status);
    let result = sqlx::query(
        "INSERT INTO tasks (user_id, parent_task_id, board_section_id, title, description, \
         status, priority, start_date, due_date, recurrence_rule, list_id, is_all_day, \
         is_archived, sort_order, completed_at, created_at, updated_at, import_batch_id) \
         VALUES ($1, $2, NULL, $3, $4, $5::task_status, $6, $7, $8, $9, $10, false, $11, 0, \
         $12, COALESCE($13, now()), now(), $14) \
         RETURNING id",
    )
    .bind(user_id)
    .bind(parent_id)
    .bind(&row.title)
    .bind(&row.description)
    .bind(&status)
    .bind(row.priority)
    .bind(row.start_date)
    .bind(row.due_date)
    .bind(&row.recurrence_rule)
    .bind(row.list_id)
    .bind(row.is_archived)
    .bind(row.completed_at)
    .bind(row.created_at)
    .bind(batch_id)
    .fetch_one(&mut *conn)
    .await;
    match result {
        Ok(rec) => {
            stats.imported += 1;
            if let Ok(id) = rec.try_get::<Uuid, _>("id") {
                if let Some(sk) = &row.source_key {
                    source_ids.insert(sk.clone(), id);
                }
                title_ids.entry(row.title.clone()).or_insert(id);
                let _ = attach_tags(conn, user_id, id, &row.tags).await;
            }
        }
        Err(e) => {
            stats.failed += 1;
            if errors.len() < MAX_ERRORS {
                errors.push(json!({"title": row.title, "error": e.to_string()}));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct UndoRequest {
    batch_id: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/imports/tasks", post(import_tasks))
        .route("/api/imports/tasks/", post(import_tasks))
        .route("/api/imports/tasks/undo", post(undo_import))
}

async fn import_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut filename = String::new();
    let mut format = "auto".to_string();
    let mut notes_as_notes = true;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Invalid multipart body: {e}")))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "file" => {
                filename = field.file_name().unwrap_or_default().to_string();
                file_bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| ApiError::BadRequest(format!("Could not read file: {e}")))?
                        .to_vec(),
                );
            }
            "format" => {
                format = field.text().await.unwrap_or_else(|_| "auto".to_string());
            }
            "notes_as_notes" => {
                let raw = field.text().await.unwrap_or_default();
                notes_as_notes = !matches!(raw.trim().to_lowercase().as_str(), "false" | "0" | "no");
            }
            _ => {}
        }
    }

    if !VALID_FORMATS.contains(&format.as_str()) {
        return Err(ApiError::Unprocessable(
            "Invalid format. Must be one of: auto, generic, ics, ticktick, todoist".to_string(),
        ));
    }
    let bytes = file_bytes.ok_or_else(|| ApiError::BadRequest("Empty file".to_string()))?;
    if bytes.is_empty() {
        return Err(ApiError::BadRequest("Empty file".to_string()));
    }
    let content = decode(&bytes);
    if content.trim().is_empty() {
        return Err(ApiError::BadRequest("Empty file".to_string()));
    }

    let resolved = if format == "auto" {
        detect_format(&filename, &content)
    } else {
        format
    };
    let mut rows = match resolved.as_str() {
        "ticktick" => parse_ticktick(&content),
        "todoist" => parse_todoist(&content),
        "ics" => parse_ics(&content),
        _ => parse_generic(&content),
    };
    let max_rows = state.settings.import_max_rows();
    if rows.len() as i64 > max_rows {
        return Err(ApiError::BadRequest(format!(
            "This file has {} rows, above the {max_rows}-row limit. Split the file and import in parts.",
            rows.len()
        )));
    }

    // Per-user single-flight.
    {
        let mut active = active_imports().lock().unwrap();
        if active.contains(&user.user_id) {
            return Err(ApiError::Conflict(
                "An import is already running for your account. Wait for it to finish before starting another."
                    .to_string(),
            ));
        }
        active.insert(user.user_id);
    }

    let batch_id = Uuid::new_v4();
    let result = async {
        let mut tx = state.pool.begin().await.map_err(db_error)?;
        db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;
        let (summary, _errors) =
            run_import(&mut *tx, user.user_id, &mut rows, notes_as_notes, batch_id).await?;
        tx.commit().await.map_err(db_error)?;
        Ok::<Value, ApiError>(summary)
    }
    .await;

    active_imports().lock().unwrap().remove(&user.user_id);

    let summary = result?;
    let mut body = summary;
    if let Value::Object(ref mut map) = body {
        map.insert("batch_id".to_string(), json!(batch_id.to_string()));
    }
    Ok(Json(body))
}

async fn undo_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UndoRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let batch_id = Uuid::parse_str(body.batch_id.trim())
        .map_err(|_| ApiError::NotFound("No import batch found to undo".to_string()))?;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "").await.map_err(db_error)?;

    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM tasks WHERE user_id = $1 AND import_batch_id = $2 AND deleted_at IS NULL",
    )
    .bind(user.user_id)
    .bind(batch_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;
    if ids.is_empty() {
        return Err(ApiError::NotFound(
            "No import batch found to undo".to_string(),
        ));
    }

    // BFS descendants via parent_task_id.
    let mut seen: HashSet<Uuid> = ids.iter().copied().collect();
    let mut frontier = ids.clone();
    loop {
        let children: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM tasks WHERE user_id = $1 AND parent_task_id = ANY($2::uuid[])",
        )
        .bind(user.user_id)
        .bind(&frontier)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
        let fresh: Vec<Uuid> = children
            .into_iter()
            .filter(|id| !seen.contains(id))
            .collect();
        if fresh.is_empty() {
            break;
        }
        for id in &fresh {
            seen.insert(*id);
        }
        frontier = fresh;
    }
    let all_ids: Vec<Uuid> = seen.into_iter().collect();

    let deleted_tasks = sqlx::query(
        "UPDATE tasks SET deleted_at = now(), updated_at = now() \
         WHERE user_id = $1 AND id = ANY($2::uuid[])",
    )
    .bind(user.user_id)
    .bind(&all_ids)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?
    .rows_affected();

    let deleted_notes = sqlx::query("DELETE FROM notes WHERE user_id = $1 AND import_batch_id = $2")
        .bind(user.user_id)
        .bind(batch_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?
        .rows_affected();

    tx.commit().await.map_err(db_error)?;

    Ok(Json(json!({
        "deleted_tasks": deleted_tasks,
        "deleted_notes": deleted_notes,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{jwt, user};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn live_state() -> Option<AppState> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let settings = crate::config::Settings {
            database_url: url,
            jwt_secret_key: "test-secret-key-that-is-at-least-32-chars!".to_string(),
            encryption_key: String::new(),
            port: 8000,
            git_sha: None,
            environment: "test".to_string(),
            app_origin: "http://localhost:3000".to_string(),
            webauthn_rp_id: String::new(),
            webauthn_rp_name: "Prysm Note".to_string(),
            webauthn_origins: String::new(),
            oauth_redirect_uri: "http://localhost:3000/api/auth/oauth/google/callback".to_string(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            github_client_id: String::new(),
            github_client_secret: String::new(),
            redis_url: String::new(),
            csrf_enabled: false,
            csrf_allowed_origins: "http://localhost:3000".to_string(),
            api_rate_limit_enabled: false,
            api_rate_limit_per_min: 120,
            cors_origins: "http://localhost:3000".to_string(),
            notifications_enabled: false,
            vapid_private_key: String::new(),
            vapid_subject: "mailto:support@prysmnote.com".to_string(),
            notify_email: String::new(),
            notification_loop_interval: 1800,
            digest_hour: 7,
        };
        Some(AppState::lazy(settings))
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn imports_generic_csv_then_undo() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-imports-{}@test.local", Uuid::new_v4());
        let user = user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();

        let csv = "title,due,priority,tags\nBuy milk,2030-01-02,high,errand\nCall mom,,low,\n";
        let boundary = "----prysmtestboundary";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"tasks.csv\"\r\nContent-Type: text/csv\r\n\r\n",
        );
        body.extend_from_slice(csv.as_bytes());
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let app = router().merge(crate::tasks::router()).with_state(state.clone());
        let req = Request::builder()
            .method("POST")
            .uri("/api/imports/tasks")
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .header("cookie", format!("access_token={token}"))
            .body(Body::from(body))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let out = body_json(res).await;
        assert_eq!(out["imported"], 2, "unexpected: {out}");
        let batch_id = out["batch_id"].as_str().unwrap().to_string();

        // Undo.
        let req = Request::builder()
            .method("POST")
            .uri("/api/imports/tasks/undo")
            .header("content-type", "application/json")
            .header("cookie", format!("access_token={token}"))
            .body(Body::from(json!({"batch_id": batch_id}).to_string()))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let out = body_json(res).await;
        assert_eq!(out["deleted_tasks"], 2, "unexpected: {out}");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_unknown_format() {
        let Some(state) = live_state().await else {
            return;
        };
        let email = format!("rust-imports-fmt-{}@test.local", Uuid::new_v4());
        let user = user::create_email_user(&state.pool, &email, "not-a-real-hash", None)
            .await
            .unwrap();
        let token = jwt::encode_access(&state.settings.jwt_secret_key, &user.id.to_string(), 0).unwrap();

        let boundary = "----prysmtestboundary";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"x.csv\"\r\n\r\n",
        );
        body.extend_from_slice(b"title\nA\n");
        body.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"format\"\r\n\r\nnope\r\n");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        let app = router().with_state(state.clone());
        let req = Request::builder()
            .method("POST")
            .uri("/api/imports/tasks")
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .header("cookie", format!("access_token={token}"))
            .body(Body::from(body))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user.id)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
