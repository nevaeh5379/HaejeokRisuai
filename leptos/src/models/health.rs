use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageHealth {
    pub status: String,
    pub vendor: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub storage: StorageHealth,
}

impl HealthResponse {
    pub fn is_ready(&self) -> bool {
        self.status == "ok" && self.storage.status == "ready"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_response_serde() {
        let json_str = r#"{
            "status": "ok",
            "storage": {
                "status": "ready",
                "vendor": "sqlite"
            }
        }"#;
        let resp: HealthResponse =
            serde_json::from_str(json_str).expect("should deserialize HealthResponse");
        assert_eq!(resp.status, "ok");
        assert_eq!(resp.storage.status, "ready");
        assert_eq!(resp.storage.vendor, "sqlite");
        assert!(resp.is_ready());
    }
}
