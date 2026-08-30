use serde::{Deserialize, Serialize};

/// Individual entry within a lorebook group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LoreEntry {
    #[serde(default)]
    pub key: String,
    #[serde(rename = "secondkey", alias = "second_key", default)]
    pub secondkey: String,
    #[serde(rename = "insertorder", alias = "insert_order", default)]
    pub insertorder: i64,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub mode: String,
    #[serde(rename = "alwaysActive", alias = "always_active", default)]
    pub always_active: bool,
    #[serde(default)]
    pub selective: bool,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(rename = "useRegex", alias = "use_regex", default)]
    pub use_regex: Option<bool>,
    #[serde(rename = "activationPercent", alias = "activation_percent", default)]
    pub activation_percent: Option<f64>,
}

/// A named group of lore entries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LorebookGroup {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub data: Vec<LoreEntry>,
}

/// Envelope for lorebook response: `{loreBook: <array>, hash: string}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LorebookEnvelope {
    #[serde(rename = "loreBook", alias = "lore_book", default)]
    pub lore_book: Vec<LorebookGroup>,
    #[serde(default)]
    pub hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lorebook_envelope_serde() {
        let json_str = r#"{
            "loreBook": [
                {
                    "name": "World Lore",
                    "data": [
                        {
                            "id": "lore_1",
                            "key": "castle,kingdom",
                            "secondkey": "royal",
                            "insertorder": 100,
                            "comment": "Castle lore",
                            "content": "The grand castle of Eldoria.",
                            "mode": "normal",
                            "alwaysActive": true,
                            "selective": false,
                            "folder": "places",
                            "useRegex": false,
                            "activationPercent": 100.0,
                            "unknown_junk": 9999
                        }
                    ]
                }
            ],
            "hash": "lore_hash_abc"
        }"#;

        let envelope: LorebookEnvelope =
            serde_json::from_str(json_str).expect("should deserialize LorebookEnvelope");
        assert_eq!(envelope.hash, "lore_hash_abc");
        assert_eq!(envelope.lore_book.len(), 1);

        let group = &envelope.lore_book[0];
        assert_eq!(group.name, "World Lore");
        assert_eq!(group.data.len(), 1);

        let entry = &group.data[0];
        assert_eq!(entry.id.as_deref(), Some("lore_1"));
        assert_eq!(entry.key, "castle,kingdom");
        assert_eq!(entry.secondkey, "royal");
        assert_eq!(entry.insertorder, 100);
        assert_eq!(entry.comment, "Castle lore");
        assert_eq!(entry.content, "The grand castle of Eldoria.");
        assert_eq!(entry.mode, "normal");
        assert!(entry.always_active);
        assert!(!entry.selective);
        assert_eq!(entry.folder.as_deref(), Some("places"));
        assert_eq!(entry.use_regex, Some(false));
        assert_eq!(entry.activation_percent, Some(100.0));

        let serialized =
            serde_json::to_string(&envelope).expect("should serialize LorebookEnvelope");
        assert!(!serialized.contains("unknown_junk"));
        assert!(serialized.contains("loreBook"));
        assert!(serialized.contains("alwaysActive"));
    }
}
