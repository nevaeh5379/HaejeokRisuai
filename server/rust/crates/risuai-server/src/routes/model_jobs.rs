use axum::extract::{Path, Query, State};
use axum::http::header::{HeaderMap, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;
use risuai_core::model_jobs::ModelJobCreateRequest;

pub async fn create_model_job_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ModelJobCreateRequest>,
) -> impl IntoResponse {
    let client_id = headers
        .get("x-client-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    match state.model_jobs.create_job(payload, client_id).await {
        Ok(job_id) => (StatusCode::OK, Json(json!({ "id": job_id }))).into_response(),
        Err((code, msg, running_id)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            Json(json!({ "error": msg, "runningJobId": running_id })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListJobsQuery {
    pub filter: Option<String>,
}

pub async fn list_model_jobs_handler(
    State(state): State<AppState>,
    Query(query): Query<ListJobsQuery>,
) -> impl IntoResponse {
    let filter = query.filter.as_deref().unwrap_or("active");
    match state.model_jobs.list_jobs(filter).await {
        Some(jobs) => (StatusCode::OK, Json(json!({ "jobs": jobs }))).into_response(),
        None => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid filter" })),
        )
            .into_response(),
    }
}

pub async fn get_model_job_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.model_jobs.get_job(&id).await {
        Some(job) => (StatusCode::OK, Json(json!(job))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Job not found" })),
        )
            .into_response(),
    }
}

pub async fn claim_model_job_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.model_jobs.claim_job(&id).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err((code, msg)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

pub async fn delete_model_job_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.model_jobs.delete_job(&id).await {
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

pub async fn stream_model_job_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let handle = match state.model_jobs.get_stream_handle(&id).await {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "Job not found").into_response(),
    };

    let (record, notify_opt, path) = handle;
    let job_id = id.clone();
    let model_jobs_manager = state.model_jobs.clone();

    let stream = async_stream::stream! {
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
                            yield Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(&buf[..n]));
                        }
                    }
                }
            }

            if let Some(curr) = model_jobs_manager.get_job(&job_id).await {
                if curr.status != "running" {
                    break;
                }
            }

            if let Some(notify) = &notify_opt {
                tokio::select! {
                    _ = notify.notified() => {},
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
                }
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("x-model-job-id", &record.id)
        .header("x-model-job-status", &record.status);

    if let Some(up_status) = record.upstream_status {
        builder = builder.header("x-model-job-upstream-status", up_status.to_string());
    }

    if let Some(ct) = record.content_type {
        builder = builder.header(CONTENT_TYPE, ct);
    }

    builder
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create stream response",
            )
                .into_response()
        })
}
