use axum::body::Body;
use axum::http::{Request, StatusCode};
use risuai_assets::manager::AssetStorageManager;
use risuai_core::auth::AuthState;
use risuai_core::hypa_memory::HypaMemoryExecutor;
use risuai_core::model_jobs::ModelJobManager;
use risuai_core::provider_executor::ProviderExecutor;
use risuai_core::realtime::RealtimeEventHub;
use risuai_core::vector::VectorIndexManager;
use risuai_server::routes::build_router;
use risuai_server::state::AppState;
use risuai_storage::factory::StorageManager;
use tempfile::tempdir;
use tower::ServiceExt;

async fn setup_test_app() -> axum::Router {
    let dir = tempdir().unwrap();
    let save_path = dir.path().to_path_buf();

    let auth_state = AuthState::init(&save_path).await.unwrap();
    let asset_manager = AssetStorageManager::init(&save_path).await;
    let storage_manager = StorageManager::init(&save_path).await;
    let vector_manager = VectorIndexManager::new(None);
    let realtime_hub = RealtimeEventHub::new(128);
    let model_jobs = ModelJobManager::init(&save_path, None).await.unwrap();
    let provider_executor = ProviderExecutor::new();
    let hypa_executor = HypaMemoryExecutor::new();

    let state = AppState {
        auth_state,
        asset_manager,
        storage_manager,
        vector_manager,
        model_jobs,
        realtime_hub,
        provider_executor,
        hypa_executor,
        save_dir: save_path,
        dist_dir: None,
        port: 8000,
    };

    build_router(state)
}

#[tokio::test]
async fn test_health_endpoint() {
    let app = setup_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn test_test_auth_endpoint() {
    let app = setup_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/test_auth")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(json["status"], "unset");
}

#[tokio::test]
async fn test_crypto_endpoint() {
    let app = setup_test_app().await;

    let payload = serde_json::json!({ "data": "noble" });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/crypto")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let hash_str = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert_eq!(hash_str, risuai_core::crypto::sha256_hex(b"noble"));
}

#[tokio::test]
async fn test_unconfigured_storage_recovery_guard() {
    let app = setup_test_app().await;

    let payload = serde_json::json!({
        "texts": ["Hello", "World of RisuAI"]
    });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tokenize-count")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(json["code"], "storage_unavailable");
}
