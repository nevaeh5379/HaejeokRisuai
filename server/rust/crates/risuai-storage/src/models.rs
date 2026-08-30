use serde::{Deserialize, Serialize};

pub const POSTGRES_SCHEMA_VERSION: i32 = 4;
pub const RELATIONAL_SCHEMA_LAYOUT: &str = "relational-schema-v3";

pub const DEFERRED_SETTING_KEYS: &[&str] = &[
    "plugins",
    "pluginCustomStorage",
    "personas",
    "botPresets",
    "botPresetsId",
    "loreBook",
    "modules",
    "globalscript",
    "promptTemplate",
    "promptSettings",
    "mainPrompt",
    "jailbreak",
    "globalNote",
    "additionalPrompt",
    "supaMemoryPrompt",
    "emotionPrompt",
    "emotionPrompt2",
    "autoSuggestPrompt",
    "translatorPrompt",
    "instructChatTemplate",
    "JinjaTemplate",
    "customTokenizer",
    "customPromptTemplateToggle",
    "customModels",
    "translatorPresets",
    "loadouts",
    "customBackground",
];

pub const PROMPT_SETTING_KEYS: &[&str] = &[
    "mainPrompt",
    "jailbreak",
    "globalNote",
    "additionalPrompt",
    "supaMemoryPrompt",
    "emotionPrompt",
    "emotionPrompt2",
    "autoSuggestPrompt",
    "translatorPrompt",
    "instructChatTemplate",
    "JinjaTemplate",
    "customTokenizer",
    "promptTemplate",
    "promptSettings",
    "customPromptTemplateToggle",
];

pub const DEFERRED_STARTUP_SETTING_KEYS: &[&str] = &[
    "plugins",
    "loadouts",
    "loreBook",
    "globalscript",
    "pluginCustomStorage",
    "mainPrompt",
    "jailbreak",
    "globalNote",
    "additionalPrompt",
    "supaMemoryPrompt",
    "emotionPrompt",
    "emotionPrompt2",
    "autoSuggestPrompt",
    "translatorPrompt",
    "instructChatTemplate",
    "JinjaTemplate",
    "customTokenizer",
    "promptTemplate",
    "promptSettings",
    "customPromptTemplateToggle",
];

pub const DOMAIN_STORE_SETTING_KEYS: &[&str] = &[
    "personas",
    "selectedPersona",
    "username",
    "userIcon",
    "userNote",
    "personaPrompt",
    "modules",
    "enabledModules",
    "moduleFolders",
    "activeBotPresetId",
];

pub const BOOTSTRAP_SETTING_KEYS: &[&str] = &[
    "plugins",
    "pluginCustomStorage",
    "loreBook",
    "globalscript",
    "customModels",
    "translatorPresets",
    "loadouts",
    "customBackground",
    "mainPrompt",
    "jailbreak",
    "globalNote",
    "additionalPrompt",
    "supaMemoryPrompt",
    "emotionPrompt",
    "emotionPrompt2",
    "autoSuggestPrompt",
    "translatorPrompt",
    "instructChatTemplate",
    "JinjaTemplate",
    "customTokenizer",
    "promptTemplate",
    "promptSettings",
    "customPromptTemplateToggle",
];

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("Storage revision conflict")]
    RevisionConflict { revision: i64 },
    #[error("Invalid sync payload: {0}")]
    InvalidPayload(String),
    #[error("Database error: {0}")]
    Database(String),
    #[error("Storage unavailable")]
    Unavailable(String),
    #[error("Not supported: {0}")]
    NotSupported(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseState {
    pub revision: i64,
    pub initialized: bool,
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
    #[serde(rename = "schemaLayout")]
    pub schema_layout: String,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingUpsert {
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityUpsert {
    pub id: String,
    pub position: Option<usize>,
    #[serde(rename = "characterId", skip_serializing_if = "Option::is_none")]
    pub character_id: Option<String>,
    #[serde(rename = "chatId", skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RootSection {
    #[serde(default)]
    pub upserts: Vec<SettingUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PresetsSection {
    #[serde(default)]
    pub upserts: Vec<EntityUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(rename = "activeId", skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersonasSection {
    #[serde(default)]
    pub upserts: Vec<EntityUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(rename = "selectedId", skip_serializing_if = "Option::is_none")]
    pub selected_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModulesSection {
    #[serde(default)]
    pub upserts: Vec<EntityUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(rename = "enabledIds", default)]
    pub enabled_ids: Vec<String>,
    #[serde(default)]
    pub folders: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CharactersSection {
    #[serde(default)]
    pub upserts: Vec<EntityUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatsSection {
    #[serde(default)]
    pub upserts: Vec<EntityUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MessagesSection {
    #[serde(default)]
    pub upserts: Vec<EntityUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginStorageSection {
    #[serde(default)]
    pub upserts: Vec<SettingUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
    pub clear: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncPayload {
    #[serde(rename = "baseRevision")]
    pub base_revision: Option<i64>,
    #[serde(rename = "replaceAll")]
    pub replace_all: Option<bool>,
    pub root: Option<RootSection>,
    #[serde(rename = "rootUpserts")]
    pub root_upserts: Option<Vec<SettingUpsert>>,
    #[serde(rename = "rootDeletes")]
    pub root_deletes: Option<Vec<String>>,
    pub presets: Option<PresetsSection>,
    pub personas: Option<PersonasSection>,
    pub modules: Option<ModulesSection>,
    pub characters: Option<CharactersSection>,
    pub chats: Option<ChatsSection>,
    pub messages: Option<MessagesSection>,
    #[serde(rename = "pluginStorage")]
    pub plugin_storage: Option<PluginStorageSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub success: bool,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    #[serde(rename = "rowCount")]
    pub row_count: i64,
}
