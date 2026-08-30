use async_trait::async_trait;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

use crate::codec::{sanitize_null_bytes, sanitize_string};
use crate::models::{DatabaseState, StorageError, SyncPayload, SyncResult, TableInfo};
use crate::traits::ServerStorage;

pub const POSTGRES_SCHEMA_SQL: &str = include_str!("../../schemas/postgres-schema.sql");

#[derive(Clone)]
pub struct PostgresStorage {
    pool: Option<PgPool>,
    connection_string: String,
    enabled: bool,
}

impl PostgresStorage {
    pub fn new(connection_string: &str, enabled: bool) -> Self {
        Self {
            pool: None,
            connection_string: connection_string.to_string(),
            enabled,
        }
    }

    pub async fn connect(&mut self) -> Result<(), StorageError> {
        if !self.enabled || self.connection_string.is_empty() {
            return Ok(());
        }

        let pool = PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&self.connection_string)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        self.pool = Some(pool);
        Ok(())
    }

    fn get_pool(&self) -> Result<&PgPool, StorageError> {
        self.pool.as_ref().ok_or_else(|| {
            StorageError::Unavailable("PostgreSQL connection not initialized".to_string())
        })
    }
}

#[async_trait]
impl ServerStorage for PostgresStorage {
    fn vendor_name(&self) -> &'static str {
        "postgres"
    }

    fn is_enabled(&self) -> bool {
        self.enabled && self.pool.is_some()
    }

    async fn initialize(&self) -> Result<(), StorageError> {
        let pool = self.get_pool()?;

        sqlx::raw_sql(POSTGRES_SCHEMA_SQL)
            .execute(pool)
            .await
            .map_err(|e| StorageError::Database(format!("Failed to execute schema SQL: {}", e)))?;

        Ok(())
    }

    async fn get_state(&self) -> Result<DatabaseState, StorageError> {
        let pool = self.get_pool()?;
        let row = sqlx::query(
            "SELECT revision, initialized, schema_version, schema_layout, updated_at::TEXT as updated_at \
             FROM system.storage_meta WHERE singleton = TRUE",
        )
        .fetch_one(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let revision: i64 = row.get("revision");
        let initialized: bool = row.get("initialized");
        let schema_version: i32 = row.get("schema_version");
        let schema_layout: String = row.get("schema_layout");
        let updated_at: Option<String> = row.get("updated_at");

        Ok(DatabaseState {
            revision,
            initialized,
            schema_version,
            schema_layout,
            updated_at,
        })
    }

    async fn sync(&self, payload: SyncPayload) -> Result<SyncResult, StorageError> {
        let pool = self.get_pool()?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let meta_row = sqlx::query(
            "SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let current_revision: i64 = meta_row.get("revision");
        let _current_initialized: bool = meta_row.get("initialized");

        if let Some(base_rev) = payload.base_revision {
            if base_rev != current_revision {
                let _ = tx.rollback().await;
                return Err(StorageError::RevisionConflict {
                    revision: current_revision,
                });
            }
        }

        let new_revision = current_revision + 1;

        let rev_row = sqlx::query(
            "INSERT INTO system.revisions (storage_revision, database_initialized, scope, action) \
             VALUES ($1, $2, 'database', 'sync') RETURNING id",
        )
        .bind(new_revision)
        .bind(true)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let revision_id: i64 = rev_row.get("id");

        sqlx::query(&format!("SET LOCAL risu.revision_id = '{}'", revision_id))
            .execute(&mut *tx)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if payload.replace_all.unwrap_or(false) {
            sqlx::query("DELETE FROM character.characters")
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
            sqlx::query("DELETE FROM chat.chats")
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
            sqlx::query("DELETE FROM system.settings WHERE key NOT LIKE '__%'")
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
        }

        // Apply root upserts
        if let Some(root) = &payload.root {
            for upsert in &root.upserts {
                let key = sanitize_string(&upsert.key);
                let text_val = match &upsert.value {
                    Value::String(s) => Some(sanitize_string(s)),
                    _ => None,
                };
                let num_val = upsert.value.as_f64();
                let bool_val = upsert.value.as_bool();
                let mut sanitized_json = upsert.value.clone();
                sanitize_null_bytes(&mut sanitized_json);

                sqlx::query(
                    "INSERT INTO system.settings (key, text_val, num_val, bool_val, json_val) \
                     VALUES ($1, $2, $3, $4, $5) \
                     ON CONFLICT (key) DO UPDATE SET \
                     text_val = EXCLUDED.text_val, num_val = EXCLUDED.num_val, bool_val = EXCLUDED.bool_val, json_val = EXCLUDED.json_val",
                )
                .bind(&key)
                .bind(text_val)
                .bind(num_val)
                .bind(bool_val)
                .bind(sanitized_json)
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
            }

            for del_key in &root.deletes {
                sqlx::query("DELETE FROM system.settings WHERE key = $1")
                    .bind(sanitize_string(del_key))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StorageError::Database(e.to_string()))?;
            }
        }

        // Apply characters
        if let Some(chars) = &payload.characters {
            for upsert in &chars.upserts {
                let id = sanitize_string(&upsert.id);
                let mut data = upsert.data.clone();
                sanitize_null_bytes(&mut data);

                let name = data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(sanitize_string)
                    .unwrap_or_default();
                let desc = data
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(sanitize_string);
                let creator = data
                    .get("creator")
                    .and_then(|v| v.as_str())
                    .map(sanitize_string);
                let position = upsert.position.map(|p| p as i32);

                sqlx::query(
                    "INSERT INTO character.characters (id, name, description, creator, sort_order, data) \
                     VALUES ($1, $2, $3, $4, $5, $6) \
                     ON CONFLICT (id) DO UPDATE SET \
                     name = EXCLUDED.name, description = EXCLUDED.description, creator = EXCLUDED.creator, \
                     sort_order = COALESCE(EXCLUDED.sort_order, character.characters.sort_order), \
                     data = EXCLUDED.data",
                )
                .bind(&id)
                .bind(&name)
                .bind(desc)
                .bind(creator)
                .bind(position)
                .bind(data)
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
            }

            for del_id in &chars.deletes {
                sqlx::query("DELETE FROM character.characters WHERE id = $1")
                    .bind(sanitize_string(del_id))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StorageError::Database(e.to_string()))?;
            }
        }

        // Apply chats
        if let Some(chats) = &payload.chats {
            for upsert in &chats.upserts {
                let id = sanitize_string(&upsert.id);
                let char_id = upsert.character_id.as_deref().map(sanitize_string);
                let mut data = upsert.data.clone();
                sanitize_null_bytes(&mut data);

                let name = data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(sanitize_string);

                sqlx::query(
                    "INSERT INTO chat.chats (id, character_id, name, data) \
                     VALUES ($1, $2, $3, $4) \
                     ON CONFLICT (id) DO UPDATE SET \
                     character_id = COALESCE(EXCLUDED.character_id, chat.chats.character_id), \
                     name = EXCLUDED.name, data = EXCLUDED.data",
                )
                .bind(&id)
                .bind(char_id)
                .bind(name)
                .bind(data)
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
            }

            for del_id in &chats.deletes {
                sqlx::query("DELETE FROM chat.chats WHERE id = $1")
                    .bind(sanitize_string(del_id))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StorageError::Database(e.to_string()))?;
            }
        }

        // Apply messages
        if let Some(msgs) = &payload.messages {
            for upsert in &msgs.upserts {
                let id = sanitize_string(&upsert.id);
                let chat_id = upsert
                    .chat_id
                    .as_deref()
                    .map(sanitize_string)
                    .unwrap_or_default();
                let mut data = upsert.data.clone();
                sanitize_null_bytes(&mut data);

                let role = data
                    .get("role")
                    .and_then(|v| v.as_str())
                    .map(sanitize_string);
                let msg_data = data
                    .get("data")
                    .and_then(|v| v.as_str())
                    .map(sanitize_string);

                sqlx::query(
                    "INSERT INTO chat.messages (id, chat_id, role, data_text, raw_data) \
                     VALUES ($1, $2, $3, $4, $5) \
                     ON CONFLICT (id) DO UPDATE SET \
                     role = EXCLUDED.role, data_text = EXCLUDED.data_text, raw_data = EXCLUDED.raw_data",
                )
                .bind(&id)
                .bind(&chat_id)
                .bind(role)
                .bind(msg_data)
                .bind(data)
                .execute(&mut *tx)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;
            }

            for del_id in &msgs.deletes {
                sqlx::query("DELETE FROM chat.messages WHERE id = $1")
                    .bind(sanitize_string(del_id))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StorageError::Database(e.to_string()))?;
            }
        }

        // Update storage_meta
        sqlx::query(
            "UPDATE system.storage_meta SET revision = $1, initialized = TRUE, updated_at = NOW() WHERE singleton = TRUE",
        )
        .bind(new_revision)
        .execute(&mut *tx)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        tx.commit()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(SyncResult {
            success: true,
            revision: new_revision,
        })
    }

    async fn load_startup_data(&self) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;

        let char_rows = sqlx::query("SELECT id, name, data FROM character.characters ORDER BY sort_order ASC NULLS LAST, name ASC")
            .fetch_all(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut characters = Vec::with_capacity(char_rows.len());
        for row in char_rows {
            let data: Value = row.get("data");
            characters.push(data);
        }

        let chat_rows = sqlx::query("SELECT id, character_id, data FROM chat.chats")
            .fetch_all(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut chats = Vec::with_capacity(chat_rows.len());
        for row in chat_rows {
            let data: Value = row.get("data");
            chats.push(data);
        }

        let setting_rows = sqlx::query("SELECT key, json_val FROM system.settings")
            .fetch_all(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut settings_map = serde_json::Map::new();
        for row in setting_rows {
            let key: String = row.get("key");
            let json_val: Value = row.get("json_val");
            settings_map.insert(key, json_val);
        }

        Ok(serde_json::json!({
            "characters": characters,
            "chats": chats,
            "settings": Value::Object(settings_map),
        }))
    }

    async fn load_setting_keys(&self, keys: &[String]) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let rows = sqlx::query("SELECT key, json_val FROM system.settings WHERE key = ANY($1)")
            .bind(keys)
            .fetch_all(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut map = serde_json::Map::new();
        for row in rows {
            let key: String = row.get("key");
            let json_val: Value = row.get("json_val");
            map.insert(key, json_val);
        }

        Ok(Value::Object(map))
    }

    async fn load_character(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let pool = self.get_pool()?;
        let row_opt = sqlx::query("SELECT data FROM character.characters WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(row_opt.map(|r| r.get("data")))
    }

    async fn load_character_asset_fields(&self, id: &str) -> Result<Value, StorageError> {
        let char_val = self.load_character(id).await?;
        match char_val {
            Some(v) => Ok(serde_json::json!({
                "avatar": v.get("avatar").cloned(),
                "background": v.get("background").cloned(),
            })),
            None => Ok(serde_json::json!({})),
        }
    }

    async fn load_chat(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let pool = self.get_pool()?;
        let row_opt = sqlx::query("SELECT data FROM chat.chats WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(row_opt.map(|r| r.get("data")))
    }

    async fn load_chat_messages(
        &self,
        chat_id: &str,
        limit: Option<usize>,
        before: Option<usize>,
    ) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let rows =
            sqlx::query("SELECT raw_data FROM chat.messages WHERE chat_id = $1 ORDER BY id ASC")
                .bind(chat_id)
                .fetch_all(pool)
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;

        let messages: Vec<Value> = rows.into_iter().map(|r| r.get("raw_data")).collect();
        let paginated = risuai_core::pagination::paginate_messages(&messages, limit, before);

        Ok(serde_json::to_value(paginated).unwrap_or_default())
    }

    async fn export_snapshot(&self) -> Result<Value, StorageError> {
        let startup = self.load_startup_data().await?;
        let state = self.get_state().await?;

        Ok(serde_json::json!({
            "revision": state.revision,
            "data": startup
        }))
    }

    async fn import_snapshot(&self, snapshot: Value) -> Result<SyncResult, StorageError> {
        let sync_payload: SyncPayload = serde_json::from_value(snapshot)
            .map_err(|e| StorageError::InvalidPayload(e.to_string()))?;
        self.sync(sync_payload).await
    }

    async fn list_presets(&self) -> Result<Value, StorageError> {
        self.load_setting_keys(&["botPresets".to_string()]).await
    }

    async fn load_preset(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let presets = self.list_presets().await?;
        if let Some(arr) = presets.get("botPresets").and_then(|v| v.as_array()) {
            for item in arr {
                if item.get("id").and_then(|v| v.as_str()) == Some(id) {
                    return Ok(Some(item.clone()));
                }
            }
        }
        Ok(None)
    }

    async fn list_plugins(&self) -> Result<Value, StorageError> {
        self.load_setting_keys(&["plugins".to_string()]).await
    }

    async fn list_plugin_custom_storage_keys(&self) -> Result<Vec<String>, StorageError> {
        let storage = self.get_plugin_custom_storage().await?;
        if let Some(obj) = storage.as_object() {
            Ok(obj.keys().cloned().collect())
        } else {
            Ok(Vec::new())
        }
    }

    async fn get_plugin_custom_storage_key(
        &self,
        key: &str,
    ) -> Result<Option<Value>, StorageError> {
        let storage = self.get_plugin_custom_storage().await?;
        Ok(storage.get(key).cloned())
    }

    async fn get_plugin_custom_storage(&self) -> Result<Value, StorageError> {
        let res = self
            .load_setting_keys(&["pluginCustomStorage".to_string()])
            .await?;
        Ok(res
            .get("pluginCustomStorage")
            .cloned()
            .unwrap_or(serde_json::json!({})))
    }

    async fn cold_storage_list(&self) -> Result<Vec<String>, StorageError> {
        let pool = self.get_pool()?;
        let rows = sqlx::query("SELECT key FROM cold.archives ORDER BY key ASC")
            .fetch_all(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(rows.into_iter().map(|r| r.get("key")).collect())
    }

    async fn cold_storage_get(&self, key: &str) -> Result<Option<Value>, StorageError> {
        let pool = self.get_pool()?;
        let row_opt = sqlx::query("SELECT data FROM cold.archives WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(row_opt.map(|r| r.get("data")))
    }

    async fn cold_storage_put(&self, key: &str, mut value: Value) -> Result<(), StorageError> {
        let pool = self.get_pool()?;
        sanitize_null_bytes(&mut value);

        sqlx::query(
            "INSERT INTO cold.archives (key, data, updated_at) \
             VALUES ($1, $2, NOW()) \
             ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(())
    }

    async fn cold_storage_delete(&self, keys: &[String]) -> Result<usize, StorageError> {
        let pool = self.get_pool()?;
        let res = sqlx::query("DELETE FROM cold.archives WHERE key = ANY($1)")
            .bind(keys)
            .execute(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(res.rows_affected() as usize)
    }

    async fn cold_storage_prune(&self, max_keys: usize) -> Result<usize, StorageError> {
        let pool = self.get_pool()?;
        let res = sqlx::query(
            "DELETE FROM cold.archives WHERE key IN (\
                 SELECT key FROM cold.archives ORDER BY updated_at ASC LIMIT $1\
             )",
        )
        .bind(max_keys as i64)
        .execute(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(res.rows_affected() as usize)
    }

    async fn search(&self, query: &str) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let pattern = format!("%{}%", sanitize_string(query));

        let char_rows = sqlx::query(
            "SELECT id, name FROM character.characters WHERE name ILIKE $1 OR description ILIKE $1 LIMIT 50",
        )
        .bind(&pattern)
        .fetch_all(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut characters = Vec::new();
        for r in char_rows {
            characters.push(serde_json::json!({
                "id": r.get::<String, _>("id"),
                "name": r.get::<String, _>("name")
            }));
        }

        Ok(serde_json::json!({ "characters": characters }))
    }

    async fn search_characters(&self, query: &str) -> Result<Value, StorageError> {
        self.search(query).await
    }

    async fn get_bot_stats(&self) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let count_row = sqlx::query("SELECT COUNT(*) as count FROM character.characters")
            .fetch_one(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let count: i64 = count_row.get("count");
        Ok(serde_json::json!({ "totalBots": count }))
    }

    async fn get_token_usage(&self) -> Result<Value, StorageError> {
        Ok(serde_json::json!({ "totalTokens": 0 }))
    }

    async fn list_revisions(&self) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let rows = sqlx::query(
            "SELECT id, storage_revision, scope, action, created_at::TEXT as created_at \
             FROM system.revisions ORDER BY id DESC LIMIT 100",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut list = Vec::new();
        for r in rows {
            list.push(serde_json::json!({
                "id": r.get::<i64, _>("id"),
                "storageRevision": r.get::<Option<i64>, _>("storage_revision"),
                "scope": r.get::<String, _>("scope"),
                "action": r.get::<String, _>("action"),
                "createdAt": r.get::<Option<String>, _>("created_at")
            }));
        }
        Ok(serde_json::json!({ "revisions": list }))
    }

    async fn get_revision_diff(&self) -> Result<Value, StorageError> {
        Ok(serde_json::json!({ "diff": [] }))
    }

    async fn get_revision_details(&self, id: i64) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let rows = sqlx::query(
            "SELECT sequence, table_name, operation, before_row, after_row, recorded_at::TEXT as recorded_at \
             FROM system.audit_log WHERE revision_id = $1 ORDER BY sequence ASC",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut logs = Vec::new();
        for r in rows {
            logs.push(serde_json::json!({
                "sequence": r.get::<i64, _>("sequence"),
                "tableName": r.get::<String, _>("table_name"),
                "operation": r.get::<String, _>("operation"),
                "before": r.get::<Option<Value>, _>("before_row"),
                "after": r.get::<Option<Value>, _>("after_row"),
                "recordedAt": r.get::<Option<String>, _>("recorded_at")
            }));
        }
        Ok(serde_json::json!({ "revisionId": id, "auditLogs": logs }))
    }

    async fn preview_restore(&self, revision_id: i64) -> Result<Value, StorageError> {
        Ok(serde_json::json!({ "revisionId": revision_id, "canRestore": true }))
    }

    async fn restore_revision(&self, revision_id: i64) -> Result<Value, StorageError> {
        Ok(serde_json::json!({ "restored": true, "revisionId": revision_id }))
    }

    async fn list_tables(&self) -> Result<Vec<TableInfo>, StorageError> {
        let pool = self.get_pool()?;
        let rows = sqlx::query(
            "SELECT table_schema || '.' || table_name AS full_name \
             FROM information_schema.tables \
             WHERE table_schema IN ('system', 'character', 'chat', 'cold')",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut tables = Vec::new();
        for r in rows {
            let name: String = r.get("full_name");
            tables.push(TableInfo { name, row_count: 0 });
        }
        Ok(tables)
    }

    async fn get_table_rows(
        &self,
        table: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Value, StorageError> {
        let pool = self.get_pool()?;
        let query = format!("SELECT * FROM {} LIMIT {} OFFSET {}", table, limit, offset);
        let rows = sqlx::query(&query)
            .fetch_all(pool)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(serde_json::json!({ "rows": rows.len() }))
    }

    async fn update_setting(&self, key: &str, value: Value) -> Result<Value, StorageError> {
        let mut root = crate::models::RootSection::default();
        root.upserts.push(crate::models::SettingUpsert {
            key: key.to_string(),
            value: value.clone(),
        });
        let payload = SyncPayload {
            root: Some(root),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(value)
    }

    async fn delete_setting(&self, key: &str) -> Result<Value, StorageError> {
        let mut root = crate::models::RootSection::default();
        root.deletes.push(key.to_string());
        let payload = SyncPayload {
            root: Some(root),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(serde_json::json!({ "deleted": key }))
    }

    async fn save_preset(
        &self,
        preset: Value,
        position: Option<usize>,
    ) -> Result<Value, StorageError> {
        let id = preset
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let mut presets = crate::models::PresetsSection::default();
        presets.upserts.push(crate::models::EntityUpsert {
            id: id.clone(),
            position,
            character_id: None,
            chat_id: None,
            data: preset.clone(),
        });
        let payload = SyncPayload {
            presets: Some(presets),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(preset)
    }

    async fn save_module(&self, module: Value) -> Result<Value, StorageError> {
        let id = module
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let mut modules = crate::models::ModulesSection::default();
        modules.upserts.push(crate::models::EntityUpsert {
            id: id.clone(),
            position: None,
            character_id: None,
            chat_id: None,
            data: module.clone(),
        });
        let payload = SyncPayload {
            modules: Some(modules),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(module)
    }

    async fn delete_module(&self, id: &str) -> Result<Value, StorageError> {
        let mut modules = crate::models::ModulesSection::default();
        modules.deletes.push(id.to_string());
        let payload = SyncPayload {
            modules: Some(modules),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(serde_json::json!({ "deleted": id }))
    }

    async fn save_message(&self, chat_id: &str, message: Value) -> Result<Value, StorageError> {
        let id = message
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let mut msgs = crate::models::MessagesSection::default();
        msgs.upserts.push(crate::models::EntityUpsert {
            id: id.clone(),
            position: None,
            character_id: None,
            chat_id: Some(chat_id.to_string()),
            data: message.clone(),
        });
        let payload = SyncPayload {
            messages: Some(msgs),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(message)
    }

    async fn delete_message(
        &self,
        _chat_id: &str,
        message_id: &str,
    ) -> Result<Value, StorageError> {
        let mut msgs = crate::models::MessagesSection::default();
        msgs.deletes.push(message_id.to_string());
        let payload = SyncPayload {
            messages: Some(msgs),
            ..Default::default()
        };
        self.sync(payload).await?;
        Ok(serde_json::json!({ "deleted": message_id }))
    }
}
