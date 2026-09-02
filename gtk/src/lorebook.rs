use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use tiktoken_rs::{bpe_for_model, o200k_base_singleton};

use crate::model::{LoreEntry, LoreSettings, Message};

static COMMENT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\{\{//.*?\}\}|\{\{comment:.*?\}\}")
        .expect("the built-in lore comment pattern is valid")
});

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoreRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LorePosition {
    Normal,
    BeforeDescription,
    AfterDescription,
    Depth(usize),
    ReverseDepth(usize),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveLore {
    pub content: String,
    pub role: LoreRole,
    pub position: LorePosition,
    pub source: String,
    pub insertion_order: i64,
    pub token_count: usize,
}

#[derive(Clone, Debug)]
struct Query {
    keys: Vec<String>,
    negative: bool,
    all: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ForceState {
    None,
    Activate,
    Deactivate,
}

#[derive(Clone, Debug)]
struct PreparedLore {
    index: usize,
    content: String,
    role: LoreRole,
    position: LorePosition,
    source: String,
    insertion_order: i64,
    priority: i64,
    scan_depth: usize,
    full_word_matching: bool,
    regex: bool,
    case_sensitive: bool,
    recursive: bool,
    dont_search_recursive: bool,
    initially_active: bool,
    always_active: bool,
    force: ForceState,
    probability: Option<f64>,
    queries: Vec<Query>,
}

pub fn select_lore(
    entries: &[LoreEntry],
    messages: &[Message],
    settings: &LoreSettings,
    model: &str,
) -> Vec<ActiveLore> {
    let chat_messages = messages
        .iter()
        .filter(|message| !message.id.starts_with("virtual-first-message:"))
        .collect::<Vec<_>>();
    let chat_length = chat_messages.len() + 1;
    let prepared = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| prepare_entry(index, entry, settings, chat_length))
        .collect::<Vec<_>>();
    let mut selected = vec![false; prepared.len()];
    let mut recursive_prompts = Vec::<String>::new();

    loop {
        let mut changed = false;
        for (prepared_index, lore) in prepared.iter().enumerate() {
            if selected[prepared_index] {
                continue;
            }
            let mut active = lore.initially_active && probability_matches(lore.probability);
            if active && !lore.always_active && lore.force == ForceState::None {
                for query in &lore.queries {
                    let matched = query_matches(
                        query,
                        &chat_messages,
                        if lore.dont_search_recursive {
                            &[]
                        } else {
                            &recursive_prompts
                        },
                        lore.scan_depth,
                        lore.regex,
                        lore.full_word_matching,
                        lore.case_sensitive,
                    );
                    if (query.negative && matched) || (!query.negative && !matched) {
                        active = false;
                        break;
                    }
                }
            }
            match lore.force {
                ForceState::Activate => active = true,
                ForceState::Deactivate => active = false,
                ForceState::None => {}
            }
            if !active {
                continue;
            }
            selected[prepared_index] = true;
            changed = true;
            if lore.recursive {
                recursive_prompts.push(lore.content.clone());
            }
        }
        if !changed {
            break;
        }
    }

    let mut candidates = prepared
        .into_iter()
        .enumerate()
        .filter(|(index, lore)| selected[*index] && !lore.content.trim().is_empty())
        .map(|(_, lore)| {
            let token_count = token_count(&lore.content, model);
            (lore, token_count)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|(left, _), (right, _)| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.index.cmp(&right.index))
    });

    let mut used_tokens = 0_usize;
    let mut active = candidates
        .into_iter()
        .filter_map(|(lore, tokens)| {
            if used_tokens.saturating_add(tokens) > settings.token_budget {
                return None;
            }
            used_tokens += tokens;
            Some(ActiveLore {
                content: lore.content,
                role: lore.role,
                position: lore.position,
                source: lore.source,
                insertion_order: lore.insertion_order,
                token_count: tokens,
            })
        })
        .collect::<Vec<_>>();
    active.sort_by_key(|lore| lore.insertion_order);
    active
}

