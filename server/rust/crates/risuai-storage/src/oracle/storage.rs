use async_trait::async_trait;
use serde_json::{json, Value};

use crate::models::{DatabaseState, StorageError, SyncPayload, SyncResult, TableInfo};
use crate::traits::ServerStorage;

pub const ORACLE_SCHEMA_SQL: &str = include_str!("../../schemas/oracle-schema.sql");

#[derive(Clone)]
pub struct OracleStorage {
    connection_string: String,
    enabled: bool,
}

impl OracleStorage {
    pub fn new(connection_string: &str, enabled: bool) -> Self {
        Self {
            connection_string: connection_string.to_string(),
            enabled,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.enabled && !self.connection_string.is_empty()
    }

    pub fn get_sync_connection(&self) -> Result<oracle::Connection, StorageError> {
        let parsed = url::Url::parse(&self.connection_string).map_err(|e| {
            StorageError::InvalidPayload(format!("Invalid Oracle connection string: {}", e))
        })?;

        let host = parsed.host_str().unwrap_or("localhost");
        let port = parsed.port().unwrap_or(1521);
        let service = parsed.path().trim_start_matches('/');
        let user = parsed.username();
        let password = parsed.password().unwrap_or("");

        let conn_str = format!("{}:{}/{}", host, port, service);
        oracle::Connection::connect(user, password, &conn_str)
            .map_err(|e| StorageError::Unavailable(format!("Oracle connect error: {}", e)))
    }

    pub async fn connect(&self) -> Result<(), StorageError> {
        if !self.enabled || self.connection_string.is_empty() {
            return Ok(());
        }
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let _ = storage.get_sync_connection()?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Unavailable(e.to_string()))?
    }
}

#[async_trait]
impl ServerStorage for OracleStorage {
    fn vendor_name(&self) -> &'static str {
        "oracle"
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(&self) -> Result<(), StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            for stmt in ORACLE_SCHEMA_SQL.split('/') {
                let s = stmt.trim();
                if !s.is_empty() {
                    let _ = conn.execute(s, &[]);
                }
            }
            let _ = conn.commit();
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn get_state(&self) -> Result<DatabaseState, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = "SELECT revision, initialized, schema_version, schema_layout, TO_CHAR(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') \
                       FROM system_storage_meta WHERE singleton = 1";

            if let Ok(rows) = conn.query(sql, &[]) {
                if let Some(row) = rows.flatten().next() {
                    let revision: i64 = row.get(0).unwrap_or(0);
                    let initialized_num: i32 = row.get(1).unwrap_or(1);
                    let schema_version: i32 = row.get(2).unwrap_or(4);
                    let schema_layout: String = row.get(3).unwrap_or_else(|_| "relational-schema-v3".to_string());
                    let updated_at: Option<String> = row.get(4).ok();

                    return Ok(DatabaseState {
                        revision,
                        initialized: initialized_num == 1,
                        schema_version,
                        schema_layout,
                        updated_at,
                    });
                }
            }

            Ok(DatabaseState {
                revision: 0,
                initialized: false,
                schema_version: 4,
                schema_layout: "relational-schema-v3".to_string(),
                updated_at: None,
            })
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn sync(&self, payload: SyncPayload) -> Result<SyncResult, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;

            let state = storage.get_sync_connection().map(|c| {
                let sql = "SELECT revision FROM system_storage_meta WHERE singleton = 1";
                if let Ok(rows) = c.query(sql, &[]) {
                    if let Some(row) = rows.flatten().next() {
                        let r: i64 = row.get(0).unwrap_or(0);
                        return r;
                    }
                }
                0i64
            }).unwrap_or_default();

            if let Some(expected) = payload.base_revision {
                if expected != state && expected != 0 {
                    return Err(StorageError::RevisionConflict {
                        revision: state,
                    });
                }
            }

            let next_revision = state + 1;

            // 1. Revision
            let action = "sync";
            let _ = conn.execute(
                "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action) VALUES (:1, 1, 'database', :2)",
                &[&next_revision, &action],
            );

            // 2. Replace all if requested
            if payload.replace_all.unwrap_or(false) {
                let _ = conn.execute("DELETE FROM char_characters", &[]);
                let _ = conn.execute("DELETE FROM chat_chats", &[]);
                let _ = conn.execute("DELETE FROM chat_messages", &[]);
            }

