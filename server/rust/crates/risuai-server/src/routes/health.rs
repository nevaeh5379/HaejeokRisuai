use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::state::AppState;

pub async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let ready = state.storage_manager.is_storage_ready().await;
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "storage": {
                "status": if ready { "ready" } else { "unconfigured" },
                "vendor": "postgres"
            }
        })),
    )
}