fn prepare_entry(
    index: usize,
    entry: &LoreEntry,
    settings: &LoreSettings,
    chat_length: usize,
) -> Option<PreparedLore> {
    if matches!(entry.mode.as_str(), "folder" | "child") {
        return None;
    }
    if !entry.always_active && entry.key.trim().is_empty() {
        return None;
    }

    let mut role = LoreRole::System;
    let mut position = LorePosition::Normal;
    let mut priority = entry.insertion_order;
    let mut scan_depth = settings.scan_depth;
    let mut full_word_matching = settings.full_word_matching;
    let mut recursive = settings.recursive_scanning;
    let mut dont_search_recursive = false;
    let mut initially_active = true;
    let mut force = ForceState::None;
    let mut probability = entry.activation_percent.map(f64::from);
    let mut extra_queries = Vec::new();
    let mut content_lines = Vec::new();
    let mut requires_unported_context = false;

    for line in entry.content.lines() {
        let trimmed = line.trim_start();
        let directive = trimmed
            .strip_prefix("@@@")
            .or_else(|| trimmed.strip_prefix("@@"));
        let Some(directive) = directive else {
            content_lines.push(line);
            continue;
        };
        let mut parts = directive.trim().splitn(2, char::is_whitespace);
        let name = parts.next().unwrap_or_default();
        let argument = parts.next().unwrap_or_default().trim();
        let recognized = match name {
            "end" => {
                position = LorePosition::Depth(0);
                true
            }
            "depth" => parse_usize(argument)
                .map(|depth| position = LorePosition::Depth(depth))
                .is_some(),
            "reverse_depth" => parse_usize(argument)
                .map(|depth| position = LorePosition::ReverseDepth(depth))
                .is_some(),
            "position" => match argument {
                "before_desc" => {
                    position = LorePosition::BeforeDescription;
                    true
                }
                "after_desc" | "personality" | "scenario" => {
                    position = LorePosition::AfterDescription;
                    true
                }
                value if value.starts_with("pt_") => {
                    requires_unported_context = true;
                    true
                }
                _ => false,
            },
            "role" => match argument {
                "system" => {
                    role = LoreRole::System;
                    true
                }
                "user" => {
                    role = LoreRole::User;
                    true
                }
                "assistant" => {
                    role = LoreRole::Assistant;
                    true
                }
                _ => false,
            },
            "scan_depth" => parse_usize(argument)
                .map(|depth| scan_depth = depth)
                .is_some(),
            "priority" => argument
                .parse::<i64>()
                .map(|value| priority = value)
                .is_ok(),
            "ignore_on_max_context" => {
                priority = -1_000;
                true
            }
            "match_full_word" => {
                full_word_matching = true;
                true
            }
            "match_partial_word" => {
                full_word_matching = false;
                true
            }
            "recursive" => {
                recursive = true;
                true
            }
            "unrecursive" => {
                recursive = false;
                true
            }
            "no_recursive_search" => {
                dont_search_recursive = true;
                true
            }
            "activate" => {
                force = ForceState::Activate;
                true
            }
            "dont_activate" => {
                force = ForceState::Deactivate;
                true
            }
            "activate_only_after" => parse_usize(argument)
                .map(|minimum| initially_active &= chat_length >= minimum)
                .is_some(),
            "activate_only_every" => parse_usize(argument)
                .filter(|interval| *interval > 0)
                .map(|interval| initially_active &= chat_length % interval == 0)
                .is_some(),
            "probability" => argument
                .parse::<f64>()
                .map(|value| probability = Some(value))
                .is_ok(),
            "additional_keys" => {
                extra_queries.push(Query {
                    keys: directive_keys(argument),
                    negative: false,
                    all: false,
                });
                true
            }
            "exclude_keys" => {
                extra_queries.push(Query {
                    keys: directive_keys(argument),
                    negative: true,
                    all: false,
                });
                true
            }
            "exclude_keys_all" => {
                extra_queries.push(Query {
                    keys: directive_keys(argument),
                    negative: true,
                    all: true,
                });
                true
            }
            "keep_activate_after_match" | "dont_activate_after_match" => {
                // The directive itself is control data, not prompt content. Native chat
                // variables are not modeled yet, so this entry gets normal per-request
                // activation until sticky state can be persisted compatibly.
                true
            }
            "is_greeting" | "inject_lore" | "inject_at" | "inject_replace" | "inject_prepend"
            | "disable_ui_prompt" => {
                // Applying these as ordinary lore would silently send control syntax or
                // place content at the wrong location. Keep the entry out of requests
                // until the corresponding greeting/preset state is available.
                requires_unported_context = true;
                true
            }
            _ => false,
        };
        if !recognized {
            content_lines.push(line);
        }
    }

    if requires_unported_context {
        return None;
    }

    let mut queries = extra_queries;
    if !entry.always_active {
        queries.push(Query {
            keys: comma_keys(&entry.key),
            negative: false,
            all: false,
        });
        if entry.selective && !entry.second_key.trim().is_empty() {
            queries.push(Query {
                keys: comma_keys(&entry.second_key),
                negative: false,
                all: false,
            });
        }
    }
    Some(PreparedLore {
        index,
        content: content_lines.join("\n"),
        role,
        position,
        source: if entry.name.trim().is_empty() {
            format!("lorebook {index}")
        } else {
            entry.name.clone()
        },
        insertion_order: entry.insertion_order,
        priority,
        scan_depth,
        full_word_matching,
        regex: entry.use_regex,
        case_sensitive: entry.case_sensitive,
        recursive,
        dont_search_recursive,
        initially_active,
        always_active: entry.always_active,
        force,
        probability,
        queries,
    })
}

