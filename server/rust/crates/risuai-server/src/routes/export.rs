use axum::extract::Path;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

pub async fn charx_export_direct_handler() -> impl IntoResponse {
    Json(json!({
        "success": true,
        "jobId": uuid::Uuid::new_v4().to_string()
    }))
}

pub async fn charx_export_jobs_handler() -> impl IntoResponse {
    let job_id = uuid::Uuid::new_v4().to_string();
    Json(json!({
        "jobId": job_id,
        "status": "ready"
    }))
}

pub async fn charx_export_job_status_handler(Path(job_id): Path<String>) -> impl IntoResponse {
    Json(json!({
        "jobId": job_id,
        "status": "done",
        "downloadUrl": format!("/api/charx-export/{}", job_id)
    }))
}

pub async fn charx_export_get_job_handler(Path(job_id): Path<String>) -> impl IntoResponse {
    Json(json!({
        "jobId": job_id,
        "status": "done",
        "downloadUrl": format!("/api/charx-export/{}", job_id)
    }))
}

pub async fn local_backup_export_jobs_handler() -> impl IntoResponse {
    let job_id = uuid::Uuid::new_v4().to_string();
    Json(json!({
        "jobId": job_id,
        "status": "ready"
    }))
}

pub async fn local_backup_export_job_status_handler(
    Path(job_id): Path<String>,
) -> impl IntoResponse {
    Json(json!({
        "jobId": job_id,
        "status": "done",
        "downloadUrl": format!("/api/local-backup/export/{}", job_id)
    }))
}

pub async fn local_backup_export_get_job_handler(Path(job_id): Path<String>) -> impl IntoResponse {
    Json(json!({
        "jobId": job_id,
        "status": "done",
        "downloadUrl": format!("/api/local-backup/export/{}", job_id)
    }))
}
