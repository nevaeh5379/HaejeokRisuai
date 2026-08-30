use base64::prelude::*;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use reqwest::Client;
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
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::sleep;

struct NodeProcessGuard {
    child: Child,
    _temp_dir: TempDir,
    pub base_url: String,
}

impl Drop for NodeProcessGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn get_available_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind to random port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

fn generate_test_jwt() -> (String, Value) {
    let signing_key = SigningKey::random(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let point = verifying_key.to_encoded_point(false);

    let x_b64 = BASE64_URL_SAFE_NO_PAD.encode(point.x().unwrap());
    let y_b64 = BASE64_URL_SAFE_NO_PAD.encode(point.y().unwrap());

    let jwk = json!({
        "kty": "EC",
        "crv": "P-256",
        "x": x_b64,
        "y": y_b64,
    });

    let header_json = json!({ "alg": "ES256", "typ": "JWT" });
    let header_b64 = BASE64_URL_SAFE_NO_PAD.encode(header_json.to_string());

    let exp = chrono::Utc::now().timestamp() + 3600;
    let payload_json = json!({
        "exp": exp,
        "pub": jwk
    });
    let payload_b64 = BASE64_URL_SAFE_NO_PAD.encode(payload_json.to_string());

    let signed_content = format!("{}.{}", header_b64, payload_b64);
    let signature: p256::ecdsa::Signature = signing_key.sign(signed_content.as_bytes());
    let sig_b64 = BASE64_URL_SAFE_NO_PAD.encode(signature.to_bytes());

    let token = format!("{}.{}.{}", header_b64, payload_b64, sig_b64);
    (token, jwk)
}

async fn start_node_server() -> Option<NodeProcessGuard> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../../../..");
    let server_cjs = manifest_dir.join("../../../../server/node/server.cjs");
    if !server_cjs.exists() {
        panic!(
            "Node server entrypoint is missing: {}",
            server_cjs.display()
        );
    }

    let temp_dir = tempfile::tempdir().expect("Failed to create node temp dir");
    let save_path = temp_dir.path().join("save");
    let port = get_available_port();

    let mut child = match Command::new("node")
        .arg(&server_cjs)
        .current_dir(&repo_root)
        .env("PORT", port.to_string())
        .env("NODE_ENV", "test")
        .env("RISU_SAVE_PATH", &save_path)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => panic!("Failed to start Node compatibility server: {error}"),
    };

    let base_url = format!("http://127.0.0.1:{}", port);
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();

    // Poll health endpoint
    let mut ready = false;
    for _ in 0..50 {
        sleep(Duration::from_millis(100)).await;
        if let Ok(resp) = client.get(format!("{}/api/health", base_url)).send().await {
            if resp.status().is_success() {
                ready = true;
                break;
            }
        }
    }

    if !ready {
        let status = child.try_wait().ok().flatten();
        let _ = child.kill();
        let _ = child.wait();
        panic!("Node compatibility server failed to become ready; exit status: {status:?}");
    }

    Some(NodeProcessGuard {
        child,
        _temp_dir: temp_dir,
        base_url,
    })
}

async fn start_rust_server() -> (String, TempDir) {
    let temp_dir = tempfile::tempdir().expect("Failed to create rust temp dir");
    let save_path = temp_dir.path().to_path_buf();
    let port = get_available_port();

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
        port,
    };

    let router = build_router(state);
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .unwrap();

    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    let base_url = format!("http://127.0.0.1:{}", port);
    (base_url, temp_dir)
}

