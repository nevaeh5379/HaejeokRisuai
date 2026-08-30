use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::azure_sql::{AzureSqlAssetConfig, AzureSqlAssetStorage};
use crate::fs::{AssetReadResult, LocalFsStorage};
use crate::s3::{S3AssetStorage, S3Config};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageType {
    Local,
    S3,
    AzureSql,
}

#[derive(Clone)]
pub struct AssetStorageManager {
    #[allow(dead_code)]
    save_path: PathBuf,
    local: LocalFsStorage,
    s3_storage: Arc<RwLock<Option<S3AssetStorage>>>,
    azure_storage: Arc<RwLock<Option<AzureSqlAssetStorage>>>,
    active_type: Arc<RwLock<StorageType>>,
}

impl AssetStorageManager {
    pub async fn init(save_path: impl AsRef<Path>) -> Self {
        let save_path = save_path.as_ref().to_path_buf();
        let local = LocalFsStorage::new(&save_path);

        let mut s3_storage = None;
        let mut azure_storage = None;
        let mut active_type = StorageType::Local;

        // Check S3 config
        let s3_config_path = save_path.join("__s3_config.json");
        if s3_config_path.exists() {
            if let Ok(data) = tokio::fs::read_to_string(&s3_config_path).await {
                if let Ok(cfg) = serde_json::from_str::<S3Config>(&data) {
                    if cfg.enabled {
                        let s3 = S3AssetStorage::new(cfg);
                        if s3.init().await.is_ok() {
                            s3_storage = Some(s3);
                            active_type = StorageType::S3;
                        }
                    }
                }
            }
        }

        // Check Azure SQL asset config
        let azure_config_path = save_path.join("__azure_asset_config.json");
        if azure_config_path.exists() {
            if let Ok(data) = tokio::fs::read_to_string(&azure_config_path).await {
                if let Ok(cfg) = serde_json::from_str::<AzureSqlAssetConfig>(&data) {
                    if cfg.enabled {
                        let az = AzureSqlAssetStorage::new(cfg, &save_path);
                        if az.init().await.is_ok() {
                            azure_storage = Some(az);
                            active_type = StorageType::AzureSql;
                        }
                    }
                }
            }
        }

        Self {
            save_path,
            local,
            s3_storage: Arc::new(RwLock::new(s3_storage)),
            azure_storage: Arc::new(RwLock::new(azure_storage)),
            active_type: Arc::new(RwLock::new(active_type)),
        }
    }

    pub async fn get_active_type(&self) -> StorageType {
        self.active_type.read().await.clone()
    }

    pub async fn get_storage_type(&self) -> String {
        match self.get_active_type().await {
            StorageType::Local => "fs".to_string(),
            StorageType::S3 => "s3".to_string(),
            StorageType::AzureSql => "azuresql".to_string(),
        }
    }

    pub fn local(&self) -> &LocalFsStorage {
        &self.local
    }

    pub fn local_fs(&self) -> &LocalFsStorage {
        &self.local
    }

    pub async fn s3(&self) -> Option<S3AssetStorage> {
        self.s3_storage.read().await.clone()
    }

    pub async fn get_s3_config(&self) -> Option<S3Config> {
        let guard = self.s3_storage.read().await;
        guard.as_ref().map(|s| s.config().clone())
    }

    pub async fn set_s3_config(&self, mut config: S3Config, enable: bool) -> Result<(), String> {
        config.enabled = enable;
        let config_path = self.save_path.join("__s3_config.json");
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        tokio::fs::write(&config_path, data)
            .await
            .map_err(|e| e.to_string())?;

        if enable {
            let s3 = S3AssetStorage::new(config);
            s3.init().await.map_err(|e| e.to_string())?;
            let mut guard = self.s3_storage.write().await;
            *guard = Some(s3);
            let mut active = self.active_type.write().await;
            *active = StorageType::S3;
        } else {
            let mut guard = self.s3_storage.write().await;
            *guard = None;
            let mut active = self.active_type.write().await;
            *active = StorageType::Local;
        }
        Ok(())
    }

