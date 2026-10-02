//! Text helpers for the AI chat path.
//!
//! Mirrors Python `services/ai_shared.py`: the text tool call protocol
//! (`[TOOL_CALLS] <name> {json}` blocks that some models emit inline instead of
//! using the native tool-call field), the SSE-safe text chunker, and the
//! markdown repair pass `_normalize_reply_markdown` (streaming artifacts,
//! fragmented/merged words, stray punctuation spacing, one-token-per-line
//! reflow and cross-line broken dates). The repair runs before assistant text
//! is persisted so the stored conversation matches what the user sees.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::common_words::COMMON_WORDS;

/// Marker that opens an inline tool call block.
pub const TEXT_TOOL_CALL_MARKER: &str = "[TOOL_CALLS]";

/// Split text into chunks of at most `size` characters, preferring space
/// boundaries (mirrors `_chunk_text`).
pub fn chunk_text(text: &str, size: usize) -> Vec<String> {
    if text.chars().count() <= size {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split(' ') {
        if !current.is_empty() && current.chars().count() + word.chars().count() + 1 > size {
            chunks.push(std::mem::take(&mut current));
            current = word.to_string();
        } else {
            current = if current.is_empty() {
                word.to_string()
            } else {
                format!("{current} {word}").trim().to_string()
            };
        }
    }
    chunks.push(current);
    chunks
}

/// Skip leading whitespace, read an identifier (`[A-Za-z_][A-Za-z0-9_]*`), then
/// skip trailing whitespace. Returns the identifier and the consumed byte
/// length (0 when there is no identifier).
fn scan_identifier(s: &str) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    if i >= bytes.len() {
        return None;
    }
    let first = bytes[i];
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    i += 1;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    let name = s[start..i].to_string();
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    Some((name, i))
}

/// Find the first `{...}` object in `s` (balanced, honoring strings and
/// backslash escapes). Returns the number of bytes consumed from the start of
/// `s` through the closing brace, or `None`.
fn scan_object(s: &str) -> Option<usize> {
    let open = s.find('{')?;
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &byte) in bytes.iter().enumerate().skip(open) {
        let c = byte as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Remove every inline `[TOOL_CALLS] <name> {json}` block (mirrors
/// `_strip_text_tool_calls`).
pub fn strip_text_tool_calls(text: &str) -> String {
    if text.is_empty() || !text.contains(TEXT_TOOL_CALL_MARKER) {
        return text.to_string();
    }
    let mut out = String::new();
    let mut rest = text.to_string();
    loop {
        let Some(idx) = rest.find(TEXT_TOOL_CALL_MARKER) else {
            out.push_str(&rest);
            break;
        };
        out.push_str(&rest[..idx]);
        let after_marker = &rest[idx + TEXT_TOOL_CALL_MARKER.len()..];
        let Some((_name, consumed)) = scan_identifier(after_marker) else {
            out.push_str(TEXT_TOOL_CALL_MARKER);
            rest = after_marker.to_string();
            continue;
        };
        let raw = &after_marker[..consumed];
        let after_name = &after_marker[consumed..];
        match scan_object(after_name) {
            Some(obj_end) => {
                rest = after_name[obj_end..].to_string();
            }
            None => {
                out.push_str(TEXT_TOOL_CALL_MARKER);
                out.push_str(raw);
                out.push_str(after_name);
                break;
            }
        }
    }
    out
}

/// Extract `(name, json)` pairs from inline tool call blocks (mirrors
/// `_extract_text_tool_calls`).
pub fn extract_text_tool_calls(text: &str) -> Vec<(String, String)> {
    let mut calls: Vec<(String, String)> = Vec::new();
    let mut rest = text.to_string();
    loop {
        let Some(idx) = rest.find(TEXT_TOOL_CALL_MARKER) else {
            break;
        };
        rest = rest[idx + TEXT_TOOL_CALL_MARKER.len()..].to_string();
        let Some((name, consumed)) = scan_identifier(&rest) else {
            continue;
        };
        rest = rest[consumed..].to_string();
        let Some(obj_end) = scan_object(&rest) else {
            break;
        };
        calls.push((name, rest[..obj_end].to_string()));
        rest = rest[obj_end..].to_string();
    }
    calls
}

/// Run the markdown repair, then collapse whitespace runs to single spaces and
/// trim (Python `_clean_text_tool_json`).
fn clean_text_tool_json(text: &str) -> String {
    normalize_reply_markdown(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse inline tool calls into OpenAI-shaped tool call objects, or `None` when
/// there are none (mirrors `_parse_text_tool_calls`).
pub fn parse_text_tool_calls(content: &str) -> Option<Vec<Value>> {
    let extracted = extract_text_tool_calls(content);
    if extracted.is_empty() {
        return None;
    }
    let mut parsed: Vec<Value> = Vec::new();
    for (name, raw) in extracted {
        let cleaned = clean_text_tool_json(&raw);
        let Ok(value) = serde_json::from_str::<Value>(&cleaned) else {
            continue;
        };
        if !value.is_object() {
            continue;
        }
        let id = format!("text-call-{}", &Uuid::new_v4().simple().to_string()[..16]);
        parsed.push(json!({
            "id": id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": value.to_string(),
            }
        }));
    }
    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

// ---------------------------------------------------------------------------
// Markdown repair, ported from Python `services/ai_shared.py`
// (`normalize_reply_markdown` and its helpers)
// ---------------------------------------------------------------------------

/// Longest single-token line that may be reflowed into its neighbours.
const FRAGMENT_LINE_MAX: usize = 24;

/// Ordinal suffixes that must never absorb a neighbour.
const ORDINAL_SUFFIXES: [&str; 4] = ["st", "nd", "rd", "th"];

/// Prefixes that mark a line as structure, never a reflowable fragment.
const FRAGMENT_LINE_SKIP_START: [&str; 7] = ["```", "~~~", "#", ">", "|", "`", "~"];

/// Inflected/function words the dictionary omits (it stores base forms), so a
/// reflow never welds "is an" or "has been" together.
const INFLECTED_STOP: &[&str] = &[
    "i",
    "is",
    "am",
    "are",
    "was",
    "were",
    "been",
    "has",
    "had",
    "does",
    "did",
    "you",
    "we",
    "they",
    "he",
    "she",
    "me",
    "him",
    "her",
    "us",
    "them",
    "my",
    "our",
    "your",
    "their",
    "this",
    "that",
    "these",
    "those",
    "who",
    "whom",
    "whose",
    "which",
    "what",
    "when",
    "where",
    "why",
    "how",
    "than",
    "then",
    "now",
    "here",
    "there",
    "not",
    "no",
    "yes",
    "so",
    "if",
    "but",
    "yet",
    "nor",
    "all",
    "some",
    "any",
    "each",
    "every",
    "few",
    "more",
    "most",
    "other",
    "such",
    "own",
    "same",
    "both",
    "must",
    "shall",
    "should",
    "would",
    "could",
    "might",
    "cannot",
    "ive",
    "youve",
    "weve",
    "theyve",
];

fn common_words_set() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| COMMON_WORDS.iter().copied().collect())
}

fn is_common_word(word: &str) -> bool {
    common_words_set().contains(word)
}

fn fragment_line_skip_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([-*_=]{2,})$|^[*+]$|^\d+[.)]$").unwrap())
}