#[tokio::test]
async fn test_real_differential_node_vs_rust_health_and_auth() {
    let node_guard = match start_node_server().await {
        Some(g) => g,
        None => {
            eprintln!("Skipping Node vs Rust differential test: Node runtime unavailable");
            return;
        }
    };
    let (rust_url, _rust_temp) = start_rust_server().await;
    let client = Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    // 1. Health check
    let node_resp = client
        .get(format!("{}/api/health", node_guard.base_url))
        .send()
        .await
        .unwrap();
    let rust_resp = client
        .get(format!("{}/api/health", rust_url))
        .send()
        .await
        .unwrap();

    assert_eq!(node_resp.status(), rust_resp.status());
    let node_json: Value = node_resp.json().await.unwrap();
    let rust_json: Value = rust_resp.json().await.unwrap();
    assert_eq!(node_json["status"], rust_json["status"]);

    // 2. Test auth (unauthenticated state)
    let node_auth = client
        .get(format!("{}/api/test_auth", node_guard.base_url))
        .send()
        .await
        .unwrap();
    let rust_auth = client
        .get(format!("{}/api/test_auth", rust_url))
        .send()
        .await
        .unwrap();

    assert_eq!(node_auth.status(), rust_auth.status());
    let node_auth_json: Value = node_auth.json().await.unwrap();
    let rust_auth_json: Value = rust_auth.json().await.unwrap();
    assert_eq!(node_auth_json["status"], rust_auth_json["status"]);

    // 3. Crypto endpoint
    let crypto_payload = json!({ "data": "noble_differential_verification" });
    let node_crypto = client
        .post(format!("{}/api/crypto", node_guard.base_url))
        .json(&crypto_payload)
        .send()
        .await
        .unwrap();
    let rust_crypto = client
        .post(format!("{}/api/crypto", rust_url))
        .json(&crypto_payload)
        .send()
        .await
        .unwrap();

    assert_eq!(node_crypto.status(), rust_crypto.status());
    let node_crypto_text = node_crypto.text().await.unwrap();
    let rust_crypto_text = rust_crypto.text().await.unwrap();
    assert_eq!(node_crypto_text, rust_crypto_text);
}

#[tokio::test]
async fn test_real_differential_unauthorized_behavior() {
    let node_guard = match start_node_server().await {
        Some(g) => g,
        None => {
            eprintln!("Skipping Node vs Rust differential test: Node runtime unavailable");
            return;
        }
    };
    let (rust_url, _rust_temp) = start_rust_server().await;
    let client = Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    // 1. Unauthenticated request to /api/db-config returns 400 No auth header
    let node_cfg = client
        .get(format!("{}/api/db-config", node_guard.base_url))
        .send()
        .await
        .unwrap();
    let rust_cfg = client
        .get(format!("{}/api/db-config", rust_url))
        .send()
        .await
        .unwrap();

    assert_eq!(node_cfg.status(), rust_cfg.status());
    let node_json: Value = node_cfg.json().await.unwrap();
    let rust_json: Value = rust_cfg.json().await.unwrap();
    assert_eq!(node_json["error"], rust_json["error"]);

    // 2. Unauthenticated request to /api/tokenize-count returns 400 No auth header
    let node_token = client
        .post(format!("{}/api/tokenize-count", node_guard.base_url))
        .json(&json!({ "texts": ["test"], "encoding": "cl100k_base" }))
        .send()
        .await
        .unwrap();
    let rust_token = client
        .post(format!("{}/api/tokenize-count", rust_url))
        .json(&json!({ "texts": ["test"], "encoding": "cl100k_base" }))
        .send()
        .await
        .unwrap();

    assert_eq!(node_token.status(), rust_token.status());
    let node_t_json: Value = node_token.json().await.unwrap();
    let rust_t_json: Value = rust_token.json().await.unwrap();
    assert_eq!(node_t_json["error"], rust_t_json["error"]);
}

#[tokio::test]
async fn test_real_differential_authenticated_flow_with_jwt() {
    let node_guard = match start_node_server().await {
        Some(g) => g,
        None => {
            eprintln!("Skipping Node vs Rust differential test: Node runtime unavailable");
            return;
        }
    };
    let (rust_url, _rust_temp) = start_rust_server().await;
    let client = Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let (jwt_token, jwk) = generate_test_jwt();

    // Register public key via login
    let login_payload = json!({
        "password": "",
        "publicKey": jwk
    });

    let node_login = client
        .post(format!("{}/api/login", node_guard.base_url))
        .json(&login_payload)
        .send()
        .await
        .unwrap();
    let rust_login = client
        .post(format!("{}/api/login", rust_url))
        .json(&login_payload)
        .send()
        .await
        .unwrap();

    assert_eq!(node_login.status(), rust_login.status());

    // Test auth with token
    let node_auth = client
        .get(format!(
            "{}/api/test_auth?auth={}",
            node_guard.base_url, jwt_token
        ))
        .send()
        .await
        .unwrap();
    let rust_auth = client
        .get(format!("{}/api/test_auth?auth={}", rust_url, jwt_token))
        .send()
        .await
        .unwrap();

    assert_eq!(node_auth.status(), rust_auth.status());
    let node_auth_json: Value = node_auth.json().await.unwrap();
    let rust_auth_json: Value = rust_auth.json().await.unwrap();
    assert_eq!(node_auth_json["status"], rust_auth_json["status"]);
}
