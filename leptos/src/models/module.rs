use serde::{Deserialize, Serialize};

/// Lightweight module summary.
/// Giant fields like cjs, lorebook, regex, triggers, assets are not retained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ModuleSummary {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(rename = "folderId", alias = "folder_id", default)]
    pub folder_id: Option<String>,
    #[serde(rename = "lowLevelAccess", alias = "low_level_access", default)]
    pub low_level_access: Option<bool>,
    #[serde(rename = "hideIcon", alias = "hide_icon", default)]
    pub hide_icon: Option<bool>,
}

/// Envelope for modules response: `{modules: <array>, hash: string}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ModulesEnvelope {
    #[serde(default)]
    pub modules: Vec<ModuleSummary>,
    #[serde(default)]
    pub hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_modules_envelope_serde() {
        let json_str = r#"{
            "modules": [
                {
                    "id": "mod_abc",
                    "name": "Custom Dice",
                    "description": "Adds dice rolling support",
                    "icon": "dice_icon_data",
                    "namespace": "dice_ns",
                    "folderId": "folder_utils",
                    "lowLevelAccess": false,
                    "hideIcon": true,
                    "cjs": "console.log('huge script payload')",
                    "lorebook": [{"huge": "lore"}],
                    "assets": {"giant": "image_data"}
                }
            ],
            "hash": "mod_hash_xyz"
        }"#;

        let envelope: ModulesEnvelope =
            serde_json::from_str(json_str).expect("should deserialize ModulesEnvelope");
        assert_eq!(envelope.hash, "mod_hash_xyz");
        assert_eq!(envelope.modules.len(), 1);

        let module = &envelope.modules[0];
        assert_eq!(module.id, "mod_abc");
        assert_eq!(module.name, "Custom Dice");
        assert_eq!(module.description, "Adds dice rolling support");
        assert_eq!(module.icon.as_deref(), Some("dice_icon_data"));
        assert_eq!(module.namespace.as_deref(), Some("dice_ns"));
        assert_eq!(module.folder_id.as_deref(), Some("folder_utils"));
        assert_eq!(module.low_level_access, Some(false));
        assert_eq!(module.hide_icon, Some(true));

        let serialized =
            serde_json::to_string(&envelope).expect("should serialize ModulesEnvelope");
        assert!(!serialized.contains("huge script payload"));
        assert!(!serialized.contains("assets"));
        assert!(!serialized.contains("cjs"));
    }
}
