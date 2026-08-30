use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageInput {
    pub role: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreMatchRequest {
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(rename = "searchDepth")]
    pub search_depth: Option<usize>,
    pub regex: Option<bool>,
    #[serde(rename = "fullWordMatching")]
    pub full_word_matching: Option<bool>,
    pub all: Option<bool>,
    #[serde(rename = "dontSearchWhenRecursive")]
    pub dont_search_when_recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecursivePromptItem {
    pub source: Option<String>,
    pub prompt: Option<String>,
    pub data: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LoreMatchOptions {
    pub username: Option<String>,
    #[serde(rename = "charName")]
    pub char_name: Option<String>,
    #[serde(rename = "recursivePrompts")]
    pub recursive_prompts: Option<Vec<RecursivePromptItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreMatchLog {
    pub prompt: String,
    pub source: String,
    pub activated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreMatchResult {
    pub matched: bool,
    pub logs: Vec<LoreMatchLog>,
}

#[derive(Debug, Clone)]
struct MessageEntry {
    source: String,
    prompt: String,
    data: String,
}

fn build_message_list(
    messages: &[ChatMessageInput],
    depth_opt: Option<usize>,
    username: &str,
    char_name: &str,
) -> Vec<MessageEntry> {
    let depth = depth_opt.unwrap_or(0);
    let start = if messages.len() > depth {
        messages.len() - depth
    } else {
        0
    };
    let slice = &messages[start..];

    slice
        .iter()
        .enumerate()
        .map(|(index, msg)| {
            let is_user = msg.role.as_deref() == Some("user");
            let display_name = if is_user {
                username
            } else {
                msg.display_name.as_deref().unwrap_or(char_name)
            };
            let data = msg.data.as_deref().unwrap_or("");
            MessageEntry {
                source: format!(
                    "message {} by {}",
                    index,
                    if is_user { "user" } else { "char" }
                ),
                prompt: format!("\x01{{{{{}}}}}:{}\x01", display_name, data),
                data: data.to_string(),
            }
        })
        .collect()
}

fn strip_comments(text: &str) -> String {
    let re1 = Regex::new(r"\{\{///(.+?)\}\}").unwrap();
    let re2 = Regex::new(r"\{\{comment:(.+?)\}\}").unwrap();
    let res = re1.replace_all(text, "");
    re2.replace_all(&res, "").to_string()
}

pub fn match_lore_request(
    messages: &[ChatMessageInput],
    request: &LoreMatchRequest,
    options: &LoreMatchOptions,
) -> LoreMatchResult {
    let raw_keys: Vec<String> = request
        .keys
        .iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .collect();

    let mut logs = Vec::new();
    let username = options.username.as_deref().unwrap_or("");
    let char_name = options.char_name.as_deref().unwrap_or("");

    let mut message_list = build_message_list(messages, request.search_depth, username, char_name);

    if !request.dont_search_when_recursive.unwrap_or(false) {
        if let Some(recursive) = &options.recursive_prompts {
            for item in recursive {
                message_list.push(MessageEntry {
                    source: format!("lorebook {}", item.source.as_deref().unwrap_or("")),
                    prompt: item.prompt.clone().unwrap_or_default(),
                    data: item.data.clone().unwrap_or_default(),
                });
            }
        }
    }

    if request.regex.unwrap_or(false) {
        for msg in &message_list {
            for regex_string in &raw_keys {
                if !regex_string.starts_with('/') {
                    return LoreMatchResult {
                        matched: false,
                        logs,
                    };
                }
                let parts: Vec<&str> = regex_string.rsplitn(2, '/').collect();
                if parts.len() < 2 {
                    continue;
                }
                let flag = parts[0];
                let pattern = &regex_string[1..(regex_string.len() - flag.len() - 1)];

                let re_str = if flag.contains('i') {
                    format!("(?i){}", pattern)
                } else {
                    pattern.to_string()
                };

                if let Ok(re) = Regex::new(&re_str) {
                    if re.is_match(&msg.data) {
                        logs.push(LoreMatchLog {
                            prompt: msg.prompt.clone(),
                            source: msg.source.clone(),
                            activated: regex_string.clone(),
                        });
                        return LoreMatchResult {
                            matched: true,
                            logs,
                        };
                    }
                }
            }
        }
        return LoreMatchResult {
            matched: false,
            logs,
        };
    }

    let normalized_messages: Vec<MessageEntry> = message_list
        .into_iter()
        .map(|m| MessageEntry {
            source: m.source,
            prompt: strip_comments(&m.prompt.to_lowercase()),
            data: strip_comments(&m.data.to_lowercase()),
        })
        .collect();

    let all_mode = request.all.unwrap_or(false);
    let mut all_mode_matched = true;

    for msg in &normalized_messages {
        let text = &msg.data;
        if request.full_word_matching.unwrap_or(false) {
            let words: Vec<&str> = text.split_whitespace().collect();
            for key in &raw_keys {
                let lower_key = key.to_lowercase();
                if words.contains(&lower_key.as_str()) {
                    logs.push(LoreMatchLog {
                        prompt: msg.prompt.clone(),
                        source: msg.source.clone(),
                        activated: key.clone(),
                    });
                    if !all_mode {
                        return LoreMatchResult {
                            matched: true,
                            logs,
                        };
                    }
                } else if all_mode {
                    all_mode_matched = false;
                }
            }
        } else {
            let clean_text = text.replace(' ', "");
            for key in &raw_keys {
                let real_key = key.to_lowercase().replace(' ', "");
                if clean_text.contains(&real_key) {
                    logs.push(LoreMatchLog {
                        prompt: msg.prompt.clone(),
                        source: msg.source.clone(),
                        activated: key.clone(),
                    });
                    if !all_mode {
                        return LoreMatchResult {
                            matched: true,
                            logs,
                        };
                    }
                } else if all_mode {
                    all_mode_matched = false;
                }
            }
        }
    }

    LoreMatchResult {
        matched: all_mode && all_mode_matched,
        logs,
    }
}

pub fn match_lore_batch(
    messages: &[ChatMessageInput],
    requests: &[LoreMatchRequest],
    options: &LoreMatchOptions,
) -> Result<Vec<LoreMatchResult>, &'static str> {
    if requests.len() > 4096 {
        return Err("Too many lore match requests");
    }
    Ok(requests
        .iter()
        .map(|req| match_lore_request(messages, req, options))
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub keys: Vec<String>,
    pub all: Option<bool>,
    pub negative: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreEntryItem {
    pub index: serde_json::Value,
    pub activated: Option<bool>,
    #[serde(rename = "forceState")]
    pub force_state: Option<String>,
    #[serde(rename = "alwaysActive")]
    pub always_active: Option<bool>,
    #[serde(rename = "searchQueries")]
    pub search_queries: Option<Vec<SearchQuery>>,
    #[serde(rename = "scanDepth")]
    pub scan_depth: Option<usize>,
    pub regex: Option<bool>,
    #[serde(rename = "fullWordMatching")]
    pub full_word_matching: Option<bool>,
    #[serde(rename = "dontSearchWhenRecursive")]
    pub dont_search_when_recursive: Option<bool>,
    pub recursive: Option<bool>,
    pub content: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveLoreResponse {
    #[serde(rename = "activatedIndexes")]
    pub activated_indexes: Vec<serde_json::Value>,
    pub logs: Vec<LoreMatchLog>,
}

pub fn resolve_lore_entries(
    messages: &[ChatMessageInput],
    entries: &[LoreEntryItem],
    options: &LoreMatchOptions,
) -> Result<ResolveLoreResponse, &'static str> {
    if entries.len() > 10000 {
        return Err("Too many lore entries");
    }

    let mut activated_set = std::collections::HashSet::new();
    let mut activation_order = Vec::new();
    let mut recursive_prompts = Vec::new();
    let mut logs = Vec::new();
    let mut matching = true;

    while matching {
        matching = false;
        for entry in entries {
            let index_key = entry.index.to_string();
            if activated_set.contains(&index_key) {
                continue;
            }

            let mut activated = entry.activated.unwrap_or(true);
            let force_state = entry.force_state.as_deref().unwrap_or("none");
            let always_active = entry.always_active.unwrap_or(false);

            if activated && force_state == "none" && !always_active {
                if let Some(queries) = &entry.search_queries {
                    for query in queries {
                        let req = LoreMatchRequest {
                            keys: query.keys.clone(),
                            search_depth: entry.scan_depth,
                            regex: entry.regex,
                            full_word_matching: entry.full_word_matching,
                            all: query.all,
                            dont_search_when_recursive: entry.dont_search_when_recursive,
                        };
                        let mut opt = options.clone();
                        opt.recursive_prompts = Some(recursive_prompts.clone());

                        let res = match_lore_request(messages, &req, &opt);
                        logs.extend(res.logs);

                        let negative = query.negative.unwrap_or(false);
                        if (negative && res.matched) || (!negative && !res.matched) {
                            activated = false;
                            break;
                        }
                    }
                }
            }

            if force_state == "activate" {
                activated = true;
            } else if force_state == "deactivate" {
                activated = false;
            }

            if !activated {
                continue;
            }

            activated_set.insert(index_key);
            activation_order.push(entry.index.clone());

            if entry.recursive.unwrap_or(false) {
                matching = true;
                let content = entry.content.as_deref().unwrap_or("").to_string();
                let source = entry
                    .source
                    .clone()
                    .unwrap_or_else(|| format!("lorebook {}", entry.index));
                recursive_prompts.push(RecursivePromptItem {
                    prompt: Some(content.clone()),
                    data: Some(content),
                    source: Some(source),
                });
            }
        }
    }

    Ok(ResolveLoreResponse {
        activated_indexes: activation_order,
        logs,
    })
}
