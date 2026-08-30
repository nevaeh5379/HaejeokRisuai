use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use risuai_core::realtime::describe_sql_commit_change;
use risuai_storage::models::{StorageError, SyncPayload};

use crate::state::AppState;

fn map_storage_error(e: StorageError) -> (StatusCode, Json<Value>) {
    match e {
        StorageError::RevisionConflict { revision } => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Revision conflict",
                "code": "revision_conflict",
                "currentRevision": revision
            })),
        ),
        StorageError::Unavailable(msg) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": msg, "code": "storage_unavailable" })),
        ),
        StorageError::InvalidPayload(msg) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg, "code": "invalid_payload" })),
        ),
        StorageError::Database(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": msg, "code": "database_error" })),
        ),
        StorageError::NotSupported(msg) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg, "code": "not_supported" })),
        ),
    }
}

pub async fn get_database_state_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.get_state().await {
        Ok(res) => (StatusCode::OK, Json(json!(res))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn commit_database_handler(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    let sync_payload: SyncPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string(), "code": "invalid_payload" })),
            )
                .into_response()
        }
    };

    let change_desc = describe_sql_commit_change(&payload);

    match storage.sync(sync_payload).await {
        Ok(res) => {
            state
                .realtime_hub
                .broadcast(
                    "database-change",
                    json!({
                        "revision": res.revision,
                        "changes": change_desc,
                    }),
                )
                .await;

            (StatusCode::OK, Json(json!(res))).into_response()
        }
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn startup_data_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.load_startup_data().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct SettingKeysPayload {
    pub keys: Vec<String>,
}

pub async fn setting_keys_handler(
    State(state): State<AppState>,
    Json(payload): Json<SettingKeysPayload>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.load_setting_keys(&payload.keys).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_character_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.load_character(&id).await {
        Ok(Some(res)) => (StatusCode::OK, Json(res)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Character not found" })),
        )
            .into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_character_assets_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.load_character_asset_fields(&id).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_chat_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.load_chat(&id).await {
        Ok(Some(res)) => (StatusCode::OK, Json(res)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Chat not found" })),
        )
            .into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct ChatMessagesQuery {
    pub limit: Option<usize>,
    pub before: Option<usize>,
}

pub async fn get_chat_messages_handler(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Query(query): Query<ChatMessagesQuery>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage
        .load_chat_messages(&chat_id, query.limit, query.before)
        .await
    {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_snapshot_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.export_snapshot().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn post_snapshot_handler(
    State(state): State<AppState>,
    Json(snapshot): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.import_snapshot(snapshot).await {
        Ok(res) => (StatusCode::OK, Json(json!(res))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn list_tables_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.list_tables().await {
        Ok(res) => (StatusCode::OK, Json(json!({ "tables": res }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct TableRowsQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

pub async fn get_table_rows_handler(
    State(state): State<AppState>,
    Path(table): Path<String>,
    Query(query): Query<TableRowsQuery>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);

    match storage.get_table_rows(&table, limit, offset).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn list_revisions_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.list_revisions().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_revision_diff_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.get_revision_diff().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_revision_details_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.get_revision_details(id).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn preview_restore_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.preview_restore(id).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn restore_revision_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.restore_revision(id).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn bot_stats_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.get_bot_stats().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn token_stats_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.get_token_usage().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

pub async fn search_handler(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    let q = query.q.as_deref().unwrap_or("");
    match storage.search(q).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn search_characters_handler(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    let q = query.q.as_deref().unwrap_or("");
    match storage.search_characters(q).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn list_cold_storage_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.cold_storage_list().await {
        Ok(res) => (StatusCode::OK, Json(json!({ "keys": res }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_cold_storage_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.cold_storage_get(&key).await {
        Ok(Some(res)) => (StatusCode::OK, Json(res)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Key not found" })),
        )
            .into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn put_cold_storage_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.cold_storage_put(&key, value).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct DeleteColdStoragePayload {
    pub keys: Vec<String>,
}

pub async fn delete_cold_storage_handler(
    State(state): State<AppState>,
    Json(payload): Json<DeleteColdStoragePayload>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.cold_storage_delete(&payload.keys).await {
        Ok(count) => (StatusCode::OK, Json(json!({ "deleted": count }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct PruneColdStoragePayload {
    #[serde(rename = "maxKeys")]
    pub max_keys: usize,
}

pub async fn prune_cold_storage_handler(
    State(state): State<AppState>,
    Json(payload): Json<PruneColdStoragePayload>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    match storage.cold_storage_prune(payload.max_keys).await {
        Ok(count) => (StatusCode::OK, Json(json!({ "pruned": count }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn migrate_legacy_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.initialize().await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_database_export_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.export_snapshot().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_plugins_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.list_plugins().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn save_plugins_handler(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.save_module(payload).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct PatchPluginPayload {
    pub enabled: bool,
    #[serde(rename = "baseRevision")]
    pub base_revision: i64,
}

pub async fn patch_plugin_enabled_handler(
    State(state): State<AppState>,
    Path(plugin_name): Path<String>,
    Json(payload): Json<PatchPluginPayload>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };

    let plugins_val = storage
        .list_plugins()
        .await
        .unwrap_or(json!({ "plugins": [] }));
    let mut plugins = plugins_val
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut found = false;
    for p in &mut plugins {
        if p.get("name").and_then(|v| v.as_str()) == Some(&plugin_name) {
            p["enabled"] = json!(payload.enabled);
            found = true;
            break;
        }
    }
    if !found {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Plugin not found", "code": "plugin_not_found" })),
        )
            .into_response();
    }

    let sync_res = storage.update_setting("plugins", json!(plugins)).await;
    match sync_res {
        Ok(_) => {
            state
                .realtime_hub
                .broadcast(
                    "database-change",
                    json!({
                        "action": "plugin-toggle",
                        "pluginName": plugin_name,
                        "pluginEnabled": payload.enabled,
                    }),
                )
                .await;
            (
                StatusCode::OK,
                Json(json!({ "success": true, "revision": payload.base_revision + 1 })),
            )
                .into_response()
        }
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_plugins_data_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let plugins_res = storage
        .list_plugins()
        .await
        .unwrap_or(json!({ "plugins": [] }));
    let custom_storage_res = storage
        .get_plugin_custom_storage()
        .await
        .unwrap_or(json!({ "pluginCustomStorage": {} }));

    let plugins = plugins_res.get("plugins").cloned().unwrap_or(json!([]));
    let custom_storage = custom_storage_res
        .get("pluginCustomStorage")
        .cloned()
        .unwrap_or(json!({}));
    let hash = risuai_storage::codec::compute_hash(&format!("{}{}", plugins, custom_storage));

    (
        StatusCode::OK,
        Json(json!({
            "plugins": plugins,
            "pluginCustomStorage": custom_storage,
            "hash": hash,
        })),
    )
        .into_response()
}

pub async fn get_plugin_custom_storage_keys_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.list_plugin_custom_storage_keys().await {
        Ok(res) => (StatusCode::OK, Json(json!({ "keys": res }))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_plugin_custom_storage_key_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.get_plugin_custom_storage_key(&key).await {
        Ok(Some(res)) => (StatusCode::OK, Json(res)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Key not found" })),
        )
            .into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_plugin_custom_storage_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.get_plugin_custom_storage().await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

fn setting_value(res: &Value, key: &str) -> Option<Value> {
    res.get("settings")
        .and_then(|s| s.get(key))
        .cloned()
        .or_else(|| res.get(key).cloned())
}

fn normalize_preset_list_response(res: Value) -> Value {
    let presets = if let Some(p) = res.get("presets").and_then(|v| v.as_array()) {
        Value::Array(p.clone())
    } else if let Some(p) = res.get("botPresets").and_then(|v| v.as_array()) {
        Value::Array(p.clone())
    } else if let Some(p) = res
        .get("settings")
        .and_then(|s| s.get("botPresets"))
        .and_then(|v| v.as_array())
    {
        Value::Array(p.clone())
    } else {
        Value::Array(Vec::new())
    };

    let hash = if let Some(h) = res.get("hash").and_then(|h| h.as_str()) {
        h.to_string()
    } else {
        risuai_storage::codec::compute_hash(&presets.to_string())
    };

    json!({
        "presets": presets,
        "hash": hash,
    })
}

fn normalize_preset_detail_response(res: Value) -> Value {
    let (preset, hash) = if let Some(preset) = res.get("preset").filter(|v| !v.is_null()) {
        let hash = res
            .get("hash")
            .and_then(|h| h.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| risuai_storage::codec::compute_hash(&preset.to_string()));
        (preset.clone(), hash)
    } else {
        let hash = res
            .get("hash")
            .and_then(|h| h.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| risuai_storage::codec::compute_hash(&res.to_string()));
        (res, hash)
    };

    json!({
        "preset": preset,
        "hash": hash,
    })
}

pub async fn get_personas_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let keys = vec!["personas".to_string()];
    let res = storage
        .load_setting_keys(&keys)
        .await
        .unwrap_or(json!({ "settings": {} }));
    let personas = setting_value(&res, "personas").unwrap_or(json!([]));
    let hash = risuai_storage::codec::compute_hash(&personas.to_string());
    (
        StatusCode::OK,
        Json(json!({ "personas": personas, "hash": hash })),
    )
        .into_response()
}

pub async fn save_persona_handler(Json(payload): Json<Value>) -> impl IntoResponse {
    Json(json!({ "success": true, "persona": payload }))
}

pub async fn get_presets_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.list_presets().await {
        Ok(res) => (StatusCode::OK, Json(normalize_preset_list_response(res))).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_preset_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.load_preset(&id).await {
        Ok(Some(res)) => {
            (StatusCode::OK, Json(normalize_preset_detail_response(res))).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Preset not found" })),
        )
            .into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn save_preset_handler(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.save_preset(payload, None).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_lorebooks_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let keys = vec!["loreBook".to_string()];
    let res = storage
        .load_setting_keys(&keys)
        .await
        .unwrap_or(json!({ "settings": {} }));
    let lore_book = setting_value(&res, "loreBook").unwrap_or(json!([]));
    let hash = risuai_storage::codec::compute_hash(&lore_book.to_string());
    (
        StatusCode::OK,
        Json(json!({ "loreBook": lore_book, "hash": hash })),
    )
        .into_response()
}

pub async fn save_lorebook_handler(Json(payload): Json<Value>) -> impl IntoResponse {
    Json(json!({ "success": true, "lorebook": payload }))
}

pub async fn get_modules_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let keys = vec!["modules".to_string()];
    let res = storage
        .load_setting_keys(&keys)
        .await
        .unwrap_or(json!({ "settings": {} }));
    let modules = setting_value(&res, "modules").unwrap_or(json!([]));
    let hash = risuai_storage::codec::compute_hash(&modules.to_string());
    (
        StatusCode::OK,
        Json(json!({ "modules": modules, "hash": hash })),
    )
        .into_response()
}

pub async fn save_module_handler(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.save_module(payload).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn get_prompts_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let keys = vec!["prompts".to_string()];
    let res = storage
        .load_setting_keys(&keys)
        .await
        .unwrap_or(json!({ "settings": {} }));
    let prompts = setting_value(&res, "prompts").unwrap_or(json!([]));
    let hash = risuai_storage::codec::compute_hash(&prompts.to_string());
    (
        StatusCode::OK,
        Json(json!({ "prompts": prompts, "hash": hash })),
    )
        .into_response()
}

pub async fn save_prompt_handler(Json(payload): Json<Value>) -> impl IntoResponse {
    Json(json!({ "success": true, "prompt": payload }))
}

pub async fn get_scripts_handler(State(state): State<AppState>) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let keys = vec!["scripts".to_string()];
    let res = storage
        .load_setting_keys(&keys)
        .await
        .unwrap_or(json!({ "settings": {} }));
    let globalscript = setting_value(&res, "scripts").unwrap_or(json!([]));
    let hash = risuai_storage::codec::compute_hash(&globalscript.to_string());
    (
        StatusCode::OK,
        Json(json!({ "globalscript": globalscript, "hash": hash })),
    )
        .into_response()
}

pub async fn save_script_handler(Json(payload): Json<Value>) -> impl IntoResponse {
    Json(json!({ "success": true, "script": payload }))
}

pub async fn get_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    let keys = vec![key.clone()];
    match storage.load_setting_keys(&keys).await {
        Ok(res) => {
            if let Some(val) = setting_value(&res, &key) {
                let hash = risuai_storage::codec::compute_hash(&val.to_string());
                (
                    StatusCode::OK,
                    Json(json!({ "key": key, "value": val, "exists": true, "hash": hash })),
                )
                    .into_response()
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": format!("Setting key not found: {}", key) })),
                )
                    .into_response()
            }
        }
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn update_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.update_setting(&key, payload).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn delete_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.delete_setting(&key).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn save_character_handler(
    Path(id): Path<String>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    Json(json!({ "success": true, "id": id, "character": payload }))
}

pub async fn delete_character_handler(Path(id): Path<String>) -> impl IntoResponse {
    Json(json!({ "success": true, "id": id }))
}

pub async fn save_chat_handler(
    Path(id): Path<String>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    Json(json!({ "success": true, "id": id, "chat": payload }))
}

pub async fn delete_chat_handler(Path(id): Path<String>) -> impl IntoResponse {
    Json(json!({ "success": true, "id": id }))
}

pub async fn save_message_handler(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.save_message(&chat_id, payload).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn delete_message_handler(
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.delete_message(&chat_id, &message_id).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

pub async fn delete_module_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let storage = match state.storage_manager.get_storage().await {
        Ok(s) => s,
        Err(e) => return map_storage_error(e).into_response(),
    };
    match storage.delete_module(&id).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err(e) => map_storage_error(e).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_setting_value_flat_and_wrapped() {
        // flat
        let flat = json!({ "personas": ["p1", "p2"] });
        assert_eq!(setting_value(&flat, "personas"), Some(json!(["p1", "p2"])));

        // wrapped
        let wrapped = json!({ "settings": { "personas": ["p1", "p2"] } });
        assert_eq!(
            setting_value(&wrapped, "personas"),
            Some(json!(["p1", "p2"]))
        );

        // wrapped takes precedence if both exist
        let both = json!({
            "personas": ["flat"],
            "settings": { "personas": ["wrapped"] }
        });
        assert_eq!(setting_value(&both, "personas"), Some(json!(["wrapped"])));

        // missing
        let missing = json!({ "settings": {} });
        assert_eq!(setting_value(&missing, "personas"), None);

        let empty = json!({});
        assert_eq!(setting_value(&empty, "personas"), None);
    }

    #[test]
    fn test_normalize_preset_list_postgres() {
        let input = json!({
            "botPresets": [{ "id": "preset1", "name": "Default" }]
        });
        let expected_hash = risuai_storage::codec::compute_hash(
            &json!([{ "id": "preset1", "name": "Default" }]).to_string(),
        );
        let res = normalize_preset_list_response(input);
        assert_eq!(
            res,
            json!({
                "presets": [{ "id": "preset1", "name": "Default" }],
                "hash": expected_hash,
            })
        );
    }

    #[test]
    fn test_normalize_preset_list_canonical_azure() {
        let input = json!({
            "presets": [{ "id": "preset1", "name": "AzurePreset" }],
            "hash": "azure_hash_abc"
        });
        let res = normalize_preset_list_response(input);
        assert_eq!(
            res,
            json!({
                "presets": [{ "id": "preset1", "name": "AzurePreset" }],
                "hash": "azure_hash_abc",
            })
        );
    }

    #[test]
    fn test_normalize_preset_list_wrapped_settings_fallback() {
        let input = json!({
            "settings": {
                "botPresets": [{ "id": "preset2" }]
            }
        });
        let expected_hash =
            risuai_storage::codec::compute_hash(&json!([{ "id": "preset2" }]).to_string());
        let res = normalize_preset_list_response(input);
        assert_eq!(
            res,
            json!({
                "presets": [{ "id": "preset2" }],
                "hash": expected_hash,
            })
        );
    }

    #[test]
    fn test_normalize_preset_list_malformed_becomes_empty() {
        let malformed_string = json!({ "presets": "not an array" });
        let empty_hash = risuai_storage::codec::compute_hash(&json!([]).to_string());
        let res = normalize_preset_list_response(malformed_string);
        assert_eq!(
            res,
            json!({
                "presets": [],
                "hash": empty_hash,
            })
        );

        let malformed_number = json!({ "botPresets": 12345 });
        let res2 = normalize_preset_list_response(malformed_number);
        assert_eq!(
            res2,
            json!({
                "presets": [],
                "hash": empty_hash,
            })
        );

        let empty = json!({});
        let res3 = normalize_preset_list_response(empty);
        assert_eq!(
            res3,
            json!({
                "presets": [],
                "hash": empty_hash,
            })
        );
    }

    #[test]
    fn test_normalize_preset_detail_raw() {
        let raw = json!({
            "id": "p1",
            "name": "Raw Preset",
            "temperature": 0.7
        });
        let expected_hash = risuai_storage::codec::compute_hash(&raw.to_string());
        let res = normalize_preset_detail_response(raw.clone());
        assert_eq!(
            res,
            json!({
                "preset": raw,
                "hash": expected_hash,
            })
        );
        assert!(res.get("queryMs").is_none());
    }

    #[test]
    fn test_normalize_preset_detail_wrapped() {
        let wrapped = json!({
            "preset": {
                "id": "p1",
                "name": "Wrapped Preset",
            },
            "hash": "existing_detail_hash",
            "queryMs": 12.34
        });
        let res = normalize_preset_detail_response(wrapped);
        assert_eq!(
            res,
            json!({
                "preset": {
                    "id": "p1",
                    "name": "Wrapped Preset",
                },
                "hash": "existing_detail_hash",
            })
        );
        assert!(res.get("queryMs").is_none());

        // wrapped without hash computes hash
        let wrapped_no_hash = json!({
            "preset": {
                "id": "p2",
                "name": "Wrapped No Hash",
            },
            "queryMs": 5.0
        });
        let expected_hash = risuai_storage::codec::compute_hash(
            &json!({
                "id": "p2",
                "name": "Wrapped No Hash",
            })
            .to_string(),
        );
        let res2 = normalize_preset_detail_response(wrapped_no_hash);
        assert_eq!(
            res2,
            json!({
                "preset": {
                    "id": "p2",
                    "name": "Wrapped No Hash",
                },
                "hash": expected_hash,
            })
        );
        assert!(res2.get("queryMs").is_none());
    }
}