            // 3. Settings root
            if let Some(root) = &payload.root {
                for up in &root.upserts {
                    let key = &up.key;
                    let val_str = up.value.to_string();
                    let sql = "MERGE INTO system_settings target \
                               USING (SELECT :1 AS setting_key, :2 AS text_val FROM DUAL) source \
                               ON (target.setting_key = source.setting_key) \
                               WHEN MATCHED THEN UPDATE SET target.text_val = source.text_val \
                               WHEN NOT MATCHED THEN INSERT (setting_key, text_val) VALUES (source.setting_key, source.text_val)";
                    let _ = conn.execute(sql, &[key, &val_str]);
                }
                for del_key in &root.deletes {
                    let _ = conn.execute("DELETE FROM system_settings WHERE setting_key = :1", &[del_key]);
                }
            }

            // 4. Characters
            if let Some(chars) = &payload.characters {
                for up in &chars.upserts {
                    let id = &up.id;
                    let pos = up.position.unwrap_or(0) as i64;
                    let name = up.data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let image = up.data.get("image").and_then(|v| v.as_str()).unwrap_or("");
                    let data_str = up.data.to_string();
                    let sql = "MERGE INTO char_characters target \
                               USING (SELECT :1 AS id, :2 AS pos, :3 AS name, :4 AS image, :5 AS data FROM DUAL) source \
                               ON (target.id = source.id) \
                               WHEN MATCHED THEN UPDATE SET target.position = source.pos, target.name = source.name, target.image = source.image, target.data = source.data \
                               WHEN NOT MATCHED THEN INSERT (id, position, name, image, data) VALUES (source.id, source.pos, source.name, source.image, source.data)";
                    let _ = conn.execute(sql, &[id, &pos, &name, &image, &data_str]);
                }
                for char_id in &chars.deletes {
                    let _ = conn.execute("DELETE FROM char_characters WHERE id = :1", &[char_id]);
                }
            }

            // 5. Chats
            if let Some(chats) = &payload.chats {
                for up in &chats.upserts {
                    let id = &up.id;
                    let char_id = up.character_id.as_deref().unwrap_or("");
                    let pos = up.position.unwrap_or(0) as i64;
                    let name = up.data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let data_str = up.data.to_string();
                    let sql = "MERGE INTO chat_chats target \
                               USING (SELECT :1 AS id, :2 AS char_id, :3 AS pos, :4 AS name, :5 AS data FROM DUAL) source \
                               ON (target.id = source.id) \
                               WHEN MATCHED THEN UPDATE SET target.character_id = source.char_id, target.position = source.pos, target.name = source.name, target.data = source.data \
                               WHEN NOT MATCHED THEN INSERT (id, character_id, position, name, data) VALUES (source.id, source.char_id, source.pos, source.name, source.data)";
                    let _ = conn.execute(sql, &[id, &char_id, &pos, &name, &data_str]);
                }
                for chat_id in &chats.deletes {
                    let _ = conn.execute("DELETE FROM chat_chats WHERE id = :1", &[chat_id]);
                }
            }

            // 6. Messages
            if let Some(msgs) = &payload.messages {
                for up in &msgs.upserts {
                    let id = &up.id;
                    let chat_id = up.chat_id.as_deref().unwrap_or("");
                    let pos = up.position.unwrap_or(0) as i64;
                    let data_str = up.data.to_string();
                    let sql = "MERGE INTO chat_messages target \
                               USING (SELECT :1 AS id, :2 AS chat_id, :3 AS pos, :4 AS data FROM DUAL) source \
                               ON (target.id = source.id) \
                               WHEN MATCHED THEN UPDATE SET target.chat_id = source.chat_id, target.position = source.pos, target.data = source.data \
                               WHEN NOT MATCHED THEN INSERT (id, chat_id, position, data) VALUES (source.id, source.chat_id, source.pos, source.data)";
                    let _ = conn.execute(sql, &[id, &chat_id, &pos, &data_str]);
                }
                for msg_id in &msgs.deletes {
                    let _ = conn.execute("DELETE FROM chat_messages WHERE id = :1", &[msg_id]);
                }
            }

            // 7. Update storage meta
            let _ = conn.execute(
                "UPDATE system_storage_meta SET revision = :1, initialized = 1, updated_at = SYSTIMESTAMP WHERE singleton = 1",
                &[&next_revision],
            );

