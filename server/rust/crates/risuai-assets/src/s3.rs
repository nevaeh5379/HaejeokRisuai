use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{Builder, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use serde::{Deserialize, Serialize};

use crate::fs::AssetReadResult;
use crate::mime::{get_content_type, hex_to_key, is_image_key, key_to_hex};
use crate::thumbnails::create_thumbnail_buffer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Config {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_bucket")]
    pub bucket: String,
    #[serde(rename = "accessKeyId", default)]
    pub access_key_id: String,
    #[serde(rename = "secretAccessKey", default)]
    pub secret_access_key: String,
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(rename = "forcePathStyle", default = "default_true")]
    pub force_path_style: bool,
    #[serde(rename = "autoCreateBucket", default = "default_true")]
    pub auto_create_bucket: bool,
}

fn default_bucket() -> String {
    "risuai-assets".to_string()
}
fn default_region() -> String {
    "us-east-1".to_string()
}
fn default_true() -> bool {
    true
}

impl Default for S3Config {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: String::new(),
            bucket: default_bucket(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            region: default_region(),
            force_path_style: true,
            auto_create_bucket: true,
        }
    }
}

#[derive(Clone)]
pub struct S3AssetStorage {
    config: S3Config,
    client: Client,
}

impl S3AssetStorage {
    pub fn new(config: S3Config) -> Self {
        let creds = Credentials::new(
            config.access_key_id.clone(),
            config.secret_access_key.clone(),
            None,
            None,
            "risuai-s3",
        );

        let mut builder = Builder::new()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(creds)
            .region(Region::new(config.region.clone()))
            .force_path_style(config.force_path_style);

        if !config.endpoint.is_empty() {
            builder = builder.endpoint_url(&config.endpoint);
        }

        let sdk_config = builder.build();
        let client = Client::from_conf(sdk_config);

        Self { config, client }
    }

    pub fn config(&self) -> &S3Config {
        &self.config
    }

    pub async fn init(&self) -> Result<(), String> {
        if self.config.bucket.is_empty() {
            return Err("S3 bucket name cannot be empty".to_string());
        }

        let head_res = self
            .client
            .head_bucket()
            .bucket(&self.config.bucket)
            .send()
            .await;

        if head_res.is_err() && self.config.auto_create_bucket {
            let create_res = self
                .client
                .create_bucket()
                .bucket(&self.config.bucket)
                .send()
                .await;
            if let Err(e) = create_res {
                tracing::warn!("Failed to auto-create S3 bucket: {:?}", e);
            }
        }
        Ok(())
    }

    fn normalize_key(hex_or_key: &str) -> String {
        hex_to_key(hex_or_key)
    }

    pub async fn read(&self, hex_or_key: &str) -> std::io::Result<Option<AssetReadResult>> {
        let key = Self::normalize_key(hex_or_key);
        let resp_res = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await;

        match resp_res {
            Ok(output) => {
                let content_type = output
                    .content_type()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| get_content_type(&key).to_string());

                let body_bytes = output
                    .body
                    .collect()
                    .await
                    .map_err(std::io::Error::other)?
                    .into_bytes();

                Ok(Some(AssetReadResult {
                    content_type,
                    content_length: body_bytes.len() as u64,
                    data: body_bytes.to_vec(),
                    file_path: None,
                }))
            }
            Err(_) => Ok(None),
        }
    }

    pub async fn read_thumbnail(
        &self,
        hex_or_key: &str,
        width: u32,
        height: u32,
    ) -> std::io::Result<Option<AssetReadResult>> {
        let key = Self::normalize_key(hex_or_key);
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
        let key = Self::normalize_key(hex_or_key);
        let content_type = get_content_type(&key);

        self.client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .content_type(content_type)
            .body(ByteStream::from(content.to_vec()))
            .send()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        if is_image_key(&key) && !key.starts_with("__thumbs/") {
            let thumb_key = format!("__thumbs/{}_128x128.webp", key_to_hex(&key));
            if let Some(thumb) = create_thumbnail_buffer(content, 128, 128) {
                let _ = self
                    .client
                    .put_object()
                    .bucket(&self.config.bucket)
                    .key(&thumb_key)
                    .content_type("image/webp")
                    .body(ByteStream::from(thumb))
                    .send()
                    .await;
            }
        }

        Ok(())
    }

    pub async fn delete(&self, hex_or_key: &str) -> std::io::Result<()> {
        let key = Self::normalize_key(hex_or_key);
        self.client
            .delete_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let hex_name = key_to_hex(&key);
        for size in &["128x128", "256x256", "512x512", "64x64"] {
            let thumb_key = format!("__thumbs/{}_{}.webp", hex_name, size);
            let _ = self
                .client
                .delete_object()
                .bucket(&self.config.bucket)
                .key(&thumb_key)
                .send()
                .await;
        }

        Ok(())
    }

    pub async fn list(&self, prefix: &str) -> std::io::Result<Vec<String>> {
        let mut results = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.config.bucket)
                .prefix(prefix);

            if let Some(token) = continuation_token {
                req = req.continuation_token(token);
            }

            let output = req
                .send()
                .await
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            if let Some(contents) = output.contents {
                for obj in contents {
                    if let Some(key) = obj.key {
                        if !key.starts_with("__") {
                            results.push(key);
                        }
                    }
                }
            }

            if output.is_truncated.unwrap_or(false) {
                continuation_token = output.next_continuation_token;
            } else {
                break;
            }
        }

        Ok(results)
    }

    pub async fn exists(&self, hex_or_key: &str) -> std::io::Result<bool> {
        let key = Self::normalize_key(hex_or_key);
        let res = self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await;
        Ok(res.is_ok())
    }

    pub async fn get_stats(&self) -> std::io::Result<(usize, u64)> {
        let mut count = 0;
        let mut size = 0u64;
        let mut continuation_token = None;

        loop {
            let mut req = self.client.list_objects_v2().bucket(&self.config.bucket);

            if let Some(token) = continuation_token {
                req = req.continuation_token(token);
            }

            let output = req
                .send()
                .await
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            if let Some(contents) = output.contents {
                for obj in contents {
                    count += 1;
                    size += obj.size.unwrap_or(0) as u64;
                }
            }

            if output.is_truncated.unwrap_or(false) {
                continuation_token = output.next_continuation_token;
            } else {
                break;
            }
        }

        Ok((count, size))
    }
}
