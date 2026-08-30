use async_trait::async_trait;
use serde_json::{json, Value};

use std::sync::Arc;
use tiberius::{AuthMethod, Client, Config};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::models::{DatabaseState, StorageError, SyncPayload, SyncResult, TableInfo};
use crate::traits::ServerStorage;

pub const AZURE_SCHEMA_SQL: &str = include_str!("../../schemas/azure-schema.sql");

#[derive(Clone)]
pub struct AzureSqlStorage {
    client: Arc<Mutex<Option<Client<Compat<TcpStream>>>>>,
    connection_string: String,
    enabled: bool,
}

impl AzureSqlStorage {
    pub fn new(connection_string: &str, enabled: bool) -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            connection_string: connection_string.to_string(),
            enabled,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.enabled && !self.connection_string.is_empty()
    }

    pub async fn create_connection(&self) -> Result<Client<Compat<TcpStream>>, StorageError> {
        let parsed = url::Url::parse(&self.connection_string).map_err(|e| {
            StorageError::InvalidPayload(format!("Invalid Azure SQL connection string: {}", e))
        })?;

        let host = parsed.host_str().unwrap_or("localhost");
        let port = parsed.port().unwrap_or(1433);
        let database = parsed.path().trim_start_matches('/');
        let user = parsed.username();
        let password = parsed.password().unwrap_or("");

        let mut tiberius_config = Config::new();
        tiberius_config.host(host);
        tiberius_config.port(port);
        tiberius_config.database(database);
        tiberius_config.authentication(AuthMethod::sql_server(user, password));
        tiberius_config.trust_cert();

        let tcp = TcpStream::connect(tiberius_config.get_addr())
            .await
            .map_err(|e| StorageError::Unavailable(format!("TCP connect error: {}", e)))?;
        tcp.set_nodelay(true)
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let client = Client::connect(tiberius_config, tcp.compat_write())
            .await
            .map_err(|e| StorageError::Unavailable(format!("TDS handshake error: {}", e)))?;

        Ok(client)
    }

    pub async fn connect(&self) -> Result<(), StorageError> {
        if !self.enabled || self.connection_string.is_empty() {
            return Ok(());
        }
        let client = self.create_connection().await?;
        let mut guard = self.client.lock().await;
        *guard = Some(client);
        Ok(())
    }
}

