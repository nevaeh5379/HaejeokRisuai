use base64::prelude::*;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::fs::AssetReadResult;
use crate::mime::{get_content_type, hex_to_key, is_image_key, key_to_hex};
use crate::thumbnails::create_thumbnail_buffer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AzureBlobConfig {
    #[serde(rename = "accountName")]
    pub account_name: String,
    #[serde(rename = "accountKey")]
    pub account_key: String,
    #[serde(rename = "containerName")]
    pub container_name: String,
}

#[derive(Clone)]
pub struct AzureBlobAssetStorage {
    config: AzureBlobConfig,
    client: Client,
}

impl AzureBlobAssetStorage {
    pub fn new(config: AzureBlobConfig) -> Self {
        Self {
            config,
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .unwrap_or_default(),
        }
    }

    pub fn config(&self) -> &AzureBlobConfig {
        &self.config
    }

    fn sign_request(
        &self,
        method: &str,
        path: &str,
        content_length: usize,
        content_type: &str,
        date_str: &str,
    ) -> Result<String, String> {
        let key_bytes = BASE64_STANDARD
            .decode(&self.config.account_key)
            .map_err(|e| format!("Invalid base64 account key: {}", e))?;

        let canonicalized_headers = format!("x-ms-date:{}\nx-ms-version:2020-10-02\n", date_str);
        let canonicalized_resource = format!(
            "/{}/{}/{}",
            self.config.account_name,
            self.config.container_name,
            path.trim_start_matches('/')
        );

        let string_to_sign = format!(
            "{}\n\n\n{}\n\n{}\n\n\n\n\n\n\n{}{}",
            method,
            if content_length > 0 {
                content_length.to_string()
            } else {
                String::new()
            },
            content_type,
            canonicalized_headers,
            canonicalized_resource
        );

        let mut mac =
            Hmac::<Sha256>::new_from_slice(&key_bytes).map_err(|e| format!("HMAC error: {}", e))?;
        mac.update(string_to_sign.as_bytes());
        let signature = BASE64_STANDARD.encode(mac.finalize().into_bytes());

        Ok(format!(
            "SharedKey {}:{}",
            self.config.account_name, signature
        ))
    }

    pub async fn read(&self, hex_or_key: &str) -> std::io::Result<Option<AssetReadResult>> {
        let key = hex_to_key(hex_or_key);
        let url = format!(
            "https://{}.blob.core.windows.net/{}/{}",
            self.config.account_name, self.config.container_name, key
        );

        let date_str = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let auth_header = self
            .sign_request("GET", &key, 0, "", &date_str)
            .map_err(std::io::Error::other)?;

        let resp = self
            .client
            .get(&url)
            .header("x-ms-date", &date_str)
            .header("x-ms-version", "2020-10-02")
            .header("Authorization", auth_header)
            .send()
            .await
            .map_err(std::io::Error::other)?;

        if !resp.status().is_success() {
            return Ok(None);
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| get_content_type(&key).to_string());

        let data = resp.bytes().await.map_err(std::io::Error::other)?.to_vec();

        Ok(Some(AssetReadResult {
            content_type,
            content_length: data.len() as u64,
            data,
            file_path: None,
        }))
    }

    pub async fn read_thumbnail(
        &self,
        hex_or_key: &str,
        width: u32,
        height: u32,
    ) -> std::io::Result<Option<AssetReadResult>> {
        let key = hex_to_key(hex_or_key);
        if !is_image_key(&key) {
            return self.read(hex_or_key).await;
        }

        let thumb_key = format!("__thumbs/{}_{}x{}.webp", key_to_hex(&key), width, height);
        if let Ok(Some(thumb)) = self.read(&thumb_key).await {
            return Ok(Some(thumb));
        }

        let original = self.read(hex_or_key).await?;
        let orig = match original {
            Some(o) => o,
            None => return Ok(None),
        };

        if let Some(thumb_data) = create_thumbnail_buffer(&orig.data, width, height) {
            let _ = self.write(&thumb_key, &thumb_data).await;
            return Ok(Some(AssetReadResult {
                content_type: "image/webp".to_string(),
                content_length: thumb_data.len() as u64,
                data: thumb_data,
                file_path: None,
            }));
        }

        Ok(Some(orig))
    }

    pub async fn write(&self, hex_or_key: &str, content: &[u8]) -> std::io::Result<()> {
        let key = hex_to_key(hex_or_key);
        let url = format!(
            "https://{}.blob.core.windows.net/{}/{}",
            self.config.account_name, self.config.container_name, key
        );

        let content_type = get_content_type(&key);
        let date_str = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let auth_header = self
            .sign_request("PUT", &key, content.len(), content_type, &date_str)
            .map_err(std::io::Error::other)?;

        let resp = self
            .client
            .put(&url)
            .header("x-ms-date", &date_str)
            .header("x-ms-version", "2020-10-02")
            .header("x-ms-blob-type", "BlockBlob")
            .header("Content-Type", content_type)
            .header("Authorization", auth_header)
            .body(content.to_vec())
            .send()
            .await
            .map_err(std::io::Error::other)?;

        if !resp.status().is_success() {
            return Err(std::io::Error::other(format!(
                "Azure blob upload failed: {}",
                resp.status()
            )));
        }

        Ok(())
    }

    pub async fn delete(&self, hex_or_key: &str) -> std::io::Result<()> {
        let key = hex_to_key(hex_or_key);
        let url = format!(
            "https://{}.blob.core.windows.net/{}/{}",
            self.config.account_name, self.config.container_name, key
        );

        let date_str = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let auth_header = self
            .sign_request("DELETE", &key, 0, "", &date_str)
            .map_err(std::io::Error::other)?;

        let _ = self
            .client
            .delete(&url)
            .header("x-ms-date", &date_str)
            .header("x-ms-version", "2020-10-02")
            .header("Authorization", auth_header)
            .send()
            .await;

        Ok(())
    }
}
