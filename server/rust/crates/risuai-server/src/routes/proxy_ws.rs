use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateStreamJobPayload {
    #[serde(rename = "targetUrl")]
    pub target_url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

pub async fn create_proxy_stream_job_handler(
    State(state): State<AppState>,
    Json(payload): Json<CreateStreamJobPayload>,
) -> impl IntoResponse {
    let req = risuai_core::model_jobs::ModelJobCreateRequest {
        target_url: payload.target_url,
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
        timeout_ms: payload.timeout_ms,
        chat_id: "proxy".to_string(),
        generation_id: None,
        protocol: None,
        model: None,
        speaker_id: None,
        target_origin: None,
        streaming: Some(true),
        recoverable: Some(false),
    };

    match state.model_jobs.create_job(req, None).await {
        Ok(job_id) => (
            StatusCode::OK,
            Json(json!({ "jobId": job_id, "heartbeatSec": 15 })),
        )
            .into_response(),
        Err((code, msg, running_id)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            Json(json!({ "error": msg, "runningJobId": running_id })),
        )
            .into_response(),
    }
}

pub async fn delete_proxy_stream_job_handler(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> impl IntoResponse {
    match state.model_jobs.delete_job(&job_id).await {
        Ok(aborted) => (
            StatusCode::OK,
            Json(json!({ "success": true, "aborted": aborted })),
        )
            .into_response(),
        Err((code, msg)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::NOT_FOUND),
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

pub async fn proxy_stream_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_proxy_socket(socket, state, job_id))
}

async fn handle_proxy_socket(mut socket: WebSocket, state: AppState, job_id: String) {
    let handle = match state.model_jobs.get_stream_handle(&job_id).await {
        Some(h) => h,
        None => {
            let _ = socket
                .send(Message::Text(
                    json!({ "type": "error", "error": "Job not found" })
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };

    let (record, notify_opt, path) = handle;

    let _ = socket
        .send(Message::Text(
            json!({
                "type": "job_accepted",
                "jobId": job_id,
                "status": record.status,
            })
            .to_string()
            .into(),
        ))
        .await;

    let mut read_offset = 0;

    loop {
        if path.exists() {
            if let Ok(mut file) = tokio::fs::File::open(&path).await {
                use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
                if file.seek(SeekFrom::Start(read_offset as u64)).await.is_ok() {
                    let mut buf = vec![0u8; 64 * 1024];
                    while let Ok(n) = file.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        read_offset += n;
                        let chunk = &buf[..n];
                        if socket
                            .send(Message::Binary(chunk.to_vec().into()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
        }

        if let Some(curr) = state.model_jobs.get_job(&job_id).await {
            if curr.status != "running" {
                let _ = socket
                    .send(Message::Text(
                        json!({
                            "type": "done",
                            "status": curr.status,
                            "upstreamStatus": curr.upstream_status,
                        })
                        .to_string()
                        .into(),
                    ))
                    .await;
                break;
            }
        }

        if let Some(notify) = &notify_opt {
            tokio::select! {
                _ = notify.notified() => {},
                _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {
                    let _ = socket.send(Message::Ping(vec![].into())).await;
                }
            }
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
}
