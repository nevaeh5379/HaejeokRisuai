use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::models::StorageError;
use crate::postgres::PostgresStorage;
use crate::traits::ServerStorage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "connectionString", default)]
    pub connection_string: String,
    #[serde(rename = "backupConnectionString", default)]
    pub backup_connection_string: Option<String>,
}

#[derive(Clone)]
pub struct StorageManager {
    save_path: PathBuf,
    config: Arc<RwLock<DatabaseConfig>>,
    active_storage: Arc<RwLock<Option<Arc<dyn ServerStorage>>>>,
}

impl StorageManager {
    pub async fn init(save_path: impl AsRef<Path>) -> Self {
        let save_path = save_path.as_ref().to_path_buf();
        let config_file = save_path.join("__postgres_config.json");

        let env_conn = std::env::var("RISUAI_POSTGRES_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_default();
        let env_enabled = std::env::var("RISUAI_POSTGRES_ENABLED")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(!env_conn.is_empty());

        let mut config = DatabaseConfig {
            enabled: env_enabled,
            connection_string: env_conn,
            backup_connection_string: None,
        };

        if config.connection_string.is_empty() && config_file.exists() {
            if let Ok(data) = tokio::fs::read_to_string(&config_file).await {
                if let Ok(file_cfg) = serde_json::from_str::<DatabaseConfig>(&data) {
                    config = file_cfg;
                }
            }
        }

        let mut storage_instance: Option<Arc<dyn ServerStorage>> = None;
        if config.enabled && !config.connection_string.is_empty() {
            let mut pg = PostgresStorage::new(&config.connection_string, true);
            if pg.connect().await.is_ok() && pg.initialize().await.is_ok() {
                storage_instance = Some(Arc::new(pg));
            }
        }

        Self {
            save_path,
            config: Arc::new(RwLock::new(config)),
            active_storage: Arc::new(RwLock::new(storage_instance)),
        }
    }

    pub async fn get_config(&self) -> DatabaseConfig {
        self.config.read().await.clone()
    }

    pub async fn is_storage_ready(&self) -> bool {
        let act = self.active_storage.read().await;
        act.as_ref().map(|s| s.is_enabled()).unwrap_or(false)
    }

    pub async fn get_storage(&self) -> Result<Arc<dyn ServerStorage>, StorageError> {
        let act = self.active_storage.read().await;
        act.clone().ok_or_else(|| {
            StorageError::Unavailable("Storage not initialized or unavailable".to_string())
        })
    }

    pub async fn update_config(&self, new_config: DatabaseConfig) -> Result<(), StorageError> {
        let mut pg = PostgresStorage::new(&new_config.connection_string, new_config.enabled);
        if new_config.enabled {
            pg.connect().await?;
            pg.initialize().await?;
        }

        let json = serde_json::to_string_pretty(&new_config)
            .map_err(|e| StorageError::Database(e.to_string()))?;
        let cfg_path = self.save_path.join("__postgres_config.json");
        tokio::fs::write(&cfg_path, json)
            .await
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut cfg_lock = self.config.write().await;
        *cfg_lock = new_config;

        let mut act_lock = self.active_storage.write().await;
        if pg.is_enabled() {
            *act_lock = Some(Arc::new(pg));
        } else {
            *act_lock = None;
        }

        Ok(())
    }
}
