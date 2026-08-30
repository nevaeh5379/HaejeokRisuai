use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use risuai_assets::migration::{migrate_local_to_s3, rollback_s3_to_local};
use risuai_assets::s3::{S3AssetStorage, S3Config};

use crate::state::AppState;

pub async fn get_s3_config_handler(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.asset_manager.get_s3_config().await;
    Json(json!({
        "storageType": state.asset_manager.get_storage_type().await,
        "config": cfg,
    }))
}

#[derive(Debug, Deserialize)]
pub struct UpdateS3ConfigPayload {
    pub config: S3Config,
    pub enable: Option<bool>,
}

pub async fn update_s3_config_handler(
    State(state): State<AppState>,
    Json(payload): Json<UpdateS3ConfigPayload>,
) -> impl IntoResponse {
    match state
        .asset_manager
        .set_s3_config(payload.config, payload.enable.unwrap_or(false))
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e })),
        )
            .into_response(),
    }
}

pub async fn test_s3_handler(Json(payload): Json<S3Config>) -> impl IntoResponse {
    let storage = S3AssetStorage::new(payload);
    match storage.init().await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e })),
        )
            .into_response(),
    }
}

pub async fn get_s3_stats_handler(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.asset_manager.get_s3_config().await;
    if let Some(c) = cfg {
        let storage = S3AssetStorage::new(c);
        match storage.get_stats().await {
            Ok((count, size)) => (
                StatusCode::OK,
                Json(json!({ "count": count, "sizeBytes": size })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response(),
        }
    } else {
        (StatusCode::OK, Json(json!({ "count": 0, "sizeBytes": 0 }))).into_response()
    }
}

pub async fn storage_summary_handler(State(state): State<AppState>) -> impl IntoResponse {
    let local_files = state
        .asset_manager
        .local_fs()
        .list("")
        .await
        .unwrap_or_default();
    Json(json!({
        "storageType": state.asset_manager.get_storage_type().await,
        "localFileCount": local_files.len(),
    }))
}

pub async fn s3_asset_details_handler(State(state): State<AppState>) -> impl IntoResponse {
    let local_files = state
        .asset_manager
        .local_fs()
        .list("")
        .await
        .unwrap_or_default();
    Json(json!({ "files": local_files }))
}

pub async fn s3_migrate_handler(State(state): State<AppState>) -> impl IntoResponse {
    if let Some(cfg) = state.asset_manager.get_s3_config().await {
        let s3 = S3AssetStorage::new(cfg);
        let progress = migrate_local_to_s3(state.asset_manager.local_fs(), &s3, 8).await;
        match progress {
            Ok(p) => (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "total": p.total,
                    "completed": p.completed,
                    "failed": p.failed
                })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e })),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "S3 is not configured" })),
        )
            .into_response()
    }
}

pub async fn s3_rollback_handler(State(state): State<AppState>) -> impl IntoResponse {
    if let Some(cfg) = state.asset_manager.get_s3_config().await {
        let s3 = S3AssetStorage::new(cfg);
        let progress = rollback_s3_to_local(state.asset_manager.local_fs(), &s3, 8).await;
        match progress {
            Ok(p) => (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "total": p.total,
                    "completed": p.completed,
                    "failed": p.failed
                })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e })),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "S3 is not configured" })),
        )
            .into_response()
    }
}

pub async fn s3_generate_thumbnails_handler() -> impl IntoResponse {
    Json(json!({ "success": true, "generated": 0 }))
}

pub async fn storage_assets_delete_handler() -> impl IntoResponse {
    Json(json!({ "success": true }))
}

pub async fn storage_local_clean_handler() -> impl IntoResponse {
    Json(json!({ "success": true }))
}

pub async fn db_hash_handler(State(state): State<AppState>) -> impl IntoResponse {
    let hashes = state.asset_manager.get_db_hash().await;
    Json(hashes)
}

#[derive(Debug, Deserialize)]
pub struct DbResolvePayload {
    pub keep: String,
}

pub async fn db_resolve_handler(
    State(state): State<AppState>,
    Json(payload): Json<DbResolvePayload>,
) -> impl IntoResponse {
    match state.asset_manager.resolve_db(&payload.keep).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e })),
        )
            .into_response(),
    }
}

pub async fn asset_catalog_resync_handler() -> impl IntoResponse {
    Json(json!({ "success": true }))
}
