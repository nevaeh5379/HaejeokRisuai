use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use risuai_storage::diagnostics::{mask_sensitive_connection_string, test_postgres_connection};
use risuai_storage::factory::DatabaseConfig;

use crate::state::AppState;

pub async fn get_db_config_handler(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.storage_manager.get_config().await;
    Json(json!({
        "enabled": cfg.enabled,
        "connectionString": mask_sensitive_connection_string(&cfg.connection_string),
        "backupConnectionString": cfg.backup_connection_string.as_deref().map(mask_sensitive_connection_string),
        "ready": state.storage_manager.is_storage_ready().await,
    }))
}

#[derive(Debug, Deserialize)]
pub struct TestDbPayload {
    #[serde(rename = "connectionString")]
    pub connection_string: String,
}

pub async fn test_db_config_handler(Json(payload): Json<TestDbPayload>) -> impl IntoResponse {
    match test_postgres_connection(&payload.connection_string).await {
        Ok(latency) => (
            StatusCode::OK,
            Json(json!({ "success": true, "latencyMs": latency })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e })),
        )
            .into_response(),
    }
}

pub async fn update_db_config_handler(
    State(state): State<AppState>,
    Json(payload): Json<DatabaseConfig>,
) -> impl IntoResponse {
    match state.storage_manager.update_config(payload).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn retry_db_config_handler(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.storage_manager.get_config().await;
    match state.storage_manager.update_config(cfg).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn get_db_backup_config_handler() -> impl IntoResponse {
    Json(json!({
        "enabled": false,
        "connectionString": "",
        "syncIntervalSec": 300
    }))
}

pub async fn update_db_backup_config_handler(
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    Json(json!({ "success": true, "config": payload }))
}

pub async fn sync_db_backup_handler() -> impl IntoResponse {
    Json(json!({ "success": true }))
}

pub async fn db_backup_resync_handler() -> impl IntoResponse {
    Json(json!({ "success": true, "resynced": true }))
}

pub async fn db_backup_restore_handler() -> impl IntoResponse {
    Json(json!({ "success": true, "restored": true }))
}

pub async fn delete_db_backup_handler() -> impl IntoResponse {
    Json(json!({ "success": true, "deleted": true }))
}