fn query_matches(
    query: &Query,
    messages: &[&Message],
    recursive_prompts: &[String],
    scan_depth: usize,
    regex: bool,
    full_word_matching: bool,
    case_sensitive: bool,
) -> bool {
    let keys = query
        .keys
        .iter()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return false;
    }
    let start = messages.len().saturating_sub(scan_depth);
    let texts = messages[start..]
        .iter()
        .map(|message| message.content.as_str())
        .chain(recursive_prompts.iter().map(String::as_str))
        .collect::<Vec<_>>();
    if query.all {
        keys.iter().all(|key| {
            texts
                .iter()
                .any(|text| key_matches(key, text, regex, full_word_matching, case_sensitive))
        })
    } else {
        keys.iter().any(|key| {
            texts
                .iter()
                .any(|text| key_matches(key, text, regex, full_word_matching, case_sensitive))
        })
    }
}

fn key_matches(
    key: &str,
    text: &str,
    regex: bool,
    full_word_matching: bool,
    case_sensitive: bool,
) -> bool {
    if regex {
        return parse_regex(key).is_some_and(|regex| regex.is_match(text));
    }
    let text = COMMENT_PATTERN.replace_all(text, "");
    let (text, key) = if case_sensitive {
        (text.into_owned(), key.to_owned())
    } else {
        (text.to_lowercase(), key.to_lowercase())
    };
    if full_word_matching {
        text.split(' ').any(|word| word == key)
    } else {
        text.replace(' ', "").contains(&key.replace(' ', ""))
    }
}

fn parse_regex(value: &str) -> Option<Regex> {
    let value = value.trim();
    if !value.starts_with('/') {
        return None;
    }
    let end = value.rfind('/')?;
    if end == 0 {
        return None;
    }
    let pattern = &value[1..end];
    let flags = &value[end + 1..];
    if flags
        .chars()
        .any(|flag| !matches!(flag, 'g' | 'i' | 'm' | 's' | 'u'))
    {
        return None;
    }
    let mut builder = RegexBuilder::new(pattern);
    builder
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'));
    builder.build().ok()
}

fn probability_matches(percent: Option<f64>) -> bool {
    let Some(percent) = percent else {
        return true;
    };
    if !percent.is_finite() || percent <= 0.0 {
        return false;
    }
    if percent >= 100.0 {
        return true;
    }
    let sample = (uuid::Uuid::new_v4().as_u128() % 10_000) as f64 / 100.0;
    sample < percent
}

fn token_count(content: &str, model: &str) -> usize {
    let tokenizer = bpe_for_model(model).unwrap_or_else(|_| o200k_base_singleton());
    tokenizer.encode_with_special_tokens(content).len()
}

fn parse_usize(value: &str) -> Option<usize> {
    value.trim().parse().ok()
}

fn comma_keys(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).map(str::to_owned).collect()
}

