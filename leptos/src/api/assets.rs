use crate::api::client::{ApiClient, BinaryResponse, Result};
use serde_json::Value;

/// Builds the path and query string for `/api/read`.
///
/// Credentials/auth are intentionally excluded from the URL and must be passed via HTTP headers.
pub fn build_read_asset_path(
    path: &str,
    thumbnail: bool,
    width: Option<u32>,
    height: Option<u32>,
) -> String {
    let mut query = format!("path={}", urlencoding::encode(path));
    if thumbnail {
        query.push_str("&thumbnail=true");
    }
    if let Some(w) = width {
        query.push_str(&format!("&width={}", w));
    }
    if let Some(h) = height {
        query.push_str(&format!("&height={}", h));
    }
    format!("/api/read?{}", query)
}

impl ApiClient {
    /// Reads a binary asset from `/api/read` using authenticated binary fetch.
    pub async fn read_asset(
        &self,
        path: &str,
        thumbnail: bool,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<BinaryResponse> {
        let request_path = build_read_asset_path(path, thumbnail, width, height);
        self.get_binary(&request_path).await
    }

    /// Calls GET `/api/list` to retrieve assets catalog
    pub async fn list_assets(&self) -> Result<Value> {
        self.get("/api/list").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_read_asset_path_basic() {
        let path = build_read_asset_path("images/sample.png", false, None, None);
        assert_eq!(path, "/api/read?path=images%2Fsample.png");
    }

    #[test]
    fn test_build_read_asset_path_thumbnail_and_dimensions() {
        let path = build_read_asset_path("chars/avatar 1.png", true, Some(200), Some(300));
        assert_eq!(
            path,
            "/api/read?path=chars%2Favatar%201.png&thumbnail=true&width=200&height=300"
        );
    }
}
