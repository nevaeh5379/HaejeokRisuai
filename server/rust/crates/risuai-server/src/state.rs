use risuai_assets::manager::AssetStorageManager;
use risuai_core::auth::AuthState;
use risuai_core::hypa_memory::HypaMemoryExecutor;
use risuai_core::model_jobs::ModelJobManager;
use risuai_core::provider_executor::ProviderExecutor;
use risuai_core::realtime::RealtimeEventHub;
use risuai_core::vector::VectorIndexManager;
use risuai_storage::factory::StorageManager;
use std::path::PathBuf;

#[derive(Clone)]
pub struct AppState {
    pub auth_state: AuthState,
    pub asset_manager: AssetStorageManager,
    pub storage_manager: StorageManager,
    pub vector_manager: VectorIndexManager,
    pub model_jobs: ModelJobManager,
    pub realtime_hub: RealtimeEventHub,
    pub provider_executor: ProviderExecutor,
    pub hypa_executor: HypaMemoryExecutor,
    pub save_dir: PathBuf,
    pub dist_dir: Option<PathBuf>,
    pub port: u16,
}
