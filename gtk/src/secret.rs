use std::sync::Arc;

use async_channel::Receiver;
use async_trait::async_trait;
use thiserror::Error;
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};
use zeroize::Zeroizing;

const APPLICATION_ATTRIBUTE: (&str, &str) = ("application", "io.risuai.RisuAI.Native");

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("비밀 저장소 비동기 런타임을 만들지 못했습니다: {0}")]
    Runtime(#[source] std::io::Error),
    #[error("데스크톱 비밀 저장소 작업에 실패했습니다: {0}")]
    Backend(String),
    #[error("저장된 비밀키가 올바른 UTF-8이 아닙니다.")]
    InvalidUtf8,
    #[error("비밀 저장소 작업이 완료되기 전에 중단되었습니다.")]
    Interrupted,
}

#[async_trait]
trait SecretBackend: Send + Sync {
    async fn load(&self, credential_id: &str) -> Result<Option<Zeroizing<String>>, SecretError>;
    async fn store(
        &self,
        credential_id: &str,
        secret: Zeroizing<String>,
    ) -> Result<(), SecretError>;
    async fn delete(&self, credential_id: &str) -> Result<(), SecretError>;
}

struct DesktopSecretBackend;

#[async_trait]
impl SecretBackend for DesktopSecretBackend {
    async fn load(&self, credential_id: &str) -> Result<Option<Zeroizing<String>>, SecretError> {
        let keyring = oo7::Keyring::new()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        keyring
            .unlock()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        let attributes = attributes(credential_id);
        let Some(item) = keyring
            .search_items(&attributes)
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        let secret = item
            .secret()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        let secret =
            String::from_utf8(secret.as_bytes().to_vec()).map_err(|_| SecretError::InvalidUtf8)?;
        Ok(Some(Zeroizing::new(secret)))
    }

    async fn store(
        &self,
        credential_id: &str,
        secret: Zeroizing<String>,
    ) -> Result<(), SecretError> {
        let keyring = oo7::Keyring::new()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        keyring
            .unlock()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        keyring
            .create_item(
                "RisuAI Native provider API key",
                &attributes(credential_id),
                oo7::Secret::text(secret.as_str()),
                true,
            )
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))
    }

    async fn delete(&self, credential_id: &str) -> Result<(), SecretError> {
        let keyring = oo7::Keyring::new()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        keyring
            .unlock()
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))?;
        keyring
            .delete(&attributes(credential_id))
            .await
            .map_err(|error| SecretError::Backend(error.to_string()))
    }
}

fn attributes(credential_id: &str) -> [(&str, &str); 2] {
    [APPLICATION_ATTRIBUTE, ("credential-id", credential_id)]
}

pub struct SecretStore {
    runtime: Runtime,
    backend: Arc<dyn SecretBackend>,
}

impl SecretStore {
    pub fn desktop() -> Result<Self, SecretError> {
        Self::new(Arc::new(DesktopSecretBackend))
    }

    fn new(backend: Arc<dyn SecretBackend>) -> Result<Self, SecretError> {
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(SecretError::Runtime)?;
        Ok(Self { runtime, backend })
    }

    pub fn load(
        &self,
        credential_id: String,
    ) -> Receiver<Result<Option<Zeroizing<String>>, SecretError>> {
        let (sender, receiver) = async_channel::bounded(1);
        let backend = Arc::clone(&self.backend);
        self.runtime.spawn(async move {
            let _ = sender.send(backend.load(&credential_id).await).await;
        });
        receiver
    }

    pub fn store(
        &self,
        credential_id: String,
        secret: Zeroizing<String>,
    ) -> Receiver<Result<(), SecretError>> {
        let (sender, receiver) = async_channel::bounded(1);
        let backend = Arc::clone(&self.backend);
        self.runtime.spawn(async move {
            let _ = sender
                .send(backend.store(&credential_id, secret).await)
                .await;
        });
        receiver
    }

    pub fn delete(&self, credential_id: String) -> Receiver<Result<(), SecretError>> {
        let (sender, receiver) = async_channel::bounded(1);
        let backend = Arc::clone(&self.backend);
        self.runtime.spawn(async move {
            let _ = sender.send(backend.delete(&credential_id).await).await;
        });
        receiver
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct MemoryBackend {
        values: Mutex<HashMap<String, String>>,
    }

    #[async_trait]
    impl SecretBackend for MemoryBackend {
        async fn load(
            &self,
            credential_id: &str,
        ) -> Result<Option<Zeroizing<String>>, SecretError> {
            Ok(self
                .values
                .lock()
                .unwrap()
                .get(credential_id)
                .cloned()
                .map(Zeroizing::new))
        }

        async fn store(
            &self,
            credential_id: &str,
            secret: Zeroizing<String>,
        ) -> Result<(), SecretError> {
            self.values
                .lock()
                .unwrap()
                .insert(credential_id.to_owned(), secret.to_string());
            Ok(())
        }

        async fn delete(&self, credential_id: &str) -> Result<(), SecretError> {
            self.values.lock().unwrap().remove(credential_id);
            Ok(())
        }
    }

    #[test]
    fn store_load_and_delete_are_dispatched_without_exposing_the_value() {
        let store = SecretStore::new(Arc::new(MemoryBackend::default())).unwrap();
        store
            .store("credential-1".into(), Zeroizing::new("top-secret".into()))
            .recv_blocking()
            .unwrap()
            .unwrap();
        let loaded = store
            .load("credential-1".into())
            .recv_blocking()
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(loaded.as_str(), "top-secret");
        store
            .delete("credential-1".into())
            .recv_blocking()
            .unwrap()
            .unwrap();
        assert!(
            store
                .load("credential-1".into())
                .recv_blocking()
                .unwrap()
                .unwrap()
                .is_none()
        );
    }
}