fn directive_keys(value: &str) -> Vec<String> {
    if value.contains(',') {
        comma_keys(value)
    } else {
        value.split_whitespace().map(str::to_owned).collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::model::Role;

    use super::*;

    fn entry(key: &str, content: &str) -> LoreEntry {
        LoreEntry {
            source_index: None,
            id: None,
            key: key.into(),
            second_key: String::new(),
            insertion_order: 100,
            name: "test lore".into(),
            content: content.into(),
            mode: "normal".into(),
            always_active: false,
            selective: false,
            use_regex: false,
            case_sensitive: false,
            activation_percent: None,
        }
    }

    fn message(content: &str) -> Message {
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: Role::User,
            content: content.into(),
        }
    }

    #[test]
    fn keyword_selective_regex_and_always_active_entries_match() {
        let mut selective = entry("moon", "selective");
        selective.selective = true;
        selective.second_key = "dragon".into();
        let mut regex = entry(r"/st(ar|orm)/i", "regex");
        regex.use_regex = true;
        let mut always = entry("", "always");
        always.always_active = true;
        let result = select_lore(
            &[selective, regex, always],
            &[message("The Moon Dragon saw a STAR")],
            &LoreSettings::default(),
            "gpt-4o-mini",
        );
        assert_eq!(
            result
                .iter()
                .map(|lore| lore.content.as_str())
                .collect::<Vec<_>>(),
            vec!["selective", "regex", "always"]
        );
    }

    #[test]
    fn scan_depth_exclusions_and_full_word_matching_are_applied() {
        let mut lore = entry("cat", "matched");
        lore.content = "@@scan_depth 1\n@@match_full_word\n@@exclude_keys dog\nmatched".into();
        assert!(
            select_lore(
                &[lore.clone()],
                &[message("cat"), message("concatenate")],
                &LoreSettings::default(),
                "gpt-4o-mini",
            )
            .is_empty()
        );
        assert_eq!(
            select_lore(
                &[lore],
                &[message("dog"), message("cat")],
                &LoreSettings::default(),
                "gpt-4o-mini",
            )[0]
            .content,
            "matched"
        );
    }

    #[test]
    fn recursive_lore_activates_later_entries_and_virtual_greeting_is_not_scanned() {
        let first = entry("seed", "hidden-key");
        let second = entry("hidden-key", "recursive result");
        let virtual_greeting = Message {
            id: "virtual-first-message:character".into(),
            role: Role::Character,
            content: "seed".into(),
        };
        assert!(
            select_lore(
                &[first.clone(), second.clone()],
                &[virtual_greeting],
                &LoreSettings::default(),
                "gpt-4o-mini",
            )
            .is_empty()
        );
        let result = select_lore(
            &[first, second],
            &[message("seed")],
            &LoreSettings::default(),
            "gpt-4o-mini",
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].content, "recursive result");
    }

    #[test]
    fn priority_controls_budget_while_insertion_order_controls_output() {
        let mut low = entry("", "low priority content");
        low.always_active = true;
        low.insertion_order = 10;
        let mut high = entry("", "high priority content");
        high.always_active = true;
        high.insertion_order = 20;
        high.content = "@@priority 500\nhigh priority content".into();
        let high_tokens = token_count("high priority content", "gpt-4o-mini");
        let settings = LoreSettings {
            token_budget: high_tokens,
            ..LoreSettings::default()
        };
        let result = select_lore(&[low, high], &[], &settings, "gpt-4o-mini");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content, "high priority content");
        assert_eq!(result[0].token_count, high_tokens);
    }

    #[test]
    fn role_position_and_probability_directives_are_preserved() {
        let mut lore = entry("", "@@role user\n@@depth 2\n@@probability 100\nplaced");
        lore.always_active = true;
        let result = select_lore(&[lore], &[], &LoreSettings::default(), "gpt-4o-mini");
        assert_eq!(result[0].role, LoreRole::User);
        assert_eq!(result[0].position, LorePosition::Depth(2));
        assert_eq!(result[0].content, "placed");
    }

    #[test]
    fn context_dependent_directives_are_not_sent_as_plain_prompt_text() {
        for directive in [
            "@@is_greeting 2",
            "@@inject_at prompt-name",
            "@@position pt_custom",
            "@@disable_ui_prompt system_prompt",
        ] {
            let mut lore = entry("", &format!("{directive}\nsecret control lore"));
            lore.always_active = true;
            assert!(
                select_lore(&[lore], &[], &LoreSettings::default(), "gpt-4o-mini").is_empty(),
                "{directive} must not degrade into ordinary prompt content"
            );
        }

        let mut sticky = entry(
            "",
            "@@keep_activate_after_match\nsticky control is stripped",
        );
        sticky.always_active = true;
        let result = select_lore(&[sticky], &[], &LoreSettings::default(), "gpt-4o-mini");
        assert_eq!(result[0].content, "sticky control is stripped");
    }
}
