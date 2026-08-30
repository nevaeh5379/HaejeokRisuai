use crate::api::client::{ApiClient, ApiError, Result};
use crate::models::lorebook::LorebookEnvelope;
use crate::models::module::ModulesEnvelope;
use crate::models::persona::PersonasEnvelope;
use crate::models::preset::{normalize_preset_list, PresetSummary, SafePresetDetail};
use serde_json::Value;

/// Converts a JSON `Value` representing a preset response into a sanitized `SafePresetDetail`.
/// If the value contains a canonical wrapper `{ "preset": { ... }, "hash": "..." }`, extracts the inner object.
/// Otherwise, falls back to parsing the raw object for older server compatibility.
/// If the extracted target is an object, allowlisted fields are parsed (omitted/unknown fields produce default values).
/// Neither `hash` nor secret credentials are ever retained or exposed.
/// If the value is not an object, returns a `Serialization` `ApiError` with a generic message without stringifying the raw response.
pub fn parse_safe_preset_detail(value: &Value) -> Result<SafePresetDetail> {
    let target_obj = if let Some(preset_val) = value.get("preset").filter(|v| v.is_object()) {
        preset_val
    } else {
        value
    };

    SafePresetDetail::from_value(target_obj).ok_or_else(|| {
        ApiError::Serialization("Expected preset response to be a JSON object".to_string())
    })
}

impl ApiClient {
    /// Calls GET `/api/database-v2/personas`
    /// Returns the envelope containing the list of personas and database hash.
    pub async fn get_personas(&self) -> Result<PersonasEnvelope> {
        self.get("/api/database-v2/personas").await
    }

    /// Calls GET `/api/database-v2/lorebooks`
    /// Returns the envelope containing the list of lorebooks and database hash.
    pub async fn get_lorebooks(&self) -> Result<LorebookEnvelope> {
        self.get("/api/database-v2/lorebooks").await
    }

    /// Calls GET `/api/database-v2/modules`
    /// Returns the envelope containing the list of module summaries and database hash.
    pub async fn get_modules(&self) -> Result<ModulesEnvelope> {
        self.get("/api/database-v2/modules").await
    }

    /// Calls GET `/api/database-v2/presets`
    /// Deserializes the response as a generic JSON `Value` and normalizes canonical (`{ "presets": [...], "hash": "..." }`),
    /// PostgreSQL flat (`{ "botPresets": [...] }`), and Azure/Oracle wrapped (`{ "settings": { "botPresets": [...] }, "hash": "..." }`) formats.
    pub async fn get_presets(&self) -> Result<Vec<PresetSummary>> {
        let value: Value = self.get("/api/database-v2/presets").await?;
        Ok(normalize_preset_list(&value))
    }

