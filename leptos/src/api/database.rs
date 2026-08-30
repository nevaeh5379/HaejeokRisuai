use crate::api::client::{ApiClient, Result};
use crate::models::db_config::{
    DatabaseConfigResponse, RetryDatabaseConfigResponse, TestDatabasePayload, TestDatabaseResponse,
    UpdateDatabaseConfigPayload, UpdateDatabaseConfigResponse,
};
use serde_json::Value;

impl ApiClient {
    /// Calls GET `/api/db-config` to inspect current configuration and readiness
    pub async fn get_db_config(&self) -> Result<DatabaseConfigResponse> {
        self.get("/api/db-config").await
    }

    /// Calls POST `/api/db-config/test` to test connectivity to PostgreSQL
    pub async fn test_db_config(
        &self,
        payload: &TestDatabasePayload,
    ) -> Result<TestDatabaseResponse> {
        self.post("/api/db-config/test", payload).await
    }

    /// Calls POST `/api/db-config` to update database configuration
    pub async fn update_db_config(
        &self,
        payload: &UpdateDatabaseConfigPayload,
    ) -> Result<UpdateDatabaseConfigResponse> {
        self.post("/api/db-config", payload).await
    }

    /// Calls POST `/api/db-config/retry` to retry connecting with the existing configuration
    pub async fn retry_db_config(&self) -> Result<RetryDatabaseConfigResponse> {
        self.post("/api/db-config/retry", &serde_json::json!({}))
            .await
    }

    /// Calls GET `/api/database-v2/state` to retrieve current database revision
    pub async fn get_database_state(&self) -> Result<Value> {
        self.get("/api/database-v2/state").await
    }

    /// Calls GET `/api/database-v2/tables` to inspect relational tables
    pub async fn list_tables(&self) -> Result<Value> {
        self.get("/api/database-v2/tables").await
    }

    /// Calls GET `/api/database-v2/tables/{table}/rows?limit=..&offset=..`
    pub async fn get_table_rows(&self, table: &str, limit: usize, offset: usize) -> Result<Value> {
        let path = format!(
            "/api/database-v2/tables/{}/rows?limit={}&offset={}",
            table, limit, offset
        );
        self.get(&path).await
    }
}
