use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::fs::LocalFsStorage;
use crate::s3::S3AssetStorage;

pub struct MigrationProgress {
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub in_flight: usize,
}

pub async fn migrate_local_to_s3(
    local_fs: &LocalFsStorage,
    s3: &S3AssetStorage,
    concurrency: usize,
) -> Result<MigrationProgress, String> {
    let keys = local_fs.list("").await.map_err(|e| e.to_string())?;
    let total = keys.len();
    let completed = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));

    let mut tasks = Vec::with_capacity(total);
    for key in keys {
        let sem = semaphore.clone();
        let local = local_fs.clone();
        let s3_storage = s3.clone();
        let c = completed.clone();
        let f = failed.clone();

        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            match local.read(&key).await {
                Ok(Some(res)) if s3_storage.write(&key, &res.data).await.is_ok() => {
                    c.fetch_add(1, Ordering::Relaxed);
                }
                _ => {
                    f.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }

    for task in tasks {
        let _ = task.await;
    }

    Ok(MigrationProgress {
        total,
        completed: completed.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
        in_flight: 0,
    })
}

pub async fn rollback_s3_to_local(
    local_fs: &LocalFsStorage,
    s3: &S3AssetStorage,
    concurrency: usize,
) -> Result<MigrationProgress, String> {
    let keys = s3.list("").await.map_err(|e| e.to_string())?;
    let total = keys.len();
    let completed = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));

    let mut tasks = Vec::with_capacity(total);
    for key in keys {
        let sem = semaphore.clone();
        let local = local_fs.clone();
        let s3_storage = s3.clone();
        let c = completed.clone();
        let f = failed.clone();

        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            match s3_storage.read(&key).await {
                Ok(Some(res)) if local.write(&key, &res.data).await.is_ok() => {
                    c.fetch_add(1, Ordering::Relaxed);
                }
                _ => {
                    f.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }

    for task in tasks {
        let _ = task.await;
    }

    Ok(MigrationProgress {
        total,
        completed: completed.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
        in_flight: 0,
    })
}