fn fragment_word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z]+").unwrap())
}

/// True when a trimmed line is one atomic streamed token (no internal
/// whitespace) that can join its neighbours.
fn is_fragment_line(stripped: &str) -> bool {
    if stripped.is_empty() || stripped.chars().count() > FRAGMENT_LINE_MAX {
        return false;
    }
    if stripped.chars().any(char::is_whitespace) {
        return false;
    }
    if FRAGMENT_LINE_SKIP_START.iter().any(|p| stripped.starts_with(p)) {
        return false;
    }
    if fragment_line_skip_re().is_match(stripped) {
        return false;
    }
    true
}

/// True when `word` is a dictionary word or a simple inflection of one, so a
/// fragment run never welds two real words together ("conflicting" + "tasks").
fn loose_common_word(word: &str) -> bool {
    let w: String = word
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '\u{2018}' | '\u{2019}' | '\''))
        .collect();
    if w.is_empty() {
        return false;
    }
    if is_common_word(&w) {
        return true;
    }
    let mut candidates: Vec<String> = Vec::new();
    if w.ends_with("ies") {
        candidates.push(format!("{}y", &w[..w.len() - 3]));
    }
    if w.ends_with("ing") {
        candidates.push(w[..w.len() - 3].to_string());
        candidates.push(format!("{}e", &w[..w.len() - 3]));
    }
    if w.ends_with("ied") {
        candidates.push(format!("{}y", &w[..w.len() - 3]));
    }
    if w.ends_with("ed") {
        candidates.push(w[..w.len() - 2].to_string());
        candidates.push(format!("{}e", &w[..w.len() - 2]));
    }
    if w.ends_with("es") {
        candidates.push(w[..w.len() - 2].to_string());
        candidates.push(format!("{}e", &w[..w.len() - 2]));
    } else if w.ends_with('s') {
        candidates.push(w[..w.len() - 1].to_string());
    }
    candidates
        .iter()
        .any(|c| c.chars().count() >= 3 && is_common_word(c))
}

fn is_lower_alpha(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase())
}

fn is_4_digits(s: &str) -> bool {
    s.len() == 4 && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_2_digits(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit())
}

/// Separator between two reflowed tokens: `""` when they are one unit, `-` for
/// dated values (2026 / 09 / 05), and a single space otherwise.
fn join_separator(prev: &str, nxt: &str) -> &'static str {
    if nxt.starts_with('\'') || nxt.starts_with('\u{2019}') || nxt.starts_with('\u{2018}') {
        return "";
    }
    if prev.ends_with('-') || nxt == "-" {
        return "";
    }
    if ORDINAL_SUFFIXES.contains(&prev) || ORDINAL_SUFFIXES.contains(&nxt) {
        return " ";
    }
    if is_4_digits(prev) && is_2_digits(nxt) {
        return "-";
    }
    if is_2_digits(prev) && is_2_digits(nxt) {
        return "-";
    }
    if is_lower_alpha(prev) && is_lower_alpha(nxt) {
        let combined = format!("{prev}{nxt}");
        if is_common_word(&combined) && (4..=FRAGMENT_LINE_MAX).contains(&combined.len()) {
            return "";
        }
        if !is_common_word(prev)
            && !is_common_word(nxt)
            && !loose_common_word(prev)
            && !loose_common_word(nxt)
            && !INFLECTED_STOP.contains(&prev)
            && !INFLECTED_STOP.contains(&nxt)
            && (4..=FRAGMENT_LINE_MAX).contains(&combined.len())
        {
            return "";
        }
    }
    " "
}

