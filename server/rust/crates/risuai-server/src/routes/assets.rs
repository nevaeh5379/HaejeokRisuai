use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use risuai_assets::bulk_protocol::{
    create_chunk_packet, create_end_packet, create_header_packet, BulkPacket, BulkPacketParser,
};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ReadAssetQuery {
    pub path: Option<String>,
    pub thumbnail: Option<bool>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub async fn read_asset_handler(
    State(state): State<AppState>,
    path_param: Option<Path<String>>,
    Query(query): Query<ReadAssetQuery>,
    headers: HeaderMap,
) -> Response {
    let target_path = path_param
        .map(|p| p.0)
        .or(query.path)
        .or_else(|| {
            headers
                .get("file-path")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    if target_path.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing path").into_response();
    }

    let is_thumb = query.thumbnail.unwrap_or(false);
    let width = query.width.unwrap_or(128);
    let height = query.height.unwrap_or(128);

    let result = if is_thumb {
        state
            .asset_manager
            .read_thumbnail(&target_path, width, height)
            .await
    } else {
        state.asset_manager.read(&target_path).await
    };

    match result {
        Ok(Some(res)) => {
            let total_len = res.data.len();

            if let Some(range_header) = headers.get(RANGE).and_then(|v| v.to_str().ok()) {
                if let Some(stripped) = range_header.strip_prefix("bytes=") {
                    let parts: Vec<&str> = stripped.split('-').collect();
                    if !parts.is_empty() {
                        let start: usize = parts[0].parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].is_empty() {
                            parts[1].parse().unwrap_or(total_len - 1).min(total_len - 1)
                        } else {
                            total_len - 1
                        };

                        if start <= end && start < total_len {
                            let slice = &res.data[start..=end];
                            return Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header(CONTENT_TYPE, res.content_type)
                                .header(
                                    CONTENT_RANGE,
                                    format!("bytes {}-{}/{}", start, end, total_len),
                                )
                                .header(CONTENT_LENGTH, slice.len().to_string())
                                .header(ACCEPT_RANGES, "bytes")
                                .body(axum::body::Body::from(slice.to_vec()))
                                .unwrap();
                        }
                    }
                }
            }

            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, res.content_type)
                .header(CONTENT_LENGTH, total_len.to_string())
                .header(ACCEPT_RANGES, "bytes")
                .body(axum::body::Body::from(res.data))
                .unwrap()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "Not found").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct WriteAssetQuery {
    pub path: Option<String>,
}

pub async fn write_asset_handler(
    State(state): State<AppState>,
    path_param: Option<Path<String>>,
    Query(query): Query<WriteAssetQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let target_path = path_param
        .map(|p| p.0)
        .or(query.path)
        .or_else(|| {
            headers
                .get("file-path")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    if target_path.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing path" })),
        )
            .into_response();
    }

    match state.asset_manager.write(&target_path, &body).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct RemoveAssetQuery {
    pub path: String,
}

pub async fn remove_asset_handler(
    State(state): State<AppState>,
    Query(query): Query<RemoveAssetQuery>,
) -> impl IntoResponse {
    match state.asset_manager.delete(&query.path).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListAssetsQuery {
    pub prefix: Option<String>,
}

pub async fn list_assets_handler(
    State(state): State<AppState>,
    Query(query): Query<ListAssetsQuery>,
) -> impl IntoResponse {
    let prefix = query.prefix.as_deref().unwrap_or("");
    match state.asset_manager.list(prefix).await {
        Ok(items) => (StatusCode::OK, Json(json!({ "items": items }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct ReadBulkPayload {
    pub paths: Vec<String>,
}

pub async fn read_bulk_handler(
    State(state): State<AppState>,
    Json(payload): Json<ReadBulkPayload>,
) -> Response {
    let mut output = Vec::new();

    for (i, path) in payload.paths.iter().enumerate() {
        let file_id = (i + 1) as u32;
        if let Ok(Some(asset)) = state.asset_manager.read(path).await {
            let hdr = create_header_packet(file_id, path, asset.data.len() as u64);
            output.extend_from_slice(&hdr);

            for chunk in asset.data.chunks(64 * 1024) {
                let cp = create_chunk_packet(file_id, chunk);
                output.extend_from_slice(&cp);
            }

            let ep = create_end_packet(file_id);
            output.extend_from_slice(&ep);
        }
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/octet-stream")
        .body(axum::body::Body::from(output))
        .unwrap()
}

pub async fn write_bulk_handler(State(state): State<AppState>, body: Bytes) -> impl IntoResponse {
    let mut parser = BulkPacketParser::new();
    parser.push(&body);

    let mut open_files: HashMap<u32, (String, Vec<u8>)> = HashMap::new();
    let mut written = 0;

    while let Ok(Some(pkt)) = parser.next_packet() {
        match pkt {
            BulkPacket::Header {
                file_id,
                name,
                total_size,
            } => {
                open_files.insert(file_id, (name, Vec::with_capacity(total_size as usize)));
            }
            BulkPacket::Chunk { file_id, data } => {
                if let Some((_, buf)) = open_files.get_mut(&file_id) {
                    buf.extend_from_slice(&data);
                }
            }
            BulkPacket::End { file_id } => {
                if let Some((name, buf)) = open_files.remove(&file_id) {
                    if state.asset_manager.write(&name, &buf).await.is_ok() {
                        written += 1;
                    }
                }
            }
        }
    }

    (
        StatusCode::OK,
        Json(json!({ "success": true, "written": written })),
    )
}
