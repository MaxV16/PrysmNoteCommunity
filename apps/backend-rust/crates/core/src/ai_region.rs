//! Regional compliance routing for hosted PrysmAI, mirroring the core Python
//! `services/ai_region.py`.
//!
//! Decides which model chain serves a request from the Cloudflare
//! `cf-ipcountry` header. Restricted countries are denied outright; known
//! countries not on the DeepSeek blocklist get the DeepSeek chain; blocklisted,
//! missing and unclassifiable countries get the compliant EU chain.

use std::collections::HashSet;

use crate::config::Settings;

/// Raised when a request's country is explicitly denied hosted PrysmAI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegionBlocked;

/// Split a comma-separated ISO alpha-2 list into an upper-cased set.
pub fn parse_country_list(raw: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for part in raw.split(',') {
        let code = part.trim().to_ascii_uppercase();
        if code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()) {
            out.insert(code);
        }
    }
    out
}

/// Split a comma-separated model chain into an ordered, non-empty list.
pub fn parse_chain(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string())
        .collect()
}

/// True when the country code is explicitly denied hosted PrysmAI.
pub fn is_region_blocked(settings: &Settings, cf_country: Option<&str>) -> bool {
    let Some(country) = cf_country else {
        return false;
    };
    let code = country.trim().to_ascii_uppercase();
    parse_country_list(&settings.prysm_ai_restricted_countries()).contains(&code)
}

/// True when the country code may be served by the DeepSeek chain.
pub fn uses_deepseek(settings: &Settings, cf_country: Option<&str>) -> bool {
    let Some(country) = cf_country else {
        return false;
    };
    let code = country.trim().to_ascii_uppercase();
    if code.len() != 2 || !code.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    if parse_country_list(&settings.prysm_ai_restricted_countries()).contains(&code) {
        return false;
    }
    !parse_country_list(&settings.prysm_ai_deepseek_blocked_countries()).contains(&code)
}

/// Resolve `(primary_model, fallback_models)` for a request's country.
pub fn resolve_ai_chain(
    settings: &Settings,
    cf_country: Option<&str>,
) -> Result<(String, Vec<String>), RegionBlocked> {
    if is_region_blocked(settings, cf_country) {
        return Err(RegionBlocked);
    }

    let mut chain = if uses_deepseek(settings, cf_country) {
        parse_chain(&settings.prysm_ai_deepseek_chain())
    } else {
        let eu = parse_chain(&settings.prysm_ai_eu_chain());
        let region_model = settings.prysm_ai_region_model();
        if !region_model.is_empty() {
            vec![region_model]
        } else {
            eu
        }
    };

    if chain.is_empty() {
        chain = parse_chain(&settings.prysm_ai_eu_chain());
    }
    if chain.is_empty() {
        chain = vec![
            crate::llm::PRYSMAI_MODEL.to_string(),
            crate::llm::PRYSMAI_EU_MODEL.to_string(),
        ];
    }

    let primary = chain.remove(0);
    Ok((primary, chain))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        crate::config::tests::sample("test")
    }

    #[test]
    fn country_lists_ignore_garbage() {
        let set = parse_country_list("de, GB ,x,,12,fr");
        assert!(set.contains("DE"));
        assert!(set.contains("GB"));
        assert!(set.contains("FR"));
        assert!(!set.contains("X"));
    }

    #[test]
    fn chain_splitting_drops_empties() {
        assert_eq!(parse_chain("a, ,b,"), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn restricted_countries_are_blocked() {
        let s = settings();
        assert!(resolve_ai_chain(&s, Some("RU")).is_err());
        assert!(resolve_ai_chain(&s, Some("us")).is_ok());
    }

    #[test]
    fn unknown_country_gets_the_eu_chain() {
        let s = settings();
        let (primary, _) = resolve_ai_chain(&s, None).unwrap();
        assert_eq!(primary, crate::llm::PRYSMAI_EU_MODEL);
    }

    #[test]
    fn deepseek_country_gets_the_tool_capable_deepseek_primary() {
        let s = settings();
        let (primary, fallbacks) = resolve_ai_chain(&s, Some("US")).unwrap();
        assert_eq!(primary, crate::llm::PRYSMAI_MODEL);
        assert!(!primary.contains(":free"));
        assert!(fallbacks.iter().all(|m| !m.contains(":free")));
    }
}
