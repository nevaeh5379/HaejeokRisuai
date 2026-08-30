use serde::{Deserialize, Serialize};

/// Lightweight persona representation matching RisuAI persona format.
/// Unknown fields are ignored during deserialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RisuPersona {
    #[serde(rename = "personaPrompt", alias = "persona_prompt", default)]
    pub persona_prompt: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(rename = "largePortrait", alias = "large_portrait", default)]
    pub large_portrait: Option<bool>,
    #[serde(rename = "embeddedModule", alias = "embedded_module", default)]
    pub embedded_module: Option<serde_json::Value>,
}

/// Envelope for persona list response: `GET personas -> {personas: <array>, hash: string}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PersonasEnvelope {
    #[serde(default)]
    pub personas: Vec<RisuPersona>,
    #[serde(default)]
    pub hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_personas_envelope_serde() {
        let json_str = r#"{
            "personas": [
                {
                    "id": "persona_1",
                    "name": "Test Persona",
                    "personaPrompt": "You are a helpful assistant.",
                    "icon": "icon_data_fake",
                    "note": "A sample note",
                    "largePortrait": true,
                    "embeddedModule": {"module_id": "mod_1"},
                    "ignored_unknown_field": "secret_or_large_blob"
                }
            ],
            "hash": "hash_12345"
        }"#;

        let envelope: PersonasEnvelope =
            serde_json::from_str(json_str).expect("should deserialize PersonasEnvelope");
        assert_eq!(envelope.hash, "hash_12345");
        assert_eq!(envelope.personas.len(), 1);

        let persona = &envelope.personas[0];
        assert_eq!(persona.id.as_deref(), Some("persona_1"));
        assert_eq!(persona.name, "Test Persona");
        assert_eq!(persona.persona_prompt, "You are a helpful assistant.");
        assert_eq!(persona.icon, "icon_data_fake");
        assert_eq!(persona.note.as_deref(), Some("A sample note"));
        assert_eq!(persona.large_portrait, Some(true));
        assert!(persona.embedded_module.is_some());

        let serialized =
            serde_json::to_string(&envelope).expect("should serialize PersonasEnvelope");
        assert!(!serialized.contains("ignored_unknown_field"));
        assert!(serialized.contains("personaPrompt"));
    }
}
