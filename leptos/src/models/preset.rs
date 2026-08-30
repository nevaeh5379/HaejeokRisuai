use serde::{Deserialize, Serialize};

/// Lightweight summary of a bot preset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PresetSummary {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "apiType", alias = "api_type", default)]
    pub api_type: Option<String>,
    #[serde(rename = "aiModel", alias = "ai_model", default)]
    pub ai_model: Option<String>,
}

/// Normalizes preset list from backend responses.
/// Accepts:
/// 1. Canonical route contract: `{ "presets": [...], "hash": "..." }`
/// 2. Postgres flat shape: `{ "botPresets": [...] }`
/// 3. Azure/Oracle shape: `{ "settings": { "botPresets": [...] }, "hash": "..." }`
/// 4. Direct array: `[...]`
/// Safely returns empty `Vec` on unknown or malformed input.
pub fn normalize_preset_list(value: &serde_json::Value) -> Vec<PresetSummary> {
    let presets_array = if let Some(presets) = value.get("presets").and_then(|v| v.as_array()) {
        Some(presets)
    } else if let Some(presets) = value.get("botPresets").and_then(|v| v.as_array()) {
        Some(presets)
    } else if let Some(presets) = value
        .get("settings")
        .and_then(|s| s.get("botPresets"))
        .and_then(|v| v.as_array())
    {
        Some(presets)
    } else if let Some(presets) = value.as_array() {
        Some(presets)
    } else {
        None
    };

    match presets_array {
        Some(arr) => arr
            .iter()
            .filter_map(|item| serde_json::from_value::<PresetSummary>(item.clone()).ok())
            .collect(),
        None => Vec::new(),
    }
}

/// Sanitized preset detail containing ONLY allowlisted display fields.
/// Does not retain raw JSON or secret credentials (API keys, tokens, passwords),
/// making Debug safe against accidental secret leakage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SafePresetDetail {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "apiType", alias = "api_type", default)]
    pub api_type: Option<String>,
    #[serde(rename = "aiModel", alias = "ai_model", default)]
    pub ai_model: Option<String>,
    #[serde(rename = "subModel", alias = "sub_model", default)]
    pub sub_model: Option<String>,
    #[serde(rename = "maxContext", alias = "max_context", default)]
    pub max_context: Option<i64>,
    #[serde(rename = "maxResponse", alias = "max_response", default)]
    pub max_response: Option<i64>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

impl SafePresetDetail {
    /// Creates a `SafePresetDetail` by parsing ONLY allowlisted fields from a JSON Value.
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        if !value.is_object() {
            return None;
        }
        serde_json::from_value(value.clone()).ok()
    }
}

impl From<&serde_json::Value> for SafePresetDetail {
    fn from(value: &serde_json::Value) -> Self {
        Self::from_value(value).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_canonical_preset_normalization() {
        let payload = json!({
            "presets": [
                {
                    "id": "preset_canonical",
                    "name": "Claude 3.7 Sonnet",
                    "apiType": "anthropic",
                    "aiModel": "claude-3-7-sonnet"
                }
            ],
            "hash": "preset_canonical_hash_123"
        });

        let list = normalize_preset_list(&payload);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id.as_deref(), Some("preset_canonical"));
        assert_eq!(list[0].name.as_deref(), Some("Claude 3.7 Sonnet"));
        assert_eq!(list[0].api_type.as_deref(), Some("anthropic"));
        assert_eq!(list[0].ai_model.as_deref(), Some("claude-3-7-sonnet"));
    }

    #[test]
    fn test_flat_preset_normalization() {
        let payload = json!({
            "botPresets": [
                {
                    "id": "preset_1",
                    "name": "Claude 3.5 Sonnet",
                    "apiType": "anthropic",
                    "aiModel": "claude-3-5-sonnet-20241022"
                },
                {
                    "id": "preset_2",
                    "name": "GPT-4o",
                    "api_type": "openai",
                    "ai_model": "gpt-4o"
                }
            ]
        });

        let list = normalize_preset_list(&payload);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id.as_deref(), Some("preset_1"));
        assert_eq!(list[0].name.as_deref(), Some("Claude 3.5 Sonnet"));
        assert_eq!(list[0].api_type.as_deref(), Some("anthropic"));
        assert_eq!(
            list[0].ai_model.as_deref(),
            Some("claude-3-5-sonnet-20241022")
        );

