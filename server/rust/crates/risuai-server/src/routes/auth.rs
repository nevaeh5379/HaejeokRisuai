use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct TestAuthQuery {
    pub auth: Option<String>,
}

pub async fn test_auth_handler(
    State(state): State<AppState>,
    Query(query): Query<TestAuthQuery>,
) -> impl IntoResponse {
    let password_set = state.auth_state.is_password_set().await;
    if !password_set {
        return (StatusCode::OK, Json(json!({ "status": "unset" }))).into_response();
    }

    if let Some(token) = query.auth {
        match state.auth_state.verify_request_auth(Some(&token)).await {
            Ok(_) => (StatusCode::OK, Json(json!({ "status": "success" }))).into_response(),
            Err(_) => (StatusCode::OK, Json(json!({ "status": "incorrect" }))).into_response(),
        }
    } else {
        (StatusCode::OK, Json(json!({ "status": "incorrect" }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct LoginPayload {
    pub password: Option<String>,
    #[serde(rename = "publicKey")]
    pub public_key: Option<serde_json::Value>,
}

pub async fn login_handler(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> impl IntoResponse {
    let password_set = state.auth_state.is_password_set().await;
    if !password_set {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Password not set" })),
        )
            .into_response();
    }

    let input_pw = payload.password.as_deref().unwrap_or("");
    if !state.auth_state.check_password(input_pw).await {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Password incorrect" })),
        )
            .into_response();
    }

    let mut key_hash = None;
    if let Some(pub_key) = payload.public_key {
        if let Ok(hash) = state.auth_state.add_known_key(&pub_key).await {
            key_hash = Some(hash);
        }
    }

    (
        StatusCode::OK,
        Json(json!({ "status": "success", "keyHash": key_hash })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct SetPasswordPayload {
    pub password: Option<String>,
}

pub async fn set_password_handler(
    State(state): State<AppState>,
    Json(payload): Json<SetPasswordPayload>,
) -> impl IntoResponse {
    let pw = payload.password.as_deref().unwrap_or("").trim();
    if pw.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Password cannot be empty" })),
        )
            .into_response();
    }

    match state.auth_state.set_password(pw).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct CryptoPayload {
    pub data: Option<String>,
}

pub async fn crypto_handler(Json(payload): Json<CryptoPayload>) -> impl IntoResponse {
    let data = payload.data.unwrap_or_default();
    let hash = risuai_core::crypto::sha256_hex(data.as_bytes());
    hash
}

pub async fn oauth_login_handler() -> impl IntoResponse {
    axum::response::Redirect::temporary("/").into_response()
}

pub async fn oauth_callback_handler() -> impl IntoResponse {
    axum::response::Redirect::temporary("/").into_response()
}
