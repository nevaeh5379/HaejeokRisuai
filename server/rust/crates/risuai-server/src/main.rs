use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

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

#[derive(Parser, Debug)]
#[command(
    name = "risuai-server",
    version,
    about = "RisuAI Production Rust Server Backend"
)]
struct Args {
    #[arg(short, long, env = "PORT", default_value_t = 8000)]
    port: u16,

    #[arg(short = 'H', long, env = "HOST", default_value = "0.0.0.0")]
    host: String,

    #[arg(short, long, env = "RISU_SAVE_PATH", default_value = "./save")]
    save_path: PathBuf,

    #[arg(short, long, env = "RISU_DIST_PATH", default_value = "./dist")]
    dist_path: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let args = Args::parse();

    tracing::info!("Initializing RisuAI Rust server backend...");
    tracing::info!("Save directory: {:?}", args.save_path);

    tokio::fs::create_dir_all(&args.save_path).await?;

    let auth_state = AuthState::init(&args.save_path).await?;
    let asset_manager = AssetStorageManager::init(&args.save_path).await;
    let storage_manager = StorageManager::init(&args.save_path).await;

    let vector_dir = args.save_path.join("vector_index");
    let vector_manager = VectorIndexManager::new(Some(vector_dir));

    let realtime_hub = RealtimeEventHub::new(512);
    let hub_clone = realtime_hub.clone();

    let on_job_event = Arc::new(
        move |phase: &str,
              job: risuai_core::model_jobs::ModelJobRecord,
              client_id: Option<String>| {
            let hub = hub_clone.clone();
            let phase_str = phase.to_string();
            tokio::spawn(async move {
                hub.broadcast(
                    "model-job",
                    serde_json::json!({
                        "phase": phase_str,
                        "job": job,
                        "sourceClientId": client_id,
                    }),
                )
                .await;
            });
        },
    );

    let model_jobs = ModelJobManager::init(&args.save_path, Some(on_job_event)).await?;
    let provider_executor = ProviderExecutor::new();
    let hypa_executor = HypaMemoryExecutor::new();

    let dist_dir = if args.dist_path.exists() {
        Some(args.dist_path)
    } else {
        None
    };

    let state = AppState {
        auth_state,
        asset_manager,
        storage_manager,
        vector_manager,
        model_jobs,
        realtime_hub,
        provider_executor,
        hypa_executor,
        save_dir: args.save_path,
        dist_dir,
        port: args.port,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = build_router(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    tracing::info!("Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("Graceful shutdown initiated...");
}