        assert_eq!(list[1].id.as_deref(), Some("preset_2"));
        assert_eq!(list[1].name.as_deref(), Some("GPT-4o"));
        assert_eq!(list[1].api_type.as_deref(), Some("openai"));
        assert_eq!(list[1].ai_model.as_deref(), Some("gpt-4o"));
    }

    #[test]
    fn test_wrapped_preset_normalization() {
        let payload = json!({
            "settings": {
                "botPresets": [
                    {
                        "id": "preset_wrapped",
                        "name": "Gemini Pro",
                        "apiType": "google",
                        "aiModel": "gemini-1.5-pro"
                    }
                ]
            },
            "hash": "preset_hash_999"
        });

        let list = normalize_preset_list(&payload);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id.as_deref(), Some("preset_wrapped"));
        assert_eq!(list[0].name.as_deref(), Some("Gemini Pro"));
        assert_eq!(list[0].api_type.as_deref(), Some("google"));
        assert_eq!(list[0].ai_model.as_deref(), Some("gemini-1.5-pro"));
    }

    #[test]
    fn test_malformed_preset_normalization_empty() {
        let invalid_cases = vec![
            json!(null),
            json!("a string"),
            json!(12345),
            json!({ "unexpected_key": "some_value" }),
            json!({ "botPresets": "not an array" }),
            json!({ "settings": { "botPresets": null } }),
        ];

        for case in invalid_cases {
            let result = normalize_preset_list(&case);
            assert!(
                result.is_empty(),
                "Expected empty vector for malformed input: {case:?}"
            );
        }
    }

    #[test]
    fn test_safe_preset_detail_extracts_allowlist_and_redacts_secrets() {
        let raw_preset = json!({
            "id": "preset_allowlist_test",
            "name": "Secure Preset",
            "apiType": "custom_api",
            "aiModel": "test-model-v1",
            "subModel": "sub-model-fast",
            "maxContext": 8192,
            "maxResponse": 2048,
            "temperature": 0.7,
            // Sensitive / unknown fields that must NOT be stored
            "apiKey": "sk-fake-secret-token-do-not-expose-12345",
            "openAiPassword": "fake_password_98765",
            "token": "bearer_secret_xyz",
            "internalNote": "Top secret prompt injection test",
            "deeplyNestedSecret": {
                "key": "super-hidden-key"
            }
        });

        let detail = SafePresetDetail::from_value(&raw_preset)
            .expect("Should construct SafePresetDetail from valid object");

        assert_eq!(detail.id.as_deref(), Some("preset_allowlist_test"));
        assert_eq!(detail.name.as_deref(), Some("Secure Preset"));
        assert_eq!(detail.api_type.as_deref(), Some("custom_api"));
        assert_eq!(detail.ai_model.as_deref(), Some("test-model-v1"));
        assert_eq!(detail.sub_model.as_deref(), Some("sub-model-fast"));
        assert_eq!(detail.max_context, Some(8192));
        assert_eq!(detail.max_response, Some(2048));
        assert_eq!(detail.temperature, Some(0.7));

        let debug_str = format!("{:?}", detail);
        assert!(
            !debug_str.contains("sk-fake-secret-token-do-not-expose-12345"),
            "Debug output leaked apiKey secret"
        );
        assert!(
            !debug_str.contains("fake_password_98765"),
            "Debug output leaked password"
        );
        assert!(
            !debug_str.contains("bearer_secret_xyz"),
            "Debug output leaked token"
        );
        assert!(
            !debug_str.contains("apiKey"),
            "Debug output contained apiKey field key"
        );
        assert!(
            !debug_str.contains("openAiPassword"),
            "Debug output contained password field key"
        );
        assert!(
            !debug_str.contains("internalNote"),
            "Debug output contained unallowed field internalNote"
        );
    }
}