#[async_trait]
impl ServerStorage for AzureSqlStorage {
    fn vendor_name(&self) -> &'static str {
        "azuresql"
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }

    async fn initialize(&self) -> Result<(), StorageError> {
        let mut client = self.create_connection().await?;
        for statement in AZURE_SCHEMA_SQL.split(";\n") {
            let stmt = statement.trim();
            if !stmt.is_empty() {
                let _ = client.simple_query(stmt).await;
            }
        }
        Ok(())
    }

    async fn get_state(&self) -> Result<DatabaseState, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT revision, initialized, schema_version, schema_layout, CONVERT(VARCHAR, updated_at, 127) as updated_at \
                 FROM system.storage_meta WHERE singleton = 1",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?
        {
            let revision: i64 = row.get(0).unwrap_or(0);
            let initialized: bool = row.get(1).unwrap_or(true);
            let schema_version: i32 = row.get(2).unwrap_or(4);
            let schema_layout: &str = row.get(3).unwrap_or("relational-schema-v3");
            let updated_at: Option<&str> = row.get(4);

            Ok(DatabaseState {
                revision,
                initialized,
                schema_version,
                schema_layout: schema_layout.to_string(),
                updated_at: updated_at.map(|s| s.to_string()),
            })
        } else {
            Ok(DatabaseState {
                revision: 0,
                initialized: false,
                schema_version: 4,
                schema_layout: "relational-schema-v3".to_string(),
                updated_at: None,
            })
        }
    }

    async fn sync(&self, payload: SyncPayload) -> Result<SyncResult, StorageError> {
        let mut client = self.create_connection().await?;

        let state = self.get_state().await?;
        if let Some(expected) = payload.base_revision {
            if expected != state.revision && expected != 0 {
                return Err(StorageError::RevisionConflict {
                    revision: state.revision,
                });
            }
        }

        let next_revision = state.revision + 1;

        // 1. Revisions
        let action = "sync";
        let _ = client.execute(
            "INSERT INTO system.revisions (storage_revision, database_initialized, scope, action) VALUES (@P1, 1, 'database', @P2)",
            &[&next_revision, &action],
        ).await;

        // 2. Replace all if requested
        if payload.replace_all.unwrap_or(false) {
            let _ = client.simple_query("DELETE FROM character.characters; DELETE FROM chat.chats; DELETE FROM chat.messages;").await;
        }

        // 3. Settings root upserts & deletes
        if let Some(root) = &payload.root {
            for up in &root.upserts {
                let key = &up.key;
                let val_str = up.value.to_string();
                let _ = client.execute(
                    "MERGE system.settings AS target \
                     USING (SELECT @P1 AS [key], @P2 AS text_val) AS source \
                     ON target.[key] = source.[key] \
                     WHEN MATCHED THEN UPDATE SET text_val = source.text_val \
                     WHEN NOT MATCHED THEN INSERT ([key], text_val) VALUES (source.[key], source.text_val);",
                    &[key, &val_str],
                ).await;
            }
            for del_key in &root.deletes {
                let _ = client
                    .execute("DELETE FROM system.settings WHERE [key] = @P1", &[del_key])
                    .await;
            }
        }

        // 4. Characters
        if let Some(chars) = &payload.characters {
            for up in &chars.upserts {
                let id = &up.id;
                let pos = up.position.unwrap_or(0) as i32;
                let name = up.data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let image = up.data.get("image").and_then(|v| v.as_str()).unwrap_or("");
                let data_str = up.data.to_string();
                let _ = client.execute(
                    "MERGE character.characters AS target \
                     USING (SELECT @P1 AS id, @P2 AS position, @P3 AS name, @P4 AS image, @P5 AS data) AS source \
                     ON target.id = source.id \
                     WHEN MATCHED THEN UPDATE SET position = source.position, name = source.name, image = source.image, data = source.data \
                     WHEN NOT MATCHED THEN INSERT (id, position, name, image, data) VALUES (source.id, source.position, source.name, source.image, source.data);",
                    &[id, &pos, &name, &image, &data_str],
                ).await;
            }
            for char_id in &chars.deletes {
                let _ = client
                    .execute(
                        "DELETE FROM character.characters WHERE id = @P1",
                        &[char_id],
                    )
                    .await;
            }
        }

        // 5. Chats
        if let Some(chats) = &payload.chats {
            for up in &chats.upserts {
                let id = &up.id;
                let char_id = up.character_id.as_deref().unwrap_or("");
                let pos = up.position.unwrap_or(0) as i32;
                let name = up.data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let data_str = up.data.to_string();
                let _ = client.execute(
                    "MERGE chat.chats AS target \
                     USING (SELECT @P1 AS id, @P2 AS character_id, @P3 AS position, @P4 AS name, @P5 AS data) AS source \
                     ON target.id = source.id \
                     WHEN MATCHED THEN UPDATE SET character_id = source.character_id, position = source.position, name = source.name, data = source.data \
                     WHEN NOT MATCHED THEN INSERT (id, character_id, position, name, data) VALUES (source.id, source.character_id, source.position, source.name, source.data);",
                    &[id, &char_id, &pos, &name, &data_str],
                ).await;
            }
            for chat_id in &chats.deletes {
                let _ = client
                    .execute("DELETE FROM chat.chats WHERE id = @P1", &[chat_id])
                    .await;
            }
        }

        // 6. Messages
        if let Some(msgs) = &payload.messages {
            for up in &msgs.upserts {
                let id = &up.id;
                let chat_id = up.chat_id.as_deref().unwrap_or("");
                let pos = up.position.unwrap_or(0) as i32;
                let data_str = up.data.to_string();
                let _ = client.execute(
                    "MERGE chat.messages AS target \
                     USING (SELECT @P1 AS id, @P2 AS chat_id, @P3 AS position, @P4 AS data) AS source \
                     ON target.id = source.id \
                     WHEN MATCHED THEN UPDATE SET chat_id = source.chat_id, position = source.position, data = source.data \
                     WHEN NOT MATCHED THEN INSERT (id, chat_id, position, data) VALUES (source.id, source.chat_id, source.position, source.data);",
                    &[id, &chat_id, &pos, &data_str],
                ).await;
            }
            for msg_id in &msgs.deletes {
                let _ = client
                    .execute("DELETE FROM chat.messages WHERE id = @P1", &[msg_id])
                    .await;
            }
        }

        // 7. Update storage_meta
        let _ = client.execute(
            "UPDATE system.storage_meta SET revision = @P1, initialized = 1, updated_at = SYSDATETIMEOFFSET() WHERE singleton = 1",
            &[&next_revision],
        ).await;

        Ok(SyncResult {
            success: true,
            revision: next_revision,
        })
    }

    async fn load_startup_data(&self) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let state = self.get_state().await?;

        // Read settings
        let stream = client
            .query("SELECT [key], [text_val] FROM system.settings", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut settings = serde_json::Map::new();
        for row in rows {
            if let Some(k) = row.get::<&str, _>(0) {
                let val_str = row.get::<&str, _>(1).unwrap_or("");
                let parsed: Value =
                    serde_json::from_str(val_str).unwrap_or(Value::String(val_str.to_string()));
                settings.insert(k.to_string(), parsed);
            }
        }

        // Read characters summary
        let char_stream = client
            .query(
                "SELECT id, name, image, position FROM character.characters ORDER BY position, id",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let char_rows = char_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut characters = Vec::new();
        for row in char_rows {
            let id: &str = row.get(0).unwrap_or("");
            let name: &str = row.get(1).unwrap_or("");
            let image: &str = row.get(2).unwrap_or("");
            characters.push(json!({
                "chaId": id,
                "name": name,
                "image": image,
                "detailsLoaded": false,
                "chats": [],
            }));
        }

        Ok(json!({
            "status": "ready",
            "revision": state.revision,
            "settings": settings,
            "characters": characters,
            "deferredSettingKeys": ["customModels", "plugins", "presets", "modules", "loreBook", "personas", "prompts", "scripts"]
        }))
    }

    async fn load_setting_keys(&self, keys: &[String]) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let mut settings = serde_json::Map::new();

        for key in keys {
            let stream = client
                .query(
                    "SELECT text_val FROM system.settings WHERE [key] = @P1",
                    &[key],
                )
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?;

            if let Some(row) = stream
                .into_row()
                .await
                .map_err(|e| StorageError::Database(e.to_string()))?
            {
                let val_str = row.get::<&str, _>(0).unwrap_or("");
                let parsed: Value =
                    serde_json::from_str(val_str).unwrap_or(Value::String(val_str.to_string()));
                settings.insert(key.clone(), parsed);
            }
        }

        let hash =
            crate::codec::compute_hash(&serde_json::to_string(&settings).unwrap_or_default());
        Ok(json!({ "settings": settings, "hash": hash }))
    }

    async fn load_character(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT data, name, image FROM character.characters WHERE id = @P1",
                &[&id],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?
        {
            if let Some(data_str) = row.get::<&str, _>(0) {
                if let Ok(mut parsed) = serde_json::from_str::<Value>(data_str) {
                    if parsed.get("id").is_none() {
                        parsed["id"] = json!(id);
                    }
                    return Ok(Some(parsed));
                }
            }
            let name: &str = row.get(1).unwrap_or("");
            let image: &str = row.get(2).unwrap_or("");
            return Ok(Some(json!({ "id": id, "name": name, "image": image })));
        }
        Ok(None)
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
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT data, character_id, name FROM chat.chats WHERE id = @P1",
                &[&id],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?
        {
            if let Some(data_str) = row.get::<&str, _>(0) {
                if let Ok(mut parsed) = serde_json::from_str::<Value>(data_str) {
                    if parsed.get("id").is_none() {
                        parsed["id"] = json!(id);
                    }
                    return Ok(Some(parsed));
                }
            }
            let char_id: &str = row.get(1).unwrap_or("");
            let name: &str = row.get(2).unwrap_or("");
            return Ok(Some(
                json!({ "id": id, "characterId": char_id, "name": name, "message": [] }),
            ));
        }
        Ok(None)
    }

    async fn load_chat_messages(
        &self,
        chat_id: &str,
        limit: Option<usize>,
        before: Option<usize>,
    ) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let l = limit.unwrap_or(50) as i32;
        let o = before.unwrap_or(0) as i32;

        let stream = client
            .query(
                "SELECT data FROM chat.messages WHERE chat_id = @P1 ORDER BY position ASC OFFSET @P2 ROWS FETCH NEXT @P3 ROWS ONLY",
                &[&chat_id, &o, &l],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut messages = Vec::new();
        for row in rows {
            if let Some(data_str) = row.get::<&str, _>(0) {
                if let Ok(val) = serde_json::from_str::<Value>(data_str) {
                    messages.push(val);
                }
            }
        }
        Ok(json!(messages))
    }

    async fn export_snapshot(&self) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let state = self.get_state().await?;

        // 1. Settings
        let s_stream = client
            .query("SELECT [key], [text_val] FROM system.settings", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let s_rows = s_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut settings_map = serde_json::Map::new();
        for r in s_rows {
            if let Some(k) = r.get::<&str, _>(0) {
                let v_str = r.get::<&str, _>(1).unwrap_or("");
                let parsed: Value =
                    serde_json::from_str(v_str).unwrap_or(Value::String(v_str.to_string()));
                settings_map.insert(k.to_string(), parsed);
            }
        }

        // 2. Plugin custom storage
        let p_stream = client
            .query(
                "SELECT [key], [value] FROM system.plugin_custom_storage",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let p_rows = p_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut plugin_map = serde_json::Map::new();
        for r in p_rows {
            if let Some(k) = r.get::<&str, _>(0) {
                let v_str = r.get::<&str, _>(1).unwrap_or("");
                let parsed: Value =
                    serde_json::from_str(v_str).unwrap_or(Value::String(v_str.to_string()));
                plugin_map.insert(k.to_string(), parsed);
            }
        }
        settings_map.insert("pluginCustomStorage".to_string(), Value::Object(plugin_map));

        // 3. Characters
        let c_stream = client
            .query(
                "SELECT data FROM character.characters ORDER BY position, id",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let c_rows = c_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut characters = Vec::new();
        for r in c_rows {
            if let Some(d) = r.get::<&str, _>(0) {
                if let Ok(v) = serde_json::from_str::<Value>(d) {
                    characters.push(v);
                }
            }
        }

        // 4. Chats
        let ch_stream = client
            .query("SELECT data FROM chat.chats ORDER BY position, id", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let ch_rows = ch_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut chats = Vec::new();
        for r in ch_rows {
            if let Some(d) = r.get::<&str, _>(0) {
                if let Ok(v) = serde_json::from_str::<Value>(d) {
                    chats.push(v);
                }
            }
        }

        // 5. Messages
        let m_stream = client
            .query("SELECT data FROM chat.messages ORDER BY position, id", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let m_rows = m_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut messages = Vec::new();
        for r in m_rows {
            if let Some(d) = r.get::<&str, _>(0) {
                if let Ok(v) = serde_json::from_str::<Value>(d) {
                    messages.push(v);
                }
            }
        }

        Ok(json!({
            "revision": state.revision,
            "initialized": state.initialized,
            "database": {
                "settings": settings_map,
                "characters": characters,
                "chats": chats,
                "messages": messages,
            }
        }))
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
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT [key] FROM system.plugin_custom_storage ORDER BY [key]",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut keys = Vec::new();
        for row in rows {
            if let Some(k) = row.get::<&str, _>(0) {
                keys.push(k.to_string());
            }
        }
        Ok(keys)
    }

    async fn get_plugin_custom_storage_key(
        &self,
        key: &str,
    ) -> Result<Option<Value>, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT [value] FROM system.plugin_custom_storage WHERE [key] = @P1",
                &[&key],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?
        {
            if let Some(val_str) = row.get::<&str, _>(0) {
                let parsed: Value = serde_json::from_str(val_str).unwrap_or(json!(val_str));
                let hash = crate::codec::compute_hash(val_str);
                return Ok(Some(
                    json!({ "key": key, "value": parsed, "exists": true, "hash": hash }),
                ));
            }
        }
        Ok(None)
    }

    async fn get_plugin_custom_storage(&self) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT [key], [value] FROM system.plugin_custom_storage ORDER BY [key]",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut map = serde_json::Map::new();
        for row in rows {
            if let Some(k) = row.get::<&str, _>(0) {
                let val_str = row.get::<&str, _>(1).unwrap_or("");
                let parsed: Value = serde_json::from_str(val_str).unwrap_or(json!(val_str));
                map.insert(k.to_string(), parsed);
            }
        }
        let hash = crate::codec::compute_hash(&serde_json::to_string(&map).unwrap_or_default());
        Ok(json!({ "pluginCustomStorage": map, "hash": hash }))
    }

    async fn cold_storage_list(&self) -> Result<Vec<String>, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT storage_key FROM system.cold_storage ORDER BY storage_key",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut keys = Vec::new();
        for row in rows {
            if let Some(k) = row.get::<&str, _>(0) {
                keys.push(k.to_string());
            }
        }
        Ok(keys)
    }

    async fn cold_storage_get(&self, key: &str) -> Result<Option<Value>, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT data FROM system.cold_storage WHERE storage_key = @P1",
                &[&key],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?
        {
            if let Some(data_str) = row.get::<&str, _>(0) {
                let val: Value = serde_json::from_str(data_str).unwrap_or(json!(data_str));
                return Ok(Some(val));
            }
        }
        Ok(None)
    }

    async fn cold_storage_put(&self, key: &str, value: Value) -> Result<(), StorageError> {
        let mut client = self.create_connection().await?;
        let data_str = value.to_string();

        let _ = client
            .execute(
                "MERGE system.cold_storage AS target \
                 USING (SELECT @P1 AS storage_key, @P2 AS data) AS source \
                 ON target.storage_key = source.storage_key \
                 WHEN MATCHED THEN UPDATE SET data = source.data, updated_at = SYSDATETIMEOFFSET() \
                 WHEN NOT MATCHED THEN INSERT (storage_key, data) VALUES (source.storage_key, source.data);",
                &[&key, &data_str],
            )
            .await;

        Ok(())
    }

    async fn cold_storage_delete(&self, keys: &[String]) -> Result<usize, StorageError> {
        let mut client = self.create_connection().await?;
        let mut count = 0;
        for key in keys {
            if client
                .execute(
                    "DELETE FROM system.cold_storage WHERE storage_key = @P1",
                    &[key],
                )
                .await
                .is_ok()
            {
                count += 1;
            }
        }
        Ok(count)
    }

    async fn cold_storage_prune(&self, max_keys: usize) -> Result<usize, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query(
                "SELECT storage_key FROM system.cold_storage ORDER BY updated_at ASC",
                &[],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        if rows.len() <= max_keys {
            return Ok(0);
        }

        let to_remove = rows.len() - max_keys;
        let mut removed = 0;
        for row in rows.into_iter().take(to_remove) {
            if let Some(key) = row.get::<&str, _>(0) {
                if client
                    .execute(
                        "DELETE FROM system.cold_storage WHERE storage_key = @P1",
                        &[&key],
                    )
                    .await
                    .is_ok()
                {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    async fn search(&self, query: &str) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let pattern = format!("%{}%", query);

        let c_stream = client
            .query(
                "SELECT id, name FROM character.characters WHERE name LIKE @P1",
                &[&pattern],
            )
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let c_rows = c_stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut characters = Vec::new();
        for r in c_rows {
            let id: &str = r.get(0).unwrap_or("");
            let name: &str = r.get(1).unwrap_or("");
            characters.push(json!({ "id": id, "name": name }));
        }

        Ok(json!({
            "characters": characters,
            "chats": [],
            "messages": []
        }))
    }

    async fn search_characters(&self, query: &str) -> Result<Value, StorageError> {
        let res = self.search(query).await?;
        Ok(res.get("characters").cloned().unwrap_or(json!([])))
    }

    async fn get_bot_stats(&self) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let c_stream = client
            .query("SELECT COUNT(*) FROM character.characters", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let c_count: i32 = c_stream
            .into_row()
            .await
            .ok()
            .flatten()
            .and_then(|r| r.get(0))
            .unwrap_or(0);

        let ch_stream = client
            .query("SELECT COUNT(*) FROM chat.chats", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let ch_count: i32 = ch_stream
            .into_row()
            .await
            .ok()
            .flatten()
            .and_then(|r| r.get(0))
            .unwrap_or(0);

        Ok(json!({
            "totalBots": c_count,
            "totalChats": ch_count
        }))
    }

    async fn get_token_usage(&self) -> Result<Value, StorageError> {
        Ok(json!({
            "totalTokens": 0
        }))
    }

    async fn list_revisions(&self) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let stream = client
            .query("SELECT storage_revision, action, CONVERT(VARCHAR, created_at, 127) FROM system.revisions ORDER BY storage_revision DESC", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut list = Vec::new();
        for row in rows {
            let rev: i64 = row.get(0).unwrap_or(0);
            let action: &str = row.get(1).unwrap_or("");
            let created_at: &str = row.get(2).unwrap_or("");
            list.push(json!({
                "revision": rev,
                "action": action,
                "createdAt": created_at,
            }));
        }
        Ok(json!(list))
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
        let mut client = self.create_connection().await?;
        let stream = client
            .query("SELECT TABLE_SCHEMA + '.' + TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'", &[])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut tables = Vec::new();
        for row in rows {
            if let Some(t) = row.get::<&str, _>(0) {
                tables.push(TableInfo {
                    name: t.to_string(),
                    row_count: 0,
                });
            }
        }
        Ok(tables)
    }

    async fn get_table_rows(
        &self,
        table: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let l = limit as i32;
        let o = offset as i32;
        let sql = format!(
            "SELECT * FROM {} ORDER BY 1 OFFSET @P1 ROWS FETCH NEXT @P2 ROWS ONLY",
            table
        );

        let stream = client
            .query(&sql, &[&o, &l])
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let mut result_rows = Vec::new();
        for _ in rows {
            result_rows.push(json!({}));
        }

        Ok(json!({
            "table": table,
            "rows": result_rows,
            "total": result_rows.len()
        }))
    }

    async fn update_setting(&self, key: &str, value: Value) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let val_str = value.to_string();
        let _ = client
            .execute(
                "MERGE system.settings AS target \
                 USING (SELECT @P1 AS [key], @P2 AS text_val) AS source \
                 ON target.[key] = source.[key] \
                 WHEN MATCHED THEN UPDATE SET text_val = source.text_val \
                 WHEN NOT MATCHED THEN INSERT ([key], text_val) VALUES (source.[key], source.text_val);",
                &[&key, &val_str],
            )
            .await;

        Ok(json!({ "success": true, "key": key, "value": value }))
    }

    async fn delete_setting(&self, key: &str) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let _ = client
            .execute("DELETE FROM system.settings WHERE [key] = @P1", &[&key])
            .await;
        Ok(json!({ "success": true, "key": key }))
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
        let msg_id = message.get("id").and_then(|v| v.as_str()).unwrap_or("msg");
        let mut client = self.create_connection().await?;
        let data_str = message.to_string();
        let _ = client
            .execute(
                "MERGE chat.messages AS target \
                 USING (SELECT @P1 AS id, @P2 AS chat_id, @P3 AS data) AS source \
                 ON target.id = source.id \
                 WHEN MATCHED THEN UPDATE SET data = source.data \
                 WHEN NOT MATCHED THEN INSERT (id, chat_id, data) VALUES (source.id, source.chat_id, source.data);",
                &[&msg_id, &chat_id, &data_str],
            )
            .await;

        Ok(json!({ "success": true, "chatId": chat_id, "messageId": msg_id }))
    }

    async fn delete_message(&self, chat_id: &str, message_id: &str) -> Result<Value, StorageError> {
        let mut client = self.create_connection().await?;
        let _ = client
            .execute(
                "DELETE FROM chat.messages WHERE chat_id = @P1 AND id = @P2",
                &[&chat_id, &message_id],
            )
            .await;
        Ok(json!({ "success": true, "chatId": chat_id, "messageId": message_id }))
    }
}
