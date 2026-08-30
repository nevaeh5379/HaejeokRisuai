use crate::api::client::{ApiClient, Result};
use serde_json::Value;

impl ApiClient {
    /// Builds the URL for reading an asset from `/api/read`
    pub fn get_asset_url(&self, path: &str, thumbnail: bool) -> String {
        let base = self.base_url();
        let thumb_param = if thumbnail { "?thumbnail=true" } else { "" };
        format!(
            "{}/api/read/{}{}",
            base,
            path.trim_start_matches('/'),
            thumb_param
        )
    }

    /// Calls GET `/api/list` to retrieve assets catalog
    pub async fn list_assets(&self) -> Result<Value> {
        self.get("/api/list").await
    }
}
