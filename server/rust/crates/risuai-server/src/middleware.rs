use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::state::AppState;

const RECOVERY_API_PREFIXES: &[&str] = &[
    "/api/health",
    "/api/test_auth",
    "/api/login",
    "/api/crypto",
    "/api/set_password",
    "/api/db-config",
    "/api/postgres-config",
];

fn is_recovery_api_request(path: &str) -> bool {
    RECOVERY_API_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{}/", prefix)))
}

pub async fn recovery_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();

    if path.starts_with("/api")
        && !is_recovery_api_request(path)
        && !state.storage_manager.is_storage_ready().await
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "SQL storage is unavailable; restore the configured database connection before using application APIs.",
                "code": "storage_unavailable",
                "runtime": {
                    "status": "unconfigured",
                    "vendor": "postgres"
                }
            })),
        )
            .into_response();
    }

    next.run(req).await
}

pub async fn auth_middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();

    // Whitelisted routes that never require authentication
    if path == "/api/health"
        || path == "/api/test_auth"
        || path == "/api/login"
        || path == "/api/set_password"
        || path == "/api/crypto"
        || path.starts_with("/api/oauth")
        || (!path.starts_with("/api/") && !path.starts_with("/proxy"))
    {
        return next.run(req).await;
    }

    let auth_header = req
        .headers()
        .get("risu-auth")
        .or_else(|| req.headers().get("authorization"))
        .and_then(|v| v.to_str().ok());

    let query_auth = req.uri().query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let k = parts.next()?;
            if k == "auth" || k == "risu-auth" {
                parts.next().map(|s| s.to_string())
            } else {
                None
            }
        })
    });

    let token_candidate = auth_header.or(query_auth.as_deref());

    match token_candidate {
        Some(token) => match state.auth_state.verify_request_auth(Some(token)).await {
            Ok(_) => next.run(req).await,
            Err(_) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid Signature" })),
            )
                .into_response(),
        },
        None => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No auth header" })),
        )
            .into_response(),
    }
}
