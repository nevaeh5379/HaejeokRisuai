use serde::{Deserialize, Serialize};

/// Role enum matching canonical RisuAI message schema ("user" | "char").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    #[default]
    User,
    Char,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            MessageRole::User => "user",
            MessageRole::Char => "char",
        }
    }
}

/// Canonical RisuAI Message representation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Message {
    pub role: MessageRole,
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub saying: Option<String>,
    #[serde(rename = "chatId", default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub time: Option<f64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "otherUser", default)]
    pub other_user: Option<bool>,
    #[serde(default)]
    pub disabled: Option<serde_json::Value>,
    #[serde(rename = "isComment", default)]
    pub is_comment: Option<bool>,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Canonical RisuAI Chat container.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Chat {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub message: Vec<Message>,
    #[serde(rename = "messageOffset", default)]
    pub message_offset: Option<usize>,
    #[serde(rename = "messageTotal", default)]
    pub message_total: Option<usize>,
    #[serde(rename = "messagesFullyLoaded", default)]
    pub messages_fully_loaded: Option<bool>,
    #[serde(rename = "messagesLoaded", default)]
    pub messages_loaded: Option<bool>,
    #[serde(rename = "detailsLoaded", default)]
    pub details_loaded: Option<bool>,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_role_and_fields_serde() {
        // Test user message
        let user_json = r#"{
            "role": "user",
            "data": "Hello world",
            "chatId": "chat_456",
            "time": 1700000000.5
        }"#;
        let user_msg: Message =
            serde_json::from_str(user_json).expect("should deserialize user message");
        assert_eq!(user_msg.role, MessageRole::User);
        assert_eq!(user_msg.data, "Hello world");
        assert_eq!(user_msg.chat_id.as_deref(), Some("chat_456"));
        assert_eq!(user_msg.time, Some(1700000000.5));

        // Test char message
        let char_json = r#"{
            "role": "char",
            "data": "Greetings, traveller",
            "chatId": "chat_456",
            "time": 1700000010.0
        }"#;
        let char_msg: Message =
            serde_json::from_str(char_json).expect("should deserialize char message");
        assert_eq!(char_msg.role, MessageRole::Char);
        assert_eq!(char_msg.data, "Greetings, traveller");
        assert_eq!(char_msg.chat_id.as_deref(), Some("chat_456"));
        assert_eq!(char_msg.time, Some(1700000010.0));

        // Test serialization roundtrip
        let serialized = serde_json::to_string(&user_msg).expect("should serialize user message");
        assert!(serialized.contains(r#""role":"user""#));
        assert!(serialized.contains(r#""chatId":"chat_456""#));
    }
}