    pub async fn get_db_hash(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert("assets".to_string(), "asset_hash_ok".to_string());
        map
    }

    pub async fn resolve_db(&self, _keep: &str) -> Result<(), String> {
        Ok(())
    }

    pub async fn azure(&self) -> Option<AzureSqlAssetStorage> {
        self.azure_storage.read().await.clone()
    }

    pub async fn read(&self, hex_or_key: &str) -> std::io::Result<Option<AssetReadResult>> {
        let active = self.get_active_type().await;
        match active {
            StorageType::S3 => {
                if let Some(s3) = self.s3().await {
                    if let Ok(Some(res)) = s3.read(hex_or_key).await {
                        return Ok(Some(res));
                    }
                }
                self.local.read(hex_or_key).await
            }
            StorageType::AzureSql => {
                if let Some(az) = self.azure().await {
                    if let Ok(Some(res)) = az.read(hex_or_key).await {
                        return Ok(Some(res));
                    }
                }
                self.local.read(hex_or_key).await
            }
            StorageType::Local => self.local.read(hex_or_key).await,
        }
    }

    pub async fn read_thumbnail(
        &self,
        hex_or_key: &str,
        width: u32,
        height: u32,
    ) -> std::io::Result<Option<AssetReadResult>> {
        let active = self.get_active_type().await;
        match active {
            StorageType::S3 => {
                if let Some(s3) = self.s3().await {
                    if let Ok(Some(res)) = s3.read_thumbnail(hex_or_key, width, height).await {
                        return Ok(Some(res));
                    }
                }
                self.local.read_thumbnail(hex_or_key, width, height).await
            }
            StorageType::AzureSql => {
                if let Some(az) = self.azure().await {
                    if let Ok(Some(res)) = az.read_thumbnail(hex_or_key, width, height).await {
                        return Ok(Some(res));
                    }
                }
                self.local.read_thumbnail(hex_or_key, width, height).await
            }
            StorageType::Local => self.local.read_thumbnail(hex_or_key, width, height).await,
        }
    }

    pub async fn write(&self, hex_or_key: &str, content: &[u8]) -> std::io::Result<()> {
        let active = self.get_active_type().await;
        match active {
            StorageType::S3 => {
                if let Some(s3) = self.s3().await {
                    s3.write(hex_or_key, content).await?;
                } else {
                    self.local.write(hex_or_key, content).await?;
                }
            }
            StorageType::AzureSql => {
                if let Some(az) = self.azure().await {
                    az.write(hex_or_key, content).await?;
                } else {
                    self.local.write(hex_or_key, content).await?;
                }
            }
            StorageType::Local => {
                self.local.write(hex_or_key, content).await?;
            }
        }
        Ok(())
    }

    pub async fn delete(&self, hex_or_key: &str) -> std::io::Result<()> {
        let active = self.get_active_type().await;
        match active {
            StorageType::S3 => {
                if let Some(s3) = self.s3().await {
                    let _ = s3.delete(hex_or_key).await;
                }
            }
            StorageType::AzureSql => {
                if let Some(az) = self.azure().await {
                    let _ = az.delete(hex_or_key).await;
                }
            }
            StorageType::Local => {}
        }
        self.local.delete(hex_or_key).await
    }

    pub async fn list(&self, prefix: &str) -> std::io::Result<Vec<String>> {
        let active = self.get_active_type().await;
        match active {
            StorageType::S3 => {
                if let Some(s3) = self.s3().await {
                    s3.list(prefix).await
                } else {
                    self.local.list(prefix).await
                }
            }
            StorageType::AzureSql => {
                if let Some(az) = self.azure().await {
                    az.list(prefix).await
                } else {
                    self.local.list(prefix).await
                }
            }
            StorageType::Local => self.local.list(prefix).await,
        }
    }
}