/// Join a run of single-token lines into one line.
fn join_fragment_run(tokens: &[String]) -> String {
    let mut result = tokens[0].trim().to_string();
    for i in 1..tokens.len() {
        let nxt = tokens[i].trim();
        result.push_str(join_separator(tokens[i - 1].trim(), nxt));
        result.push_str(nxt);
    }
    result
}

fn ends_with_sentence_punct(s: &str) -> bool {
    matches!(s.chars().last(), Some('.' | '!' | '?' | ':' | ';'))
}

/// Reflow streaming artifacts where the model put each token on its own line.
fn reflow_single_token_lines(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let n = lines.len();
    let mut in_fence = false;
    let mut fragment = vec![false; n];
    for i in 0..n {
        let stripped = lines[i].trim();
        if stripped.starts_with("```") || stripped.starts_with("~~~") {
            in_fence = !in_fence;
        } else if in_fence {
            continue;
        } else if is_fragment_line(stripped) {
            fragment[i] = true;
        }
    }

    let mut swallowed = vec![false; n];
    in_fence = false;
    for b in 0..n {
        let stripped_b = lines[b].trim();
        if stripped_b.starts_with("```") || stripped_b.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || !stripped_b.is_empty() {
            continue;
        }
        let mut p = b as isize - 1;
        while p >= 0 && lines[p as usize].trim().is_empty() {
            p -= 1;
        }
        let mut nx = b + 1;
        while nx < n && lines[nx].trim().is_empty() {
            nx += 1;
        }
        if p < 0 || nx >= n {
            continue;
        }
        let pi = p as usize;
        if !fragment[pi] || !fragment[nx] {
            continue;
        }
        if ends_with_sentence_punct(lines[pi].trim()) {
            continue;
        }
        swallowed[b] = true;
    }

    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n {
        if !fragment[i] {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let mut run: Vec<String> = vec![lines[i].to_string()];
        let mut j = i + 1;
        while j < n {
            if fragment[j] {
                run.push(lines[j].to_string());
                j += 1;
            } else if lines[j].trim().is_empty() && swallowed[j] {
                j += 1;
            } else {
                break;
            }
        }
        if run.len() >= 2 {
            out.push(join_fragment_run(&run));
        } else {
            out.push(lines[i].to_string());
        }
        i = j;
    }

    let mut final_lines: Vec<String> = Vec::new();
    let mut prev_blank = false;
    in_fence = false;
    for line in out {
        let stripped = line.trim();
        if stripped.starts_with("```") || stripped.starts_with("~~~") {
            in_fence = !in_fence;
            prev_blank = false;
            final_lines.push(line);
        } else if in_fence {
            final_lines.push(line);
        } else if stripped.is_empty() {
            if !prev_blank {
                prev_blank = true;
                final_lines.push(line);
            }
        } else {
            prev_blank = false;
            final_lines.push(line);
        }
    }
    final_lines.join("\n")
}

/// Strip the whitespace just inside a pair of emphasis/code delimiters.
fn strip_delimiter_spacing(line: &str, marker: &str) -> String {
    let mut line = line.to_string();
    let mut positions: Vec<usize> = Vec::new();
    let mut i = 0;
    while let Some(rel) = line[i..].find(marker) {
        let idx = i + rel;
        positions.push(idx);
        i = idx + marker.len();
    }
    let mut p = 0;
    while p + 1 < positions.len() {
        let open_idx = positions[p];
        if open_idx > line.len() {
            break;
        }
        let mut close_idx = positions[p + 1];
        if close_idx > line.len() {
            break;
        }
        if (marker == "*" || marker == "-") && line[..open_idx].trim().is_empty() {
            p += 2;
            continue;
        }
        let after_open = open_idx + marker.len();
        if after_open < line.len() {
            if let Some(c) = line[after_open..].chars().next() {
                if c.is_whitespace() {
                    let trimmed = line[after_open..].trim_start();
                    let removed = line[after_open..].len() - trimmed.len();
                    line.replace_range(after_open..after_open + removed, "");
                    match line[after_open..].find(marker) {
                        Some(rel) => close_idx = after_open + rel,
                        None => break,
                    }
                }
            }
        }
        if close_idx <= line.len() {
            let before = &line[..close_idx];
            let k = before.trim_end().len();
            if k != close_idx {
                line.replace_range(k..close_idx, "");
            }
        }
        p += 2;
    }
    line
}

/// Rejoin a hex-looking run split character by character ("3 5 8 b" -> "358b").
fn join_split_hex_run(line: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\b-?[0-9a-fA-F](?: -?[0-9a-fA-F]){5,}\b").unwrap());
    re.replace_all(line, |caps: &regex::Captures| {
        let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
        if !whole.chars().any(|c| c.is_ascii_digit()) {
            return whole.to_string();
        }
        whole.split_whitespace().collect::<Vec<_>>().join("")
    })
    .into_owned()
}

/// Strip whitespace just inside quotes: `" Work "` -> `"Work"`.
fn strip_quote_padding(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let is_quote = |c: char| matches!(c, '"' | '\u{201c}' | '\u{201d}');
    let is_hspace = |c: char| c == ' ' || c == '\t';
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_quote(c) {
            let prev_ok = out.last().map(|p| !p.is_ascii_alphanumeric()).unwrap_or(true);
            if prev_ok {
                let mut j = i + 1;
                let mut had_space = false;
                while j < chars.len() && is_hspace(chars[j]) {
                    had_space = true;
                    j += 1;
                }
                if had_space
                    && j < chars.len()
                    && !chars[j].is_whitespace()
                    && !is_quote(chars[j])
                {
                    let mut k = j + 1;
                    let mut found: Option<usize> = None;
                    while k < chars.len() {
                        if is_quote(chars[k]) {
                            if is_hspace(chars[k - 1]) {
                                let after_ok = match chars.get(k + 1) {
                                    None => true,
                                    Some(&nc) => {
                                        nc.is_whitespace()
                                            || matches!(
                                                nc,
                                                '"' | ',' | '.' | ';' | ':' | '!' | '?' | ')'
                                                    | ']' | '%' | '>'
                                            )
                                    }
                                };
                                if after_ok {
                                    found = Some(k);
                                }
                            }
                            break;
                        }
                        k += 1;
                    }
                    if let Some(cidx) = found {
                        out.push(c);
                        let mut content_end = cidx;
                        while content_end > j && is_hspace(chars[content_end - 1]) {
                            content_end -= 1;
                        }
                        out.extend_from_slice(&chars[j..content_end]);
                        out.push(chars[cidx]);
                        i = cidx + 1;
                        continue;
                    }
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out.into_iter().collect()
}

/// Remove a space/tab run that sits between two ASCII digits ("2 5" -> "25").
fn collapse_space_before_digit(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ' ' || c == '\t' {
            let mut j = i;
            while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                j += 1;
            }
            let prev_digit = out.last().map(|p| p.is_ascii_digit()).unwrap_or(false);
            let next_digit = chars.get(j).map(|n| n.is_ascii_digit()).unwrap_or(false);
            if prev_digit && next_digit {
                i = j;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out.into_iter().collect()
}

/// Remove a space/tab run between a digit and a following suffix with a word
/// boundary ("29 th" -> "29th", "4 pm" -> "4pm").
fn collapse_space_before_suffix(line: &str, suffixes: &[&str]) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ' ' || c == '\t' {
            let mut j = i;
            while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                j += 1;
            }
            let prev_digit = out.last().map(|p| p.is_ascii_digit()).unwrap_or(false);
            let rest: String = chars[j..].iter().collect();
            let lower = rest.to_lowercase();
            let matched = suffixes.iter().any(|s| {
                if !lower.starts_with(s) {
                    return false;
                }
                match lower[s.len()..].chars().next() {
                    None => true,
                    Some(a) => !a.is_alphanumeric() && a != '_',
                }
            });
            if prev_digit && matched {
                i = j;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out.into_iter().collect()
}

/// Collapse a hyphen a fragment was split around ("hyper -int" -> "hyper-int"),
/// unless both sides are real words (a deliberate spaced dash clause).
fn collapse_hyphen_spacing(line: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"([A-Za-z]+)[ \t]*-[ \t]*([A-Za-z]+)").unwrap());
    re.replace_all(line, |caps: &regex::Captures| {
        let a = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let b = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if is_common_word(&a.to_lowercase()) && is_common_word(&b.to_lowercase()) {
            caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
        } else {
            format!("{a}-{b}")
        }
    })
    .into_owned()
}

fn is_valid_join(tokens: &[&str], i: usize, k: usize) -> bool {
    let joined = tokens[i..i + k].concat();
    if !(4..=24).contains(&joined.chars().count()) || !is_common_word(&joined.to_lowercase()) {
        return false;
    }
    tokens[i..i + k].iter().any(|t| !is_common_word(&t.to_lowercase()))
}

fn rejoin_length(tokens: &[&str], i: usize) -> usize {
    let n = tokens.len();
    let start = if n - i - 1 < 24 { n - i - 1 } else { 24 };
    for k in (2..=start).rev() {
        if is_valid_join(tokens, i, k) && is_common_word(&tokens[i + k].to_lowercase()) {
            return k;
        }
    }
    let upper = if n - i < 24 { n - i } else { 24 };
    for k in (2..=upper).rev() {
        if is_valid_join(tokens, i, k) {
            return k;
        }
    }
    0
}

fn rejoin_run(tokens: &[&str], gaps: &[&str]) -> String {
    let mut result = String::new();
    let mut i = 0;
    let mut prev_end: isize = -1;
    while i < tokens.len() {
        let gap = if prev_end == -1 { "" } else { gaps[prev_end as usize] };
        let k = rejoin_length(tokens, i);
        if k >= 2 {
            result.push_str(gap);
            result.push_str(&tokens[i..i + k].concat());
            prev_end = (i + k - 1) as isize;
            i += k;
        } else {
            result.push_str(gap);
            result.push_str(tokens[i]);
            prev_end = i as isize;
            i += 1;
        }
    }
    result
}

/// Rejoin words split by fragmented streaming ("Fin ance" -> "Finance").
fn rejoin_fragmented_words(line: &str) -> String {
    let items: Vec<(usize, usize, &str)> = fragment_word_re()
        .find_iter(line)
        .map(|m| (m.start(), m.end(), m.as_str()))
        .collect();
    if items.len() < 2 {
        return line.to_string();
    }
    let mut out = String::new();
    let mut pos = 0;
    let mut i = 0;
    let n = items.len();
    while i < n {
        let mut j = i + 1;
        while j < n && line[items[j - 1].1..items[j].0].trim().is_empty() {
            j += 1;
        }
        let run = &items[i..j];
        out.push_str(&line[pos..run[0].0]);
        if run.len() == 1 {
            out.push_str(run[0].2);
        } else {
            let tokens: Vec<&str> = run.iter().map(|it| it.2).collect();
            let gaps: Vec<&str> = (0..run.len() - 1)
                .map(|k| &line[run[k].1..run[k + 1].0])
                .collect();
            out.push_str(&rejoin_run(&tokens, &gaps));
        }
        pos = run[run.len() - 1].1;
        i = j;
    }
    out.push_str(&line[pos..]);
    out
}

/// Reinsert a space in words merged by a dropped space ("Trackand" ->
/// "Track and", "conflictingtasks" -> "conflicting tasks").
fn split_merged_words(line: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[A-Za-z]{6,}").unwrap());
    re.replace_all(line, |caps: &regex::Captures| {
        let tok = caps.get(0).map(|m| m.as_str()).unwrap_or("");
        let lower = tok.to_lowercase();
        if is_common_word(&lower) || loose_common_word(&lower) {
            return tok.to_string();
        }
        let mut first_valid: isize = -1;
        let mut first_clean: isize = -1;
        for i in 4..lower.len().saturating_sub(1) {
            let left = &lower[..i];
            let right = &lower[i..];
            if left.chars().count() < 3 || !loose_common_word(left) {
                continue;
            }
            if !loose_common_word(right) {
                continue;
            }
            if first_valid == -1 {
                first_valid = i as isize;
            }
            if right != "s" && right != "ed" && right != "ing" {
                first_clean = i as isize;
                break;
            }
        }
        let at = if first_clean != -1 { first_clean } else { first_valid };
        if at == -1 {
            return tok.to_string();
        }
        let at = at as usize;
        format!("{} {}", &tok[..at], &tok[at..])
    })
    .into_owned()
}

/// Clean a single line: punctuation spacing, abbreviations, quotes, hex runs,
/// digit/ordinal/clock joins, delimiter spacing, hyphen fragments and word
/// repairs.
fn clean_line(line: &str) -> String {
    let mut line = line.to_string();

    {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"[ \t]+([,.;:?!>)])").unwrap());
        line = re.replace_all(&line, "$1").into_owned();
    }
    {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"(?i)([a-z])\.([ \t]+)([a-z])\.").unwrap());
        line = re.replace_all(&line, "${1}.${3}.").into_owned();
    }
    {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"([(\[{<])[ \t]+($|[^\]}])").unwrap());
        line = re.replace_all(&line, "${1}${2}").into_owned();
    }
    {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE
            .get_or_init(|| Regex::new(r"(\w+)[ \t]+([\x{2018}\x{2019}'])[ \t]*(\w{1,3})\b").unwrap());
        line = re.replace_all(&line, "${1}${2}${3}").into_owned();
    }

    line = strip_quote_padding(&line);
    line = join_split_hex_run(&line);

    {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"(\d)[ \t]*[\x{2013}\x{2014}-][ \t]*(\d)").unwrap());
        line = re.replace_all(&line, "${1}-${2}").into_owned();
    }
    line = collapse_space_before_digit(&line);
    line = collapse_space_before_suffix(&line, &["st", "nd", "rd", "th"]);
    line = collapse_space_before_suffix(&line, &["am", "pm"]);

    for marker in ["**", "__", "*", "_", "`"] {
        line = strip_delimiter_spacing(&line, marker);
    }
    line = collapse_hyphen_spacing(&line);
    line = rejoin_fragmented_words(&line);
    line = split_merged_words(&line);
    line
}