    /// Calls GET `/api/database-v2/presets/{id}`
    /// Deserializes the response as a generic JSON `Value`, unwraps canonical `{ "preset": <object>, "hash": "..." }`
    /// (with fallback to raw object for older servers), and parses only allowlisted safe display fields into `SafePresetDetail`.
    /// Sensitive credentials (API keys, passwords, tokens) and hash fields are never retained or included in error output.
    pub async fn get_preset_safe_detail(&self, id: &str) -> Result<SafePresetDetail> {
        let path = format!("/api/database-v2/presets/{}", urlencoding::encode(id));
        let value: Value = self.get(&path).await?;
        parse_safe_preset_detail(&value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_safe_preset_detail_canonical_wrapper() {
        let canonical_json = json!({
            "preset": {
                "id": "preset_canonical_detail",
                "name": "Canonical Sonnet Preset",
                "apiType": "anthropic",
                "aiModel": "claude-3-7-sonnet",
                "maxContext": 8192,
                "temperature": 0.7,
                "apiKey": "sk-secret-do-not-leak"
            },
            "hash": "preset_hash_detail_123"
        });

        let detail = parse_safe_preset_detail(&canonical_json)
            .expect("Should parse canonical wrapped preset object");
        assert_eq!(detail.id.as_deref(), Some("preset_canonical_detail"));
        assert_eq!(detail.name.as_deref(), Some("Canonical Sonnet Preset"));
        assert_eq!(detail.api_type.as_deref(), Some("anthropic"));
        assert_eq!(detail.ai_model.as_deref(), Some("claude-3-7-sonnet"));
        assert_eq!(detail.max_context, Some(8192));
        assert_eq!(detail.temperature, Some(0.7));

        let debug_str = format!("{:?}", detail);
        assert!(!debug_str.contains("sk-secret-do-not-leak"));
        assert!(!debug_str.contains("preset_hash_detail_123"));
        assert!(!debug_str.contains("hash"));
    }

    #[test]
    fn test_parse_safe_preset_detail_valid() {
        let valid_json = json!({
            "id": "preset_sonnet",
            "name": "Sonnet Preset",
            "apiType": "anthropic",
            "aiModel": "claude-3-5-sonnet",
            "maxContext": 4096,
            "temperature": 0.5,
            "apiKey": "sk-secret-do-not-leak"
        });

        let detail =
            parse_safe_preset_detail(&valid_json).expect("Should parse valid preset object");
        assert_eq!(detail.id.as_deref(), Some("preset_sonnet"));
        assert_eq!(detail.name.as_deref(), Some("Sonnet Preset"));
        assert_eq!(detail.api_type.as_deref(), Some("anthropic"));
        assert_eq!(detail.ai_model.as_deref(), Some("claude-3-5-sonnet"));
        assert_eq!(detail.max_context, Some(4096));
        assert_eq!(detail.temperature, Some(0.5));
    }

    #[test]
    fn test_parse_safe_preset_detail_only_unknown_or_empty_fields() {
        let empty_obj = json!({});
        let detail_empty =
            parse_safe_preset_detail(&empty_obj).expect("Empty object should return default");
        assert_eq!(detail_empty, SafePresetDetail::default());

        let unknown_fields_obj = json!({
            "unknownKey": "value",
            "someInternalSecret": "secret-value-123"
        });
        let detail_unknown = parse_safe_preset_detail(&unknown_fields_obj)
            .expect("Object with unknown fields should return default");
        assert_eq!(detail_unknown, SafePresetDetail::default());
    }

    #[test]
    fn test_parse_safe_preset_detail_non_object_error() {
        let non_objects = vec![
            json!("string_value"),
            json!(12345),
            json!(true),
            json!(null),
            json!([{"id": "p1"}]),
        ];

        for non_obj in non_objects {
            let err = parse_safe_preset_detail(&non_obj)
                .expect_err("Non-object should return ApiError::Serialization");
            match err {
                ApiError::Serialization(msg) => {
                    assert_eq!(msg, "Expected preset response to be a JSON object");
                    // Ensure raw payload is not stringified or leaked
                    assert!(!msg.contains("string_value"));
                    assert!(!msg.contains("12345"));
                }
                _ => panic!("Expected ApiError::Serialization, got {:?}", err),
            }
        }
    }

    #[test]
    fn test_get_presets_normalizer_flat_and_wrapped() {
        let canonical_response = json!({
            "presets": [
                {
                    "id": "p_canonical",
                    "name": "Canonical Preset",
                    "apiType": "anthropic"
                }
            ],
            "hash": "hash_canonical_abc"
        });
        let canonical_list = normalize_preset_list(&canonical_response);
        assert_eq!(canonical_list.len(), 1);
        assert_eq!(canonical_list[0].id.as_deref(), Some("p_canonical"));

        let flat_response = json!({
            "botPresets": [
                {
                    "id": "p_flat",
                    "name": "Flat Preset",
                    "apiType": "openai"
                }
            ]
        });
        let flat_list = normalize_preset_list(&flat_response);
        assert_eq!(flat_list.len(), 1);
        assert_eq!(flat_list[0].id.as_deref(), Some("p_flat"));

        let wrapped_response = json!({
            "settings": {
                "botPresets": [
                    {
                        "id": "p_wrapped",
                        "name": "Wrapped Preset",
                        "apiType": "anthropic"
                    }
                ]
            },
            "hash": "abc123"
        });
        let wrapped_list = normalize_preset_list(&wrapped_response);
        assert_eq!(wrapped_list.len(), 1);
        assert_eq!(wrapped_list[0].id.as_deref(), Some("p_wrapped"));
    }
}
