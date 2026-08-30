use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::models::{StorageError, SyncPayload};
use crate::traits::ServerStorage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "connectionString", default)]
    pub connection_string: String,
    #[serde(rename = "syncIntervalSec", default = "default_sync_interval")]
    pub sync_interval_sec: u64,
}

fn default_sync_interval() -> u64 {
    300
}

#[derive(Clone)]
pub struct BackupManager {
    primary: Arc<dyn ServerStorage>,
    backup: Option<Arc<dyn ServerStorage>>,
    queue_tx: Option<mpsc::Sender<SyncPayload>>,
}

impl BackupManager {
    pub fn new(primary: Arc<dyn ServerStorage>, backup: Option<Arc<dyn ServerStorage>>) -> Self {
        let queue_tx = if let Some(ref b) = backup {
            let (tx, mut rx) = mpsc::channel::<SyncPayload>(256);
            let backup_clone = b.clone();
            tokio::spawn(async move {
                while let Some(payload) = rx.recv().await {
                    let _ = backup_clone.sync(payload).await;
                }
            });
            Some(tx)
        } else {
            None
        };

        Self {
            primary,
            backup,
            queue_tx,
        }
    }

    pub async fn enqueue_sync(&self, payload: SyncPayload) {
        if let Some(tx) = &self.queue_tx {
            let _ = tx.send(payload).await;
        }
    }

    pub async fn sync_full_snapshot(&self) -> Result<(), StorageError> {
        if let Some(backup) = &self.backup {
            let snapshot = self.primary.export_snapshot().await?;
            backup.import_snapshot(snapshot).await?;
        }
        Ok(())
    }
}
