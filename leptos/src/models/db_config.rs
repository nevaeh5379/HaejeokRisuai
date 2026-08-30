use serde::{Deserialize, Serialize};

/// GET `/api/db-config` response shape from the backend
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseConfigResponse {
    pub enabled: bool,
    #[serde(rename = "connectionString", default)]
    pub connection_string: String,
    #[serde(
        rename = "backupConnectionString",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub backup_connection_string: Option<String>,
    #[serde(default)]
    pub ready: bool,
}

/// POST `/api/db-config/test` request payload
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestDatabasePayload {
    #[serde(rename = "connectionString")]
    pub connection_string: String,
}

/// POST `/api/db-config/test` response shape
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestDatabaseResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(rename = "latencyMs", default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// POST `/api/db-config` update payload
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateDatabaseConfigPayload {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "connectionString", default)]
    pub connection_string: String,
    #[serde(
        rename = "backupConnectionString",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub backup_connection_string: Option<String>,
}

/// POST `/api/db-config` response shape
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateDatabaseConfigResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// POST `/api/db-config/retry` response shape
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryDatabaseConfigResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_config_response_serde() {
        let json_str = r#"{
            "enabled": true,
            "connectionString": "postgresql://risuai:*****@localhost:5432/risuai",
            "backupConnectionString": null,
            "ready": false
        }"#;

        let resp: DatabaseConfigResponse =
            serde_json::from_str(json_str).expect("should parse db config response");
        assert!(resp.enabled);
        assert_eq!(
            resp.connection_string,
            "postgresql://risuai:*****@localhost:5432/risuai"
        );
        assert_eq!(resp.backup_connection_string, None);
        assert!(!resp.ready);
    }

    #[test]
    fn test_test_db_payload_and_response_serde() {
        let payload = TestDatabasePayload {
            connection_string: "postgresql://user:pass@localhost:5432/testdb".to_string(),
        };
        let json_str = serde_json::to_string(&payload).unwrap();
        assert!(json_str.contains("connectionString"));

        let ok_res = r#"{"success":true,"latencyMs":42}"#;
        let parsed_ok: TestDatabaseResponse = serde_json::from_str(ok_res).unwrap();
        assert!(parsed_ok.success);
        assert_eq!(parsed_ok.latency_ms, Some(42));
        assert_eq!(parsed_ok.error, None);

        let err_res = r#"{"success":false,"error":"connection refused"}"#;
        let parsed_err: TestDatabaseResponse = serde_json::from_str(err_res).unwrap();
        assert!(!parsed_err.success);
        assert_eq!(parsed_err.latency_ms, None);
        assert_eq!(parsed_err.error, Some("connection refused".to_string()));
    }

    #[test]
    fn test_update_db_config_payload_and_response_serde() {
        let payload = UpdateDatabaseConfigPayload {
            enabled: true,
            connection_string: "postgresql://u:p@db.internal:5432/main".to_string(),
            backup_connection_string: Some("postgresql://u:p@db-backup.internal:5432/main".to_string()),
        };
        let json_str = serde_json::to_string(&payload).unwrap();
        assert!(json_str.contains("backupConnectionString"));

        let ok_res = r#"{"success":true}"#;
        let parsed_ok: UpdateDatabaseConfigResponse = serde_json::from_str(ok_res).unwrap();
        assert!(parsed_ok.success);

        let err_res = r#"{"success":false,"error":"Failed to connect to database"}"#;
        let parsed_err: UpdateDatabaseConfigResponse = serde_json::from_str(err_res).unwrap();
        assert!(!parsed_err.success);
        assert_eq!(parsed_err.error, Some("Failed to connect to database".to_string()));
    }

    #[test]
    fn test_retry_db_config_response_serde() {
        let ok_res = r#"{"success":true}"#;
        let parsed_ok: RetryDatabaseConfigResponse = serde_json::from_str(ok_res).unwrap();
        assert!(parsed_ok.success);
    }
}