/// Rejoin an ISO date a model wrapped mid-value ("2026 -\n09 - 05").
fn repair_line_broken_dates(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let head_re = HEAD.get_or_init(|| Regex::new(r"([0-9]{4})[ \t]*-[ \t]*$").unwrap());
    static TAIL: OnceLock<Regex> = OnceLock::new();
    let tail_re = TAIL.get_or_init(|| Regex::new(r"^[ \t]*-?[ \t]*([0-9]{2})($|[-\s])").unwrap());

    let lines: Vec<&str> = text.split('\n').collect();
    let n = lines.len();
    let mut skipped = vec![false; n];
    let mut in_fence = false;
    for i in 0..n {
        let stripped = lines[i].trim();
        if stripped.starts_with("```") || stripped.starts_with("~~~") {
            in_fence = !in_fence;
            skipped[i] = true;
        } else if in_fence {
            skipped[i] = true;
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n {
        let line = lines[i];
        let nxt = if i + 1 < n { Some(lines[i + 1]) } else { None };
        if let Some(nxt) = nxt {
            if !skipped[i] && !skipped[i + 1] {
                if let (Some(h), Some(t)) = (head_re.find(line), tail_re.captures(nxt)) {
                    let joined = format!("{}-{}", &h.as_str()[..4], &t[1]);
                    let group1_end = t.get(1).unwrap().end();
                    out.push(format!("{}{}{}", &line[..h.start()], joined, &nxt[group1_end..]));
                    i += 2;
                    continue;
                }
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

/// Clean up sloppy model output before it is persisted or displayed. Mirrors
/// Python `_normalize_reply_markdown`: reflow one-token-per-line artifacts,
/// repair each non-fenced line, then rejoin cross-line broken dates.
pub fn normalize_reply_markdown(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let reflowed = reflow_single_token_lines(text);
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in reflowed.split('\n') {
        let stripped = line.trim();
        if stripped.starts_with("```") || stripped.starts_with("~~~") {
            in_fence = !in_fence;
            out.push(line.to_string());
            continue;
        }
        if in_fence {
            out.push(line.to_string());
        } else {
            out.push(clean_line(line));
        }
    }
    repair_line_broken_dates(&out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_reply_markdown_fixes_stray_space_emphasis_and_punctuation() {
        assert_eq!(
            normalize_reply_markdown("** what should the task be ?**"),
            "**what should the task be?**"
        );
        assert_eq!(
            normalize_reply_markdown("Give me a title ( e .g . daily , weekly )"),
            "Give me a title (e.g. daily, weekly)"
        );
        assert_eq!(normalize_reply_markdown("I 'll create it"), "I'll create it");
        assert_eq!(normalize_reply_markdown("I can 't do that ."), "I can't do that.");
        assert_eq!(
            normalize_reply_markdown("then I 'll delete them one by one ."),
            "then I'll delete them one by one."
        );
        assert_eq!(
            normalize_reply_markdown("I \u{2019} ll do that . maybe don\u{2019}t worry"),
            "I\u{2019}ll do that. maybe don\u{2019}t worry"
        );
        assert_eq!(
            normalize_reply_markdown("2 tasks titled \" Work \" scheduled ."),
            "2 tasks titled \"Work\" scheduled."
        );
        assert_eq!(
            normalize_reply_markdown(
                "1 . ID :\n\n3 5 8 b 2 5 0 b\n0 9 5 5\n4 0 d 8 -b 9 5 0\n5 7 4 b 6 2 5 1 f 2 f 2"
            ),
            "1. ID:\n\n358b250b\n0955\n40d8-b950\n574b6251f2f2"
        );
        assert_eq!(normalize_reply_markdown("a b c d e f g"), "a b c d e f g");
        let clean = "Done! **Drink water** is now an endless daily task (starts today).";
        assert_eq!(normalize_reply_markdown(clean), clean);
        let code = "```python\nx = [1 , 2]\n```\n** summary **";
        assert_eq!(
            normalize_reply_markdown(code),
            "```python\nx = [1 , 2]\n```\n**summary**"
        );
        assert_eq!(
            normalize_reply_markdown("* item one\n* item two"),
            "* item one\n* item two"
        );
        assert_eq!(
            normalize_reply_markdown("- [x] done\n- [ ] todo"),
            "- [x] done\n- [ ] todo"
        );
        assert_eq!(
            normalize_reply_markdown("4 \u{2013} 1 2 (recurs daily)"),
            "4-12 (recurs daily)"
        );
        assert_eq!(normalize_reply_markdown("May 2 9 th , 2 0 2 7"), "May 29th, 2027");
        assert_eq!(normalize_reply_markdown("4 pm to 1 2 am"), "4pm to 12am");
    }

    #[test]
    fn normalize_reply_markdown_user_qa_corpus() {
        assert_eq!(
            normalize_reply_markdown("I 've cancelled the following tasks :"),
            "I've cancelled the following tasks:"
        );
        assert_eq!(
            normalize_reply_markdown("Work ( tom orrow 4 \u{2013} 1 2 )"),
            "Work (tomorrow 4-12)"
        );
        assert_eq!(normalize_reply_markdown("Pr ys m Note"), "Prysm Note");
        assert_eq!(
            normalize_reply_markdown("To use the finance feature in Pr ys m Note"),
            "To use the finance feature in Prysm Note"
        );
        assert_eq!(
            normalize_reply_markdown("In Fin ance you can track Exp enses, Lo ans and De leting."),
            "In Finance you can track Expenses, Loans and Deleting."
        );
        assert_eq!(
            normalize_reply_markdown("Trackand Manage your day"),
            "Track and Manage your day"
        );
        assert_eq!(normalize_reply_markdown("** Settings **"), "**Settings**");
        assert_eq!(
            normalize_reply_markdown("I 'm Pr ys m AI , a hyper -int elligent task management agent designed to assist with scheduling , organizing , and optimizing your tasks and productivity ."),
            "I'm Prysm AI, a hyper-intelligent task management agent designed to assist with scheduling, organizing, and optimizing your tasks and productivity."
        );
        assert_eq!(normalize_reply_markdown("Pr ys m AI"), "Prysm AI");

        for clean in [
            "it is now the time",
            "to be or not to be",
            "new house",
            "a b c",
            "no one knows",
            "in to",
            "Track and Manage is a real feature",
        ] {
            assert_eq!(normalize_reply_markdown(clean), clean);
        }

        assert_eq!(normalize_reply_markdown("2 5 th"), "25th");
        assert_eq!(
            normalize_reply_markdown("I 've finished the setup ."),
            "I've finished the setup."
        );
        assert_eq!(normalize_reply_markdown("due next month ."), "due next month.");
        assert_eq!(normalize_reply_markdown("Due Date : 2026-09-05"), "Due Date: 2026-09-05");
    }

    #[test]
    fn normalize_reply_markdown_rejoins_line_broken_dates() {
        assert_eq!(
            normalize_reply_markdown("Due Date : 2026 -\n09 - 05"),
            "Due Date: 2026-09-05"
        );
        assert_eq!(
            normalize_reply_markdown("1 . Start : 2026-\n09-05\n2 . Buy supplies"),
            "1. Start: 2026-09-05\n2. Buy supplies"
        );
        assert_eq!(
            normalize_reply_markdown("```\n2026 -\n09 - 05\n```"),
            "```\n2026 -\n09 - 05\n```"
        );
    }

    #[test]
    fn normalize_reply_markdown_reflows_one_token_per_line() {
        let raw = [
            "I", "'m", "sorry", "for", "any", "inconven", "ience", ",", "but", "I", "currently",
            "don", "'t", "have", "the", "tools", "to", "assist", "with", "changing", "your",
            "payment", "date", ".", "However", ",", "I", "can", "guide", "you", "on", "how", "to",
            "do", "it", "yourself", ".", "You", "should", "be", "able", "to", "change", "your",
            "payment", "date", "by", "logging", "into", "your", "credit", "card", "account",
            "online", "or", "by", "contacting", "your", "credit", "card", "iss", "uer", "'s",
            "customer", "service", ".", "They", "can", "walk", "you", "through", "the", "process",
            "of", "updating", "your", "payment", "date", "to", "the", "", "", "2", "4", "th", "of",
            "each", "month", ".",
        ]
        .join("\n");
        assert_eq!(
            normalize_reply_markdown(&raw),
            "I'm sorry for any inconvenience, but I currently don't have the tools to assist with changing your payment date. However, I can guide you on how to do it yourself. You should be able to change your payment date by logging into your credit card account online or by contacting your credit card issuer's customer service. They can walk you through the process of updating your payment date to the 24th of each month."
        );

        assert_eq!(
            normalize_reply_markdown("the\n2026\n09\n05\nmeeting"),
            "the 2026-09-05 meeting"
        );
        assert_eq!(
            normalize_reply_markdown("the\n2026\n-\n09\n-\n05"),
            "the 2026-09-05"
        );
        assert_eq!(
            normalize_reply_markdown("Due\n:\n2026\n-\n09\n-05"),
            "Due: 2026-09-05"
        );
        assert_eq!(
            normalize_reply_markdown("2\n4\nth\nof\neach\nmonth"),
            "24th of each month"
        );
        assert_eq!(normalize_reply_markdown("inconven\nience"), "inconvenience");
        assert_eq!(normalize_reply_markdown("iss\nuer\n's"), "issuer's");
        assert_eq!(normalize_reply_markdown("don\n't"), "don't");
        assert_eq!(
            normalize_reply_markdown("Here\nis\nan\nanswer\n.\n\n```\nx\ny\nz\n```\nnext\nline"),
            "Here is an answer.\n\n```\nx\ny\nz\n```\nnext line"
        );
        assert_eq!(
            normalize_reply_markdown("to the\n\n\n2 4 th of each month"),
            "to the\n\n24th of each month"
        );
        assert_eq!(normalize_reply_markdown("Done!"), "Done!");
        assert_eq!(normalize_reply_markdown("---\nDone"), "---\nDone");
        assert_eq!(
            normalize_reply_markdown("1.\nfoo\n2.\nbar"),
            "1.\nfoo\n2.\nbar"
        );
    }

    #[test]
    fn normalize_reply_markdown_real_words_and_blank_padding() {
        assert_eq!(
            normalize_reply_markdown("several\nconflicting\ntasks\non\nthe\nsame\nday"),
            "several conflicting tasks on the same day"
        );
        assert_eq!(normalize_reply_markdown("in\nthe\nsame\nday"), "in the same day");
        assert_eq!(normalize_reply_markdown("at\n\n\n3\np\n.m\n."), "at 3 p.m.");
        assert_eq!(
            normalize_reply_markdown("priority\n(\npriority\n\n1\n)\n."),
            "priority (priority 1)."
        );
        assert_eq!(
            normalize_reply_markdown("to\nthe\n\n2\n4\nth\nof\neach\nmonth"),
            "to the 24th of each month"
        );
        assert_eq!(
            normalize_reply_markdown("due\nSep\n\n2\n0\n,\n2\n0\n2\n6\n)"),
            "due Sep 20, 2026)"
        );
        assert_eq!(
            normalize_reply_markdown("known\n.\n\nNext\nline"),
            "known.\n\nNext line"
        );
        assert_eq!(normalize_reply_markdown("3\np\n.\nm\n."), "3 p.m.");
        assert_eq!(normalize_reply_markdown("3 p . m ."), "3 p.m.");
        assert_eq!(normalize_reply_markdown("at 4 p . m . tomorrow"), "at 4 p.m. tomorrow");
        assert_eq!(normalize_reply_markdown("e . g . daily , weekly"), "e.g. daily, weekly");
        assert_eq!(
            normalize_reply_markdown("several conflictingtasks"),
            "several conflicting tasks"
        );
        assert_eq!(
            normalize_reply_markdown("the conflictingtasks list"),
            "the conflicting tasks list"
        );
    }

    #[test]
    fn normalize_reply_markdown_exact_user_reported_task_reply() {
        let raw = [
            "I", "'ve", "created", "the", "task", "\"", "1", "2", "3", "test", "\"", "for",
            "tomorrow", "at", "", "", "3", "p", ".m", ".", "However", ",", "there", "are",
            "several", "conflicting", "tasks", "on", "the", "same", "day", ",", "some", "of",
            "which", "have", "higher", "priority", "(", "priority", "", "", "1", ")", ".", "Here",
            "are", "the", "conflicting", "tasks", ":", "ne", "xo", "(", "priority", "", "1", ",",
            "due", "Sep", "", "2", "0", ",", "2", "0", "2", "6", ")",
        ]
        .join("\n");
        assert_eq!(
            normalize_reply_markdown(&raw),
            "I've created the task \"123 test\" for tomorrow at 3 p.m. However, there are several conflicting tasks on the same day, some of which have higher priority (priority 1). Here are the conflicting tasks: nexo (priority 1, due Sep 20, 2026)"
        );
    }

    #[test]
    fn clean_text_tool_json_feed_through_word_repairs() {
        assert_eq!(
            clean_text_tool_json("Work ( tom orrow 4 \u{2013} 1 2 )"),
            "Work (tomorrow 4-12)"
        );
        assert_eq!(clean_text_tool_json("Pr ys m Note"), "Prysm Note");
        assert_eq!(
            clean_text_tool_json("I 've cancelled the following tasks :"),
            "I've cancelled the following tasks:"
        );
        assert_eq!(
            clean_text_tool_json("I 'm Pr ys m AI , a hyper -int elligent task management agent"),
            "I'm Prysm AI, a hyper-intelligent task management agent"
        );
    }

    #[test]
    fn chunk_text_splits_on_space_boundaries() {
        let chunks = chunk_text("one two three four five", 11);
        assert!(chunks.iter().all(|c| c.chars().count() <= 11));
        assert_eq!(chunks.join(" "), "one two three four five");
    }

    #[test]
    fn chunk_text_keeps_short_text_whole() {
        assert_eq!(chunk_text("hello", 400), vec!["hello".to_string()]);
    }

    #[test]
    fn strips_a_single_tool_call_block() {
        let text = "before [TOOL_CALLS] create_task {\"title\":\"x\"} after";
        assert_eq!(strip_text_tool_calls(text), "before  after");
    }

    #[test]
    fn extracts_tool_calls_with_arguments() {
        let calls = extract_text_tool_calls("[TOOL_CALLS] create_task {\"title\":\"x\", \"n\":1}");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "create_task");
        assert_eq!(calls[0].1, "{\"title\":\"x\", \"n\":1}");
    }

    #[test]
    fn parses_text_tool_calls_into_openai_shape() {
        let parsed = parse_text_tool_calls("[TOOL_CALLS] create_task {\"title\":\"x\"}").unwrap();
        assert_eq!(parsed[0]["type"], "function");
        assert_eq!(parsed[0]["function"]["name"], "create_task");
        let args: Value =
            serde_json::from_str(parsed[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["title"], "x");
    }

    #[test]
    fn parse_returns_none_without_tool_calls() {
        assert!(parse_text_tool_calls("just a normal reply").is_none());
    }

    #[test]
    fn strip_leaves_unterminated_block_untouched() {
        let text = "[TOOL_CALLS] create_task {\"title\":";
        assert_eq!(strip_text_tool_calls(text), text);
    }

    /// Fake-LLM battery: a canned model output (the kind a real provider emits)
    /// must parse to the intended tool and normalized args. Covers the inline
    /// `[TOOL_CALLS]` path the model uses when it cannot emit native tool calls.
    #[test]
    fn canned_model_outputs_select_the_intended_tool_and_args() {
        // (canned assistant output, expected tool, arg key, arg value)
        let cases: &[(&str, &str, &str, &str)] = &[
            (
                "[TOOL_CALLS] create_task {\"title\": \"Buy milk\", \"start_date\": \"2026-10-03\", \"priority\": 2}",
                "create_task",
                "title",
                "Buy milk",
            ),
            (
                "[TOOL_CALLS] complete_task {\"task_id\": \"abc-123\"}",
                "complete_task",
                "task_id",
                "abc-123",
            ),
            (
                "[TOOL_CALLS] update_task {\"task_id\": \"t1\", \"fields\": {\"status\": \"done\"}}",
                "update_task",
                "task_id",
                "t1",
            ),
            (
                "[TOOL_CALLS] add_event {\"title\": \"Doctor appointment\", \"start_date\": \"2026-10-06\", \"start_time\": \"15:00\"}",
                "add_event",
                "start_time",
                "15:00",
            ),
            ("[TOOL_CALLS] list_watchlist {}", "list_watchlist", "", ""),
            (
                "[TOOL_CALLS] toggle_habit_log {\"habit_id\": \"h1\"}",
                "toggle_habit_log",
                "habit_id",
                "h1",
            ),
            (
                "[TOOL_CALLS] delete_matching_tasks {\"query\": \"work\"}",
                "delete_matching_tasks",
                "query",
                "work",
            ),
        ];
        for (raw, tool, key, val) in cases {
            let parsed =
                parse_text_tool_calls(raw).unwrap_or_else(|| panic!("no tool call parsed in {raw}"));
            assert_eq!(parsed[0]["function"]["name"], *tool, "wrong tool for {raw}");
            let args: Value =
                serde_json::from_str(parsed[0]["function"]["arguments"].as_str().unwrap()).unwrap();
            if !key.is_empty() {
                assert_eq!(args[*key], *val, "wrong {key} for {raw}");
            }
        }
    }

    #[test]
    fn multiple_inline_calls_in_one_turn_are_all_parsed() {
        let raw = "[TOOL_CALLS] create_task {\"title\": \"A\"} \
                   [TOOL_CALLS] create_task {\"title\": \"B\"} \
                   [TOOL_CALLS] list_tags {}";
        let parsed = parse_text_tool_calls(raw).unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0]["function"]["name"], "create_task");
        assert_eq!(parsed[2]["function"]["name"], "list_tags");
    }

    #[test]
    fn fragmented_multiline_json_is_repaired_before_parsing() {
        let raw = "[TOOL_CALLS] create_task {\n  \"title\":\n  \"Buy\n  milk\",\n  \"start_date\": \"2026-10-03\"\n}";
        let parsed = parse_text_tool_calls(raw).expect("fragmented JSON must still parse");
        assert_eq!(parsed[0]["function"]["name"], "create_task");
        let args: Value =
            serde_json::from_str(parsed[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["start_date"], "2026-10-03");
    }

    /// A clean prose answer must never be mistaken for a tool call.
    #[test]
    fn prose_without_a_marker_yields_no_calls() {
        assert!(parse_text_tool_calls("I added Buy milk for tomorrow.").is_none());
        assert!(parse_text_tool_calls("Sure, doing that now.").is_none());
    }
}
