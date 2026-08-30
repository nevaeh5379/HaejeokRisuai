use crate::api::client::{ApiClient, Result};
use crate::models::health::HealthResponse;

impl ApiClient {
    /// Calls the existing Rust backend endpoint GET `/api/health`
    pub async fn get_health(&self) -> Result<HealthResponse> {
        self.get("/api/health").await
    }
}
