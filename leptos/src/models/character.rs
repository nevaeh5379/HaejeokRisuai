use serde::{Deserialize, Serialize};

/// Lightweight search summary returned by `GET /api/database-v2/characters/search`
/// Fixed shape containing exactly `id` and `name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CharacterSummary {
    pub id: String,
    pub name: String,
}

/// Conservative character detail matching canonical RisuAI character schema.
/// Minimal typed core fields + raw serde_json Map for unported/extended fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CharacterDetail {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "chaId", default)]
    pub cha_id: Option<String>,
    #[serde(rename = "firstMessage", default)]
    pub first_message: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "exampleMessage", default)]
    pub example_message: Option<String>,
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub personality: Option<String>,
    #[serde(default)]
    pub scenario: Option<String>,
    #[serde(rename = "creatorNotes", default)]
    pub creator_notes: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(rename = "characterVersion", default)]
    pub character_version: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(rename = "firstMsgIndex", default)]
    pub first_msg_index: Option<usize>,
    #[serde(rename = "alternateGreetings", default)]
    pub alternate_greetings: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_character_summary_serde() {
        let json_str = r#"{"id":"char_123","name":"Test Character"}"#;
        let summary: CharacterSummary =
            serde_json::from_str(json_str).expect("should deserialize CharacterSummary");
        assert_eq!(summary.id, "char_123");
        assert_eq!(summary.name, "Test Character");

        let serialized =
            serde_json::to_string(&summary).expect("should serialize CharacterSummary");
        assert!(serialized.contains(r#""id":"char_123""#));
        assert!(serialized.contains(r#""name":"Test Character""#));
    }
}
