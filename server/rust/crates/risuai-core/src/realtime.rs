use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

pub fn normalize_client_id(value: Option<&str>) -> Option<String> {
    let s = value?.trim();
    if !s.is_empty() && s.len() <= 128 {
        Some(s.to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlCommitChangeDescription {
    #[serde(rename = "chatIds")]
    pub chat_ids: Vec<String>,
    #[serde(rename = "characterIds")]
    pub character_ids: Vec<String>,
    #[serde(rename = "rootUpsertKeys")]
    pub root_upsert_keys: Vec<String>,
    #[serde(rename = "rootDeleteKeys")]
    pub root_delete_keys: Vec<String>,
    #[serde(rename = "rootChanged")]
    pub root_changed: bool,
    #[serde(rename = "pluginStorageUpsertKeys")]
    pub plugin_storage_upsert_keys: Vec<String>,
    #[serde(rename = "pluginStorageDeleteKeys")]
    pub plugin_storage_delete_keys: Vec<String>,
    #[serde(rename = "pluginStorageCleared")]
    pub plugin_storage_cleared: bool,
}

pub fn describe_sql_commit_change(payload: &serde_json::Value) -> SqlCommitChangeDescription {
    let mut chat_ids = HashSet::new();
    let mut character_ids = HashSet::new();

    let add_chat = |set: &mut HashSet<String>, val: Option<&str>| {
        if let Some(s) = val {
            if !s.is_empty() {
                set.insert(s.to_string());
            }
        }
    };
    let add_char = |set: &mut HashSet<String>, val: Option<&str>| {
        if let Some(s) = val {
            if !s.is_empty() {
                set.insert(s.to_string());
            }
        }
    };

    if let Some(arr) = payload.get("messages").and_then(|v| v.as_array()) {
        for row in arr {
            add_chat(&mut chat_ids, row.get("chatId").and_then(|v| v.as_str()));
        }
    }
    if let Some(arr) = payload.get("messageManifests").and_then(|v| v.as_array()) {
        for row in arr {
            add_chat(&mut chat_ids, row.get("chatId").and_then(|v| v.as_str()));
        }
    }
    if let Some(arr) = payload.get("messageDeletes").and_then(|v| v.as_array()) {
        for row in arr {
            add_chat(&mut chat_ids, row.get("chatId").and_then(|v| v.as_str()));
        }
    }
    if let Some(arr) = payload.get("chats").and_then(|v| v.as_array()) {
        for row in arr {
            add_chat(&mut chat_ids, row.get("id").and_then(|v| v.as_str()));
            add_char(
                &mut character_ids,
                row.get("characterId").and_then(|v| v.as_str()),
            );
        }
    }
    if let Some(arr) = payload.get("chatDeletes").and_then(|v| v.as_array()) {
        for row in arr {
            add_chat(&mut chat_ids, row.as_str());
        }
    }
    if let Some(arr) = payload.get("characters").and_then(|v| v.as_array()) {
        for row in arr {
            add_char(&mut character_ids, row.get("id").and_then(|v| v.as_str()));
        }
    }
    if let Some(arr) = payload.get("characterDeletes").and_then(|v| v.as_array()) {
        for row in arr {
            add_char(&mut character_ids, row.as_str());
        }
    }
    if let Some(arr) = payload.get("chatManifests").and_then(|v| v.as_array()) {
        for row in arr {
            add_char(
                &mut character_ids,
                row.get("characterId").and_then(|v| v.as_str()),
            );
        }
    }

    let mut root_upserts = Vec::new();
    if let Some(arr) = payload
        .get("root")
        .and_then(|v| v.get("upserts"))
        .and_then(|v| v.as_array())
    {
        for entry in arr {
            if let Some(k) = entry.get("key").and_then(|v| v.as_str()) {
                root_upserts.push(k.to_string());
            }
        }
    }
    if let Some(arr) = payload.get("rootUpserts").and_then(|v| v.as_array()) {
        for entry in arr {
            if let Some(k) = entry.get("key").and_then(|v| v.as_str()) {
                root_upserts.push(k.to_string());
            }
        }
    }

    let mut root_deletes = Vec::new();
    if let Some(arr) = payload
        .get("root")
        .and_then(|v| v.get("deletes"))
        .and_then(|v| v.as_array())
    {
        for entry in arr {
            if let Some(k) = entry.as_str() {
                root_deletes.push(k.to_string());
            }
        }
    }
    if let Some(arr) = payload.get("rootDeletes").and_then(|v| v.as_array()) {
        for entry in arr {
            if let Some(k) = entry.as_str() {
                root_deletes.push(k.to_string());
            }
        }
    }

    let mut plugin_storage_upserts = Vec::new();
    if let Some(arr) = payload
        .get("pluginStorage")
        .and_then(|v| v.get("upserts"))
        .and_then(|v| v.as_array())
    {
        for entry in arr {
            if let Some(k) = entry.get("key").and_then(|v| v.as_str()) {
                plugin_storage_upserts.push(k.to_string());
            }
        }
    }

    let mut plugin_storage_deletes = Vec::new();
    if let Some(arr) = payload
        .get("pluginStorage")
        .and_then(|v| v.get("deletes"))
        .and_then(|v| v.as_array())
    {
        for entry in arr {
            if let Some(k) = entry.as_str() {
                plugin_storage_deletes.push(k.to_string());
            }
        }
    }

    let replace_all = payload
        .get("replaceAll")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let plugin_storage_cleared = payload
        .get("pluginStorage")
        .and_then(|v| v.get("clear"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    SqlCommitChangeDescription {
        chat_ids: chat_ids.into_iter().collect(),
        character_ids: character_ids.into_iter().collect(),
        root_upsert_keys: root_upserts,
        root_delete_keys: root_deletes.clone(),
        root_changed: replace_all || !root_deletes.is_empty(),
        plugin_storage_upsert_keys: plugin_storage_upserts,
        plugin_storage_delete_keys: plugin_storage_deletes,
        plugin_storage_cleared,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEventRecord {
    pub id: u64,
    pub event: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationStateRecord {
    #[serde(rename = "chatId")]
    pub chat_id: String,
    #[serde(rename = "lifecycleId")]
    pub lifecycle_id: String,
    pub state: String,
    #[serde(rename = "sourceClientId", skip_serializing_if = "Option::is_none")]
    pub source_client_id: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct RealtimeEventHub {
    sender: broadcast::Sender<SseEventRecord>,
    history: Arc<RwLock<Vec<SseEventRecord>>>,
    active_generations: Arc<RwLock<HashMap<String, GenerationStateRecord>>>,
    sequence: Arc<RwLock<u64>>,
    history_limit: usize,
}

impl RealtimeEventHub {
    pub fn new(history_limit: usize) -> Self {
        let (sender, _) = broadcast::channel(1024);
        Self {
            sender,
            history: Arc::new(RwLock::new(Vec::new())),
            active_generations: Arc::new(RwLock::new(HashMap::new())),
            sequence: Arc::new(RwLock::new(0)),
            history_limit,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SseEventRecord> {
        self.sender.subscribe()
    }

    pub async fn broadcast(&self, event: &str, mut data: serde_json::Value) {
        let mut seq_lock = self.sequence.write().await;
        *seq_lock += 1;
        let id = *seq_lock;

        if let Some(obj) = data.as_object_mut() {
            obj.insert("eventId".to_string(), serde_json::json!(id));
        }

        let record = SseEventRecord {
            id,
            event: event.to_string(),
            data,
        };

        let mut hist = self.history.write().await;
        hist.push(record.clone());
        if hist.len() > self.history_limit {
            let drop_count = hist.len() - self.history_limit;
            hist.drain(0..drop_count);
        }

        let _ = self.sender.send(record);
    }

    pub async fn get_replay_events(&self, last_event_id: u64) -> (bool, Vec<SseEventRecord>) {
        let hist = self.history.read().await;
        if hist.is_empty() {
            return (true, Vec::new());
        }
        let oldest_id = hist.first().map(|r| r.id).unwrap_or(0);
        let newest_id = hist.last().map(|r| r.id).unwrap_or(0);

        if last_event_id < oldest_id - 1 {
            // Replay window expired
            return (false, Vec::new());
        }

        let events = hist
            .iter()
            .filter(|r| r.id > last_event_id && r.id <= newest_id)
            .cloned()
            .collect();
        (true, events)
    }

    pub async fn get_active_generations(&self) -> Vec<GenerationStateRecord> {
        let map = self.active_generations.read().await;
        map.values().cloned().collect()
    }

    pub async fn update_generation_state(
        &self,
        input: &serde_json::Value,
        source_client_id: Option<&str>,
    ) -> Option<GenerationStateRecord> {
        let chat_id = input
            .get("chatId")
            .and_then(|v| v.as_str())?
            .trim()
            .to_string();
        let lifecycle_id = input
            .get("lifecycleId")
            .and_then(|v| v.as_str())?
            .trim()
            .to_string();
        let state = input
            .get("state")
            .and_then(|v| v.as_str())?
            .trim()
            .to_string();

        if chat_id.is_empty()
            || chat_id.len() > 256
            || lifecycle_id.is_empty()
            || lifecycle_id.len() > 128
        {
            return None;
        }
        if !["started", "finished", "failed", "aborted"].contains(&state.as_str()) {
            return None;
        }

        let now = chrono::Utc::now().timestamp_millis();
        let record = GenerationStateRecord {
            chat_id: chat_id.clone(),
            lifecycle_id,
            state: state.clone(),
            source_client_id: normalize_client_id(source_client_id),
            updated_at: now,
        };

        {
            let mut map = self.active_generations.write().await;
            if state == "started" {
                map.insert(chat_id.clone(), record.clone());
            } else {
                map.remove(&chat_id);
            }
        }

        self.broadcast(
            "generation-state",
            serde_json::to_value(&record).unwrap_or_default(),
        )
        .await;
        Some(record)
    }
}