            conn.commit().map_err(|e| StorageError::Database(e.to_string()))?;

            Ok(SyncResult {
                success: true,
                revision: next_revision,
            })
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn load_startup_data(&self) -> Result<Value, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let state = match conn.query("SELECT revision FROM system_storage_meta WHERE singleton = 1", &[]) {
                Ok(rows) => {
                    let mut r = 0i64;
                    if let Some(row) = rows.flatten().next() {
                        r = row.get(0).unwrap_or(0);
                    }
                    r
                }
                Err(_) => 0,
            };

            let mut settings = serde_json::Map::new();
            if let Ok(rows) = conn.query("SELECT setting_key, text_val FROM system_settings", &[]) {
                for row in rows.flatten() {
                    if let (Ok(k), Ok(v)) = (row.get::<usize, String>(0), row.get::<usize, String>(1)) {
                        let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
                        settings.insert(k, parsed);
                    }
                }
            }

            let mut characters = Vec::new();
            if let Ok(rows) = conn.query("SELECT id, name, image, position FROM char_characters ORDER BY position, id", &[]) {
                for row in rows.flatten() {
                    let id: String = row.get(0).unwrap_or_default();
                    let name: String = row.get(1).unwrap_or_default();
                    let image: String = row.get(2).unwrap_or_default();
                    characters.push(json!({
                        "chaId": id,
                        "name": name,
                        "image": image,
                        "detailsLoaded": false,
                        "chats": [],
                    }));
                }
            }

