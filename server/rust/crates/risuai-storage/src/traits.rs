use async_trait::async_trait;
use serde_json::Value;

use crate::models::{DatabaseState, StorageError, SyncPayload, SyncResult, TableInfo};

#[async_trait]
pub trait ServerStorage: Send + Sync {
    fn vendor_name(&self) -> &'static str;
    fn is_enabled(&self) -> bool;

    async fn initialize(&self) -> Result<(), StorageError>;
    async fn get_state(&self) -> Result<DatabaseState, StorageError>;
    async fn sync(&self, payload: SyncPayload) -> Result<SyncResult, StorageError>;

    async fn load_startup_data(&self) -> Result<Value, StorageError>;
    async fn load_setting_keys(&self, keys: &[String]) -> Result<Value, StorageError>;
    async fn load_character(&self, id: &str) -> Result<Option<Value>, StorageError>;
    async fn load_character_asset_fields(&self, id: &str) -> Result<Value, StorageError>;
    async fn load_chat(&self, id: &str) -> Result<Option<Value>, StorageError>;
    async fn load_chat_messages(
        &self,
        chat_id: &str,
        limit: Option<usize>,
        before: Option<usize>,
    ) -> Result<Value, StorageError>;

    async fn export_snapshot(&self) -> Result<Value, StorageError>;
    async fn import_snapshot(&self, snapshot: Value) -> Result<SyncResult, StorageError>;

    async fn list_presets(&self) -> Result<Value, StorageError>;
    async fn load_preset(&self, id: &str) -> Result<Option<Value>, StorageError>;
    async fn list_plugins(&self) -> Result<Value, StorageError>;
    async fn list_plugin_custom_storage_keys(&self) -> Result<Vec<String>, StorageError>;
    async fn get_plugin_custom_storage_key(&self, key: &str)
        -> Result<Option<Value>, StorageError>;
    async fn get_plugin_custom_storage(&self) -> Result<Value, StorageError>;

    async fn cold_storage_list(&self) -> Result<Vec<String>, StorageError>;
    async fn cold_storage_get(&self, key: &str) -> Result<Option<Value>, StorageError>;
    async fn cold_storage_put(&self, key: &str, value: Value) -> Result<(), StorageError>;
    async fn cold_storage_delete(&self, keys: &[String]) -> Result<usize, StorageError>;
    async fn cold_storage_prune(&self, max_keys: usize) -> Result<usize, StorageError>;

    async fn search(&self, query: &str) -> Result<Value, StorageError>;
    async fn search_characters(&self, query: &str) -> Result<Value, StorageError>;
    async fn get_bot_stats(&self) -> Result<Value, StorageError>;
    async fn get_token_usage(&self) -> Result<Value, StorageError>;

    async fn list_revisions(&self) -> Result<Value, StorageError>;
    async fn get_revision_diff(&self) -> Result<Value, StorageError>;
    async fn get_revision_details(&self, id: i64) -> Result<Value, StorageError>;
    async fn preview_restore(&self, revision_id: i64) -> Result<Value, StorageError>;
    async fn restore_revision(&self, revision_id: i64) -> Result<Value, StorageError>;

    async fn list_tables(&self) -> Result<Vec<TableInfo>, StorageError>;
    async fn get_table_rows(
        &self,
        table: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Value, StorageError>;

    async fn update_setting(&self, key: &str, value: Value) -> Result<Value, StorageError>;
    async fn delete_setting(&self, key: &str) -> Result<Value, StorageError>;
    async fn save_preset(
        &self,
        preset: Value,
        position: Option<usize>,
    ) -> Result<Value, StorageError>;
    async fn save_module(&self, module: Value) -> Result<Value, StorageError>;
    async fn delete_module(&self, id: &str) -> Result<Value, StorageError>;
    async fn save_message(&self, chat_id: &str, message: Value) -> Result<Value, StorageError>;
    async fn delete_message(&self, chat_id: &str, message_id: &str) -> Result<Value, StorageError>;
}
