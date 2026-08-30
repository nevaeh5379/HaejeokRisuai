use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use risuai_core::chat_executor::{plan_continuation, ChatContinuationRequest, ChatPlanRequest};
use risuai_core::lore::{
    match_lore_batch, resolve_lore_entries, ChatMessageInput, LoreEntryItem, LoreMatchOptions,
    LoreMatchRequest,
};
use risuai_core::provider_executor::{ProviderExecutionRequest, ProviderTransportRequest};
use risuai_core::tokenize::count_tokens_batch;
use risuai_core::vector::{VectorItem, VectorSyncItem};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct TokenizeCountPayload {
    pub texts: Vec<String>,
    pub encoding: Option<String>,
}

pub async fn tokenize_count_handler(
    Json(payload): Json<TokenizeCountPayload>,
) -> impl IntoResponse {
    let counts = count_tokens_batch(&payload.texts, payload.encoding.as_deref());
    Json(json!({ "counts": counts }))
}

#[derive(Debug, Deserialize)]
pub struct LoreMatchBatchPayload {
    pub messages: Vec<ChatMessageInput>,
    pub requests: Vec<LoreMatchRequest>,
    #[serde(default)]
    pub options: LoreMatchOptions,
}

pub async fn lore_match_batch_handler(
    Json(payload): Json<LoreMatchBatchPayload>,
) -> impl IntoResponse {
    match match_lore_batch(&payload.messages, &payload.requests, &payload.options) {
        Ok(results) => (StatusCode::OK, Json(json!(results))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct LoreResolvePayload {
    pub messages: Vec<ChatMessageInput>,
    pub entries: Vec<LoreEntryItem>,
    #[serde(default)]
    pub options: LoreMatchOptions,
}

pub async fn lore_resolve_handler(Json(payload): Json<LoreResolvePayload>) -> impl IntoResponse {
    match resolve_lore_entries(&payload.messages, &payload.entries, &payload.options) {
        Ok(results) => (StatusCode::OK, Json(json!(results))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct VectorStatusPayload {
    #[serde(rename = "indexId")]
    pub index_id: String,
    pub revision: String,
}

pub async fn vector_status_handler(
    State(state): State<AppState>,
    Json(payload): Json<VectorStatusPayload>,
) -> impl IntoResponse {
    let (up_to_date, cached_rev, count) = state
        .vector_manager
        .check_revision(&payload.index_id, &payload.revision)
        .await;
    Json(json!({
        "upToDate": up_to_date,
        "cachedRevision": cached_rev,
        "vectorCount": count,
    }))
}

#[derive(Debug, Deserialize)]
pub struct VectorSyncPayload {
    #[serde(rename = "indexId")]
    pub index_id: String,
    pub revision: String,
    pub dimension: usize,
    pub items: Vec<VectorSyncItem>,
}

pub async fn vector_sync_handler(
    State(state): State<AppState>,
    Json(payload): Json<VectorSyncPayload>,
) -> impl IntoResponse {
    let (missing, present) = state
        .vector_manager
        .sync(
            &payload.index_id,
            &payload.revision,
            payload.dimension,
            &payload.items,
        )
        .await;
    Json(json!({
        "missingSignatures": missing,
        "presentCount": present,
    }))
}

#[derive(Debug, Deserialize)]
pub struct VectorUpsertPayload {
    #[serde(rename = "indexId")]
    pub index_id: String,
    pub revision: String,
    pub dimension: usize,
    pub items: Vec<VectorItem>,
}

pub async fn vector_upsert_handler(
    State(state): State<AppState>,
    Json(payload): Json<VectorUpsertPayload>,
) -> impl IntoResponse {
    let (count, total) = state
        .vector_manager
        .upsert(
            &payload.index_id,
            &payload.revision,
            payload.dimension,
            payload.items,
        )
        .await;
    Json(json!({
        "upsertedCount": count,
        "totalVectors": total,
    }))
}

#[derive(Debug, Deserialize)]
pub struct VectorSearchPayload {
    #[serde(rename = "indexId")]
    pub index_id: String,
    pub query: Vec<f32>,
    pub limit: usize,
    pub metric: Option<String>,
    pub threshold: Option<f32>,
}

pub async fn vector_search_handler(
    State(state): State<AppState>,
    Json(payload): Json<VectorSearchPayload>,
) -> impl IntoResponse {
    let results = state
        .vector_manager
        .search(
            &payload.index_id,
            &payload.query,
            payload.limit,
            payload.metric.as_deref(),
            payload.threshold,
        )
        .await;
    Json(json!({ "results": results }))
}

pub async fn vector_cache_clear_handler(State(state): State<AppState>) -> impl IntoResponse {
    state.vector_manager.clear().await;
    Json(json!({ "success": true }))
}

pub async fn chat_plan_handler(Json(payload): Json<ChatPlanRequest>) -> impl IntoResponse {
    let gen_id = uuid::Uuid::new_v4().to_string();
    let kept_indexes: Vec<usize> = (0..payload.formated.len()).collect();
    Json(json!({
        "ok": true,
        "keptIndexes": kept_indexes,
        "inputTokens": 100,
        "outputTokens": 50,
        "generationId": gen_id,
        "generationModel": payload.model,
    }))
}

pub async fn chat_continuation_handler(
    Json(payload): Json<ChatContinuationRequest>,
) -> impl IntoResponse {
    let res = plan_continuation(&payload);
    Json(json!(res))
}

pub async fn chat_providers_handler(State(state): State<AppState>) -> impl IntoResponse {
    let (formats, routes, transport) = state.provider_executor.get_formats();
    Json(json!({
        "formats": formats,
        "routes": routes,
        "transportFormats": transport,
    }))
}

pub async fn chat_provider_handler(
    State(state): State<AppState>,
    Json(payload): Json<ProviderExecutionRequest>,
) -> impl IntoResponse {
    match state.provider_executor.execute(payload).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err((code, msg)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

pub async fn chat_transport_handler(
    State(state): State<AppState>,
    Json(payload): Json<ProviderTransportRequest>,
) -> impl IntoResponse {
    match state.provider_executor.execute_transport(payload).await {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err((code, msg)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

pub async fn hypa_start_handler(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let res = state.hypa_executor.start(payload, "global").await;
    Json(res)
}

#[derive(Debug, Deserialize)]
pub struct HypaResumePayload {
    #[serde(rename = "actionId")]
    pub action_id: Option<String>,
    pub value: Option<Value>,
}

pub async fn hypa_resume_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(payload): Json<HypaResumePayload>,
) -> impl IntoResponse {
    match state
        .hypa_executor
        .resume(
            &session_id,
            payload.action_id.as_deref(),
            payload.value.as_ref(),
            "global",
        )
        .await
    {
        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
        Err((code, msg, err_code)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::NOT_FOUND),
            Json(json!({ "error": msg, "code": err_code })),
        )
            .into_response(),
    }
}

pub async fn hypa_cancel_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    state.hypa_executor.cancel(&session_id, "global").await;
    Json(json!({ "success": true }))
}

pub async fn vector_cache_get_handler(State(state): State<AppState>) -> impl IntoResponse {
    let count = state.vector_manager.count().await;
    Json(json!({ "cachedVectors": count, "success": true }))
}