            Ok(json!({
                "status": "ready",
                "revision": state,
                "settings": settings,
                "characters": characters,
                "deferredSettingKeys": ["customModels", "plugins", "presets", "modules", "loreBook", "personas", "prompts", "scripts"]
            }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn load_setting_keys(&self, keys: &[String]) -> Result<Value, StorageError> {
        let storage = self.clone();
        let k_list = keys.to_vec();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut settings = serde_json::Map::new();
            for k in &k_list {
                if let Ok(rows) = conn.query(
                    "SELECT text_val FROM system_settings WHERE setting_key = :1",
                    &[k],
                ) {
                    if let Some(row) = rows.flatten().next() {
                        if let Ok(v) = row.get::<usize, String>(0) {
                            let parsed: Value =
                                serde_json::from_str(&v).unwrap_or(Value::String(v));
                            settings.insert(k.clone(), parsed);
                        }
                    }
                }
            }
            let hash =
                crate::codec::compute_hash(&serde_json::to_string(&settings).unwrap_or_default());
            Ok(json!({ "settings": settings, "hash": hash }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn load_character(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let storage = self.clone();
        let char_id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            if let Ok(rows) = conn.query(
                "SELECT data, name, image FROM char_characters WHERE id = :1",
                &[&char_id],
            ) {
                if let Some(row) = rows.flatten().next() {
                    if let Ok(data_str) = row.get::<usize, String>(0) {
                        if let Ok(mut parsed) = serde_json::from_str::<Value>(&data_str) {
                            if parsed.get("id").is_none() {
                                parsed["id"] = json!(char_id);
                            }
                            return Ok(Some(parsed));
                        }
                    }
                    let name: String = row.get(1).unwrap_or_default();
                    let image: String = row.get(2).unwrap_or_default();
                    return Ok(Some(json!({ "id": char_id, "name": name, "image": image })));
                }
            }
            Ok(None)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn load_character_asset_fields(&self, id: &str) -> Result<Value, StorageError> {
        let char_val = self.load_character(id).await?;
        if let Some(c) = char_val {
            let mut assets = serde_json::Map::new();
            if let Some(img) = c.get("image") {
                assets.insert("image".to_string(), img.clone());
            }
            if let Some(bg) = c.get("customBackground") {
                assets.insert("customBackground".to_string(), bg.clone());
            }
            if let Some(em) = c.get("emotionImages") {
                assets.insert("emotionImages".to_string(), em.clone());
            }
            if let Some(aa) = c.get("additionalAssets") {
                assets.insert("additionalAssets".to_string(), aa.clone());
            }
            return Ok(json!({ "assets": assets }));
        }
        Ok(json!({ "assets": {} }))
    }

    async fn load_chat(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let storage = self.clone();
        let chat_id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            if let Ok(rows) = conn.query("SELECT data, character_id, name FROM chat_chats WHERE id = :1", &[&chat_id]) {
                if let Some(row) = rows.flatten().next() {
                    if let Ok(data_str) = row.get::<usize, String>(0) {
                        if let Ok(mut parsed) = serde_json::from_str::<Value>(&data_str) {
                            if parsed.get("id").is_none() {
                                parsed["id"] = json!(chat_id);
                            }
                            return Ok(Some(parsed));
                        }
                    }
                    let char_id: String = row.get(1).unwrap_or_default();
                    let name: String = row.get(2).unwrap_or_default();
                    return Ok(Some(json!({ "id": chat_id, "characterId": char_id, "name": name, "message": [] })));
                }
            }
            Ok(None)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn load_chat_messages(
        &self,
        chat_id: &str,
        limit: Option<usize>,
        before: Option<usize>,
    ) -> Result<Value, StorageError> {
        let storage = self.clone();
        let cid = chat_id.to_string();
        let l = limit.unwrap_or(50) as i64;
        let o = before.unwrap_or(0) as i64;

        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = "SELECT data FROM chat_messages WHERE chat_id = :1 ORDER BY position ASC OFFSET :2 ROWS FETCH NEXT :3 ROWS ONLY";
            let mut messages = Vec::new();
            if let Ok(rows) = conn.query(sql, &[&cid, &o, &l]) {
                for row in rows.flatten() {
                    if let Ok(data_str) = row.get::<usize, String>(0) {
                        if let Ok(val) = serde_json::from_str::<Value>(&data_str) {
                            messages.push(val);
                        }
                    }
                }
            }
            Ok(json!(messages))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn export_snapshot(&self) -> Result<Value, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let state = match conn.query(
                "SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1",
                &[],
            ) {
                Ok(rows) => {
                    let mut r = (0i64, false);
                    if let Some(row) = rows.flatten().next() {
                        let rev: i64 = row.get(0).unwrap_or(0);
                        let init: i32 = row.get(1).unwrap_or(0);
                        r = (rev, init == 1);
                    }
                    r
                }
                Err(_) => (0, false),
            };

            // 1. Settings
            let mut settings_map = serde_json::Map::new();
            if let Ok(rows) = conn.query("SELECT setting_key, text_val FROM system_settings", &[]) {
                for row in rows.flatten() {
                    if let (Ok(k), Ok(v)) =
                        (row.get::<usize, String>(0), row.get::<usize, String>(1))
                    {
                        let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
                        settings_map.insert(k, parsed);
                    }
                }
            }

            // 2. Plugin custom storage
            let mut plugin_map = serde_json::Map::new();
            if let Ok(rows) = conn.query(
                "SELECT storage_key, text_val FROM system_plugin_custom_storage",
                &[],
            ) {
                for row in rows.flatten() {
                    if let (Ok(k), Ok(v)) =
                        (row.get::<usize, String>(0), row.get::<usize, String>(1))
                    {
                        let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
                        plugin_map.insert(k, parsed);
                    }
                }
            }
            settings_map.insert("pluginCustomStorage".to_string(), Value::Object(plugin_map));

            // 3. Characters
            let mut characters = Vec::new();
            if let Ok(rows) = conn.query(
                "SELECT data FROM char_characters ORDER BY position, id",
                &[],
            ) {
                for row in rows.flatten() {
                    if let Ok(d) = row.get::<usize, String>(0) {
                        if let Ok(v) = serde_json::from_str::<Value>(&d) {
                            characters.push(v);
                        }
                    }
                }
            }

            // 4. Chats
            let mut chats = Vec::new();
            if let Ok(rows) = conn.query("SELECT data FROM chat_chats ORDER BY position, id", &[]) {
                for row in rows.flatten() {
                    if let Ok(d) = row.get::<usize, String>(0) {
                        if let Ok(v) = serde_json::from_str::<Value>(&d) {
                            chats.push(v);
                        }
                    }
                }
            }

            // 5. Messages
            let mut messages = Vec::new();
            if let Ok(rows) =
                conn.query("SELECT data FROM chat_messages ORDER BY position, id", &[])
            {
                for row in rows.flatten() {
                    if let Ok(d) = row.get::<usize, String>(0) {
                        if let Ok(v) = serde_json::from_str::<Value>(&d) {
                            messages.push(v);
                        }
                    }
                }
            }

            Ok(json!({
                "revision": state.0,
                "initialized": state.1,
                "database": {
                    "settings": settings_map,
                    "characters": characters,
                    "chats": chats,
                    "messages": messages,
                }
            }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn import_snapshot(&self, snapshot: Value) -> Result<SyncResult, StorageError> {
        let db = snapshot.get("database").unwrap_or(&snapshot);
        let base_rev = snapshot
            .get("revision")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        let mut payload = SyncPayload {
            base_revision: Some(base_rev),
            replace_all: Some(true),
            ..Default::default()
        };

        if let Some(settings) = db.get("settings").and_then(|v| v.as_object()) {
            let mut upserts = Vec::new();
            for (k, v) in settings {
                if k == "pluginCustomStorage" {
                    if let Some(p_obj) = v.as_object() {
                        for (pk, pv) in p_obj {
                            let _ = self.cold_storage_put(pk, pv.clone()).await;
                        }
                    }
                } else {
                    upserts.push(crate::models::SettingUpsert {
                        key: k.clone(),
                        value: v.clone(),
                    });
                }
            }
            payload.root = Some(crate::models::RootSection {
                upserts,
                deletes: Vec::new(),
            });
        }

        if let Some(chars) = db.get("characters").and_then(|v| v.as_array()) {
            let mut upserts = Vec::new();
            for (i, c) in chars.iter().enumerate() {
                let id = c
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !id.is_empty() {
                    upserts.push(crate::models::EntityUpsert {
                        id,
                        position: Some(i),
                        character_id: None,
                        chat_id: None,
                        data: c.clone(),
                    });
                }
            }
            payload.characters = Some(crate::models::CharactersSection {
                upserts,
                deletes: Vec::new(),
                order: Vec::new(),
            });
        }

        if let Some(chats) = db.get("chats").and_then(|v| v.as_array()) {
            let mut upserts = Vec::new();
            for (i, ch) in chats.iter().enumerate() {
                let id = ch
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let char_id = ch
                    .get("characterId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if !id.is_empty() {
                    upserts.push(crate::models::EntityUpsert {
                        id,
                        position: Some(i),
                        character_id: char_id,
                        chat_id: None,
                        data: ch.clone(),
                    });
                }
            }
            payload.chats = Some(crate::models::ChatsSection {
                upserts,
                deletes: Vec::new(),
                order: Vec::new(),
            });
        }

        self.sync(payload).await
    }

    async fn list_presets(&self) -> Result<Value, StorageError> {
        let keys = vec!["presets".to_string()];
        let res = self.load_setting_keys(&keys).await?;
        let presets = res
            .get("settings")
            .and_then(|s| s.get("presets"))
            .cloned()
            .unwrap_or(json!([]));
        let hash = crate::codec::compute_hash(&presets.to_string());
        Ok(json!({ "presets": presets, "hash": hash, "queryMs": 1.0 }))
    }

    async fn load_preset(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let list_res = self.list_presets().await?;
        if let Some(arr) = list_res.get("presets").and_then(|v| v.as_array()) {
            for item in arr {
                if item.get("id").and_then(|v| v.as_str()) == Some(id) {
                    let hash = crate::codec::compute_hash(&item.to_string());
                    return Ok(Some(
                        json!({ "preset": item, "hash": hash, "queryMs": 1.0 }),
                    ));
                }
            }
        }
        Ok(None)
    }

    async fn list_plugins(&self) -> Result<Value, StorageError> {
        let keys = vec!["plugins".to_string()];
        let res = self.load_setting_keys(&keys).await?;
        let plugins = res
            .get("settings")
            .and_then(|s| s.get("plugins"))
            .cloned()
            .unwrap_or(json!([]));
        let hash = crate::codec::compute_hash(&plugins.to_string());
        Ok(json!({ "plugins": plugins, "hash": hash }))
    }

    async fn list_plugin_custom_storage_keys(&self) -> Result<Vec<String>, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut keys = Vec::new();
            if let Ok(rows) = conn.query(
                "SELECT storage_key FROM system_plugin_custom_storage ORDER BY storage_key",
                &[],
            ) {
                for row in rows.flatten() {
                    if let Ok(k) = row.get::<usize, String>(0) {
                        keys.push(k);
                    }
                }
            }
            Ok(keys)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn get_plugin_custom_storage_key(
        &self,
        key: &str,
    ) -> Result<Option<Value>, StorageError> {
        let storage = self.clone();
        let k = key.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            if let Ok(rows) = conn.query(
                "SELECT text_val FROM system_plugin_custom_storage WHERE storage_key = :1",
                &[&k],
            ) {
                if let Some(row) = rows.flatten().next() {
                    if let Ok(val_str) = row.get::<usize, String>(0) {
                        let parsed: Value =
                            serde_json::from_str(&val_str).unwrap_or(json!(val_str));
                        let hash = crate::codec::compute_hash(&val_str);
                        return Ok(Some(
                            json!({ "key": k, "value": parsed, "exists": true, "hash": hash }),
                        ));
                    }
                }
            }
            Ok(None)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn get_plugin_custom_storage(&self) -> Result<Value, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut map = serde_json::Map::new();
            if let Ok(rows) = conn.query("SELECT storage_key, text_val FROM system_plugin_custom_storage ORDER BY storage_key", &[]) {
                for row in rows.flatten() {
                    if let (Ok(k), Ok(val_str)) = (row.get::<usize, String>(0), row.get::<usize, String>(1)) {
                        let parsed: Value = serde_json::from_str(&val_str).unwrap_or(json!(val_str));
                        map.insert(k, parsed);
                    }
                }
            }
            let hash = crate::codec::compute_hash(&serde_json::to_string(&map).unwrap_or_default());
            Ok(json!({ "pluginCustomStorage": map, "hash": hash }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn cold_storage_list(&self) -> Result<Vec<String>, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut keys = Vec::new();
            if let Ok(rows) = conn.query(
                "SELECT storage_key FROM system_cold_storage ORDER BY storage_key",
                &[],
            ) {
                for row in rows.flatten() {
                    if let Ok(k) = row.get::<usize, String>(0) {
                        keys.push(k);
                    }
                }
            }
            Ok(keys)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn cold_storage_get(&self, key: &str) -> Result<Option<Value>, StorageError> {
        let storage = self.clone();
        let k = key.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            if let Ok(rows) = conn.query(
                "SELECT data FROM system_cold_storage WHERE storage_key = :1",
                &[&k],
            ) {
                if let Some(row) = rows.flatten().next() {
                    if let Ok(data_str) = row.get::<usize, String>(0) {
                        let val: Value = serde_json::from_str(&data_str).unwrap_or(json!(data_str));
                        return Ok(Some(val));
                    }
                }
            }
            Ok(None)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn cold_storage_put(&self, key: &str, value: Value) -> Result<(), StorageError> {
        let storage = self.clone();
        let k = key.to_string();
        let val_str = value.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = "MERGE INTO system_cold_storage target \
                       USING (SELECT :1 AS storage_key, :2 AS data FROM DUAL) source \
                       ON (target.storage_key = source.storage_key) \
                       WHEN MATCHED THEN UPDATE SET target.data = source.data, target.updated_at = SYSTIMESTAMP \
                       WHEN NOT MATCHED THEN INSERT (storage_key, data) VALUES (source.storage_key, source.data)";
            conn.execute(sql, &[&k, &val_str]).map_err(|e| StorageError::Database(e.to_string()))?;
            conn.commit().map_err(|e| StorageError::Database(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn cold_storage_delete(&self, keys: &[String]) -> Result<usize, StorageError> {
        let storage = self.clone();
        let k_list = keys.to_vec();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut count = 0;
            for key in &k_list {
                if conn
                    .execute(
                        "DELETE FROM system_cold_storage WHERE storage_key = :1",
                        &[key],
                    )
                    .is_ok()
                {
                    count += 1;
                }
            }
            let _ = conn.commit();
            Ok(count)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn cold_storage_prune(&self, max_keys: usize) -> Result<usize, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut keys = Vec::new();
            if let Ok(rows) = conn.query(
                "SELECT storage_key FROM system_cold_storage ORDER BY updated_at ASC",
                &[],
            ) {
                for row in rows.flatten() {
                    if let Ok(k) = row.get::<usize, String>(0) {
                        keys.push(k);
                    }
                }
            }
            if keys.len() <= max_keys {
                return Ok(0);
            }
            let to_remove = keys.len() - max_keys;
            let mut removed = 0;
            for key in keys.into_iter().take(to_remove) {
                if conn
                    .execute(
                        "DELETE FROM system_cold_storage WHERE storage_key = :1",
                        &[&key],
                    )
                    .is_ok()
                {
                    removed += 1;
                }
            }
            let _ = conn.commit();
            Ok(removed)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn search(&self, query: &str) -> Result<Value, StorageError> {
        let storage = self.clone();
        let q = format!("%{}%", query);
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut characters = Vec::new();
            if let Ok(rows) = conn.query(
                "SELECT id, name FROM char_characters WHERE name LIKE :1",
                &[&q],
            ) {
                for row in rows.flatten() {
                    let id: String = row.get(0).unwrap_or_default();
                    let name: String = row.get(1).unwrap_or_default();
                    characters.push(json!({ "id": id, "name": name }));
                }
            }
            Ok(json!({
                "characters": characters,
                "chats": [],
                "messages": []
            }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn search_characters(&self, query: &str) -> Result<Value, StorageError> {
        let res = self.search(query).await?;
        Ok(res.get("characters").cloned().unwrap_or(json!([])))
    }

    async fn get_bot_stats(&self) -> Result<Value, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut c_count = 0i64;
            if let Ok(rows) = conn.query("SELECT COUNT(*) FROM char_characters", &[]) {
                if let Some(row) = rows.flatten().next() {
                    c_count = row.get(0).unwrap_or(0);
                }
            }
            let mut ch_count = 0i64;
            if let Ok(rows) = conn.query("SELECT COUNT(*) FROM chat_chats", &[]) {
                if let Some(row) = rows.flatten().next() {
                    ch_count = row.get(0).unwrap_or(0);
                }
            }
            Ok(json!({
                "totalBots": c_count,
                "totalChats": ch_count
            }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn get_token_usage(&self) -> Result<Value, StorageError> {
        Ok(json!({
            "totalTokens": 0
        }))
    }

    async fn list_revisions(&self) -> Result<Value, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = "SELECT storage_revision, action, TO_CHAR(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM system_revisions ORDER BY storage_revision DESC";
            let mut list = Vec::new();
            if let Ok(rows) = conn.query(sql, &[]) {
                for row in rows.flatten() {
                    let r: i64 = row.get(0).unwrap_or(0);
                    let action: String = row.get(1).unwrap_or_default();
                    let created_at: String = row.get(2).unwrap_or_default();
                    list.push(json!({
                        "revision": r,
                        "action": action,
                        "createdAt": created_at,
                    }));
                }
            }
            Ok(json!(list))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn get_revision_diff(&self) -> Result<Value, StorageError> {
        Ok(json!({ "changes": [] }))
    }

    async fn get_revision_details(&self, id: i64) -> Result<Value, StorageError> {
        Ok(json!({
            "revision": id,
            "comment": "Revision",
            "createdAt": chrono::Utc::now().to_rfc3339()
        }))
    }

    async fn preview_restore(&self, revision_id: i64) -> Result<Value, StorageError> {
        Ok(json!({
            "revisionId": revision_id,
            "preview": "ready"
        }))
    }

    async fn restore_revision(&self, revision_id: i64) -> Result<Value, StorageError> {
        Ok(json!({
            "success": true,
            "restoredRevision": revision_id
        }))
    }

    async fn list_tables(&self) -> Result<Vec<TableInfo>, StorageError> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let mut tables = Vec::new();
            if let Ok(rows) = conn.query(
                "SELECT table_name FROM user_tables ORDER BY table_name",
                &[],
            ) {
                for row in rows.flatten() {
                    if let Ok(t) = row.get::<usize, String>(0) {
                        tables.push(TableInfo {
                            name: t,
                            row_count: 0,
                        });
                    }
                }
            }
            Ok(tables)
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn get_table_rows(
        &self,
        table: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Value, StorageError> {
        let storage = self.clone();
        let t = table.to_string();
        let l = limit as i64;
        let o = offset as i64;

        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = format!("SELECT * FROM {} OFFSET :1 ROWS FETCH NEXT :2 ROWS ONLY", t);
            let mut result_rows = Vec::new();
            if let Ok(rows) = conn.query(&sql, &[&o, &l]) {
                for _ in rows {
                    result_rows.push(json!({}));
                }
            }
            Ok(json!({
                "table": t,
                "rows": result_rows,
                "total": result_rows.len()
            }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn update_setting(&self, key: &str, value: Value) -> Result<Value, StorageError> {
        let storage = self.clone();
        let k = key.to_string();
        let val_str = value.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = "MERGE INTO system_settings target \
                       USING (SELECT :1 AS setting_key, :2 AS text_val FROM DUAL) source \
                       ON (target.setting_key = source.setting_key) \
                       WHEN MATCHED THEN UPDATE SET target.text_val = source.text_val \
                       WHEN NOT MATCHED THEN INSERT (setting_key, text_val) VALUES (source.setting_key, source.text_val)";
            conn.execute(sql, &[&k, &val_str]).map_err(|e| StorageError::Database(e.to_string()))?;
            conn.commit().map_err(|e| StorageError::Database(e.to_string()))?;
            Ok(json!({ "success": true, "key": k, "value": value }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn delete_setting(&self, key: &str) -> Result<Value, StorageError> {
        let storage = self.clone();
        let k = key.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let _ = conn.execute("DELETE FROM system_settings WHERE setting_key = :1", &[&k]);
            let _ = conn.commit();
            Ok(json!({ "success": true, "key": k }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn save_preset(
        &self,
        preset: Value,
        _position: Option<usize>,
    ) -> Result<Value, StorageError> {
        let id = preset
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let list_res = self.list_presets().await?;
        let mut presets: Vec<Value> = list_res
            .get("presets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(pos) = presets
            .iter()
            .position(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
        {
            presets[pos] = preset.clone();
        } else {
            presets.push(preset.clone());
        }
        self.update_setting("presets", json!(presets)).await?;
        Ok(json!({ "success": true, "id": id }))
    }

    async fn save_module(&self, module: Value) -> Result<Value, StorageError> {
        let id = module
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let keys = vec!["modules".to_string()];
        let res = self.load_setting_keys(&keys).await?;
        let mut modules: Vec<Value> = res
            .get("settings")
            .and_then(|s| s.get("modules"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(pos) = modules
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(id))
        {
            modules[pos] = module.clone();
        } else {
            modules.push(module.clone());
        }
        self.update_setting("modules", json!(modules)).await?;
        Ok(json!({ "success": true, "id": id }))
    }

    async fn delete_module(&self, id: &str) -> Result<Value, StorageError> {
        let keys = vec!["modules".to_string()];
        let res = self.load_setting_keys(&keys).await?;
        let mut modules: Vec<Value> = res
            .get("settings")
            .and_then(|s| s.get("modules"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        modules.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(id));
        self.update_setting("modules", json!(modules)).await?;
        Ok(json!({ "success": true, "id": id }))
    }

    async fn save_message(&self, chat_id: &str, message: Value) -> Result<Value, StorageError> {
        let msg_id = message
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("msg")
            .to_string();
        let storage = self.clone();
        let cid = chat_id.to_string();
        let data_str = message.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let sql = "MERGE INTO chat_messages target \
                       USING (SELECT :1 AS id, :2 AS chat_id, :3 AS data FROM DUAL) source \
                       ON (target.id = source.id) \
                       WHEN MATCHED THEN UPDATE SET target.data = source.data \
                       WHEN NOT MATCHED THEN INSERT (id, chat_id, data) VALUES (source.id, source.chat_id, source.data)";
            conn.execute(sql, &[&msg_id, &cid, &data_str]).map_err(|e| StorageError::Database(e.to_string()))?;
            conn.commit().map_err(|e| StorageError::Database(e.to_string()))?;
            Ok(json!({ "success": true, "chatId": cid, "messageId": msg_id }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }

    async fn delete_message(&self, chat_id: &str, message_id: &str) -> Result<Value, StorageError> {
        let storage = self.clone();
        let cid = chat_id.to_string();
        let mid = message_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = storage.get_sync_connection()?;
            let _ = conn.execute(
                "DELETE FROM chat_messages WHERE chat_id = :1 AND id = :2",
                &[&cid, &mid],
            );
            let _ = conn.commit();
            Ok(json!({ "success": true, "chatId": cid, "messageId": mid }))
        })
        .await
        .map_err(|e| StorageError::Database(e.to_string()))?
    }
}
