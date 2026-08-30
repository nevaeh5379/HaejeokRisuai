use std::path::{Path, PathBuf};
use tokio::fs;

use crate::mime::{get_content_type, hex_to_key, is_hex, is_image_key, key_to_hex};
use crate::thumbnails::create_thumbnail_buffer;

pub struct AssetReadResult {
    pub content_type: String,
    pub content_length: u64,
    pub data: Vec<u8>,
    pub file_path: Option<PathBuf>,
}

#[derive(Clone)]
pub struct LocalFsStorage {
    save_path: PathBuf,
}

impl LocalFsStorage {
    pub fn new(save_path: impl AsRef<Path>) -> Self {
        Self {
            save_path: save_path.as_ref().to_path_buf(),
        }
    }

    pub fn save_path(&self) -> &Path {
        &self.save_path
    }

    fn resolve_path(&self, hex_or_path: &str) -> (String, PathBuf) {
        let key = hex_to_key(hex_or_path);
        let full_path = if self.save_path.join(hex_or_path).exists() {
            self.save_path.join(hex_or_path)
        } else if self.save_path.join(&key).exists() {
            self.save_path.join(&key)
        } else {
            // Default to direct hex or key
            self.save_path.join(hex_or_path)
        };
        (key, full_path)
    }

    pub async fn read(&self, hex_or_path: &str) -> std::io::Result<Option<AssetReadResult>> {
        let (key, full_path) = self.resolve_path(hex_or_path);
        if !full_path.exists() {
            return Ok(None);
        }

        let metadata = fs::metadata(&full_path).await?;
        if !metadata.is_file() {
            return Ok(None);
        }

        let data = fs::read(&full_path).await?;
        let content_type = get_content_type(&key).to_string();

        Ok(Some(AssetReadResult {
            content_type,
            content_length: metadata.len(),
            data,
            file_path: Some(full_path),
        }))
    }

    pub async fn read_thumbnail(
        &self,
        hex_or_path: &str,
        width: u32,
        height: u32,
    ) -> std::io::Result<Option<AssetReadResult>> {
        let (key, _) = self.resolve_path(hex_or_path);
        if !is_image_key(&key) {
            return self.read(hex_or_path).await;
        }

        let hex_name = if is_hex(hex_or_path) {
            hex_or_path.to_string()
        } else {
            key_to_hex(&key)
        };

        let thumb_dir = self.save_path.join("__thumbs");
        let thumb_path = thumb_dir.join(format!("{}_{}x{}.webp", hex_name, width, height));

        if thumb_path.exists() {
            let metadata = fs::metadata(&thumb_path).await?;
            let data = fs::read(&thumb_path).await?;
            return Ok(Some(AssetReadResult {
                content_type: "image/webp".to_string(),
                content_length: metadata.len(),
                data,
                file_path: Some(thumb_path),
            }));
        }

        let original = self.read(hex_or_path).await?;
        let orig = match original {
            Some(o) => o,
            None => return Ok(None),
        };

        if let Some(thumb_data) = create_thumbnail_buffer(&orig.data, width, height) {
            let _ = fs::create_dir_all(&thumb_dir).await;
            let _ = fs::write(&thumb_path, &thumb_data).await;
            return Ok(Some(AssetReadResult {
                content_type: "image/webp".to_string(),
                content_length: thumb_data.len() as u64,
                data: thumb_data,
                file_path: Some(thumb_path),
            }));
        }

        Ok(Some(orig))
    }

    pub async fn write(&self, hex_or_path: &str, content: &[u8]) -> std::io::Result<()> {
        let full_path = self.save_path.join(hex_or_path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&full_path, content).await?;

        let key = hex_to_key(hex_or_path);
        if is_image_key(&key) {
            let hex_name = if is_hex(hex_or_path) {
                hex_or_path.to_string()
            } else {
                key_to_hex(&key)
            };
            let thumb_dir = self.save_path.join("__thumbs");
            if let Some(thumb) = create_thumbnail_buffer(content, 128, 128) {
                let _ = fs::create_dir_all(&thumb_dir).await;
                let _ =
                    fs::write(thumb_dir.join(format!("{}_128x128.webp", hex_name)), thumb).await;
            }
        }
        Ok(())
    }

    pub async fn delete(&self, hex_or_path: &str) -> std::io::Result<()> {
        let (_, full_path) = self.resolve_path(hex_or_path);
        if full_path.exists() {
            fs::remove_file(&full_path).await?;
        }
        let hex_name = if is_hex(hex_or_path) {
            hex_or_path.to_string()
        } else {
            key_to_hex(&hex_to_key(hex_or_path))
        };
        let thumb_dir = self.save_path.join("__thumbs");
        for size in &["128x128", "256x256", "512x512", "64x64"] {
            let p = thumb_dir.join(format!("{}_{}.webp", hex_name, size));
            let _ = fs::remove_file(p).await;
        }
        Ok(())
    }

    pub async fn list(&self, prefix: &str) -> std::io::Result<Vec<String>> {
        let mut results = Vec::new();
        let target_dir = if prefix.is_empty() {
            self.save_path.clone()
        } else {
            self.save_path.join(prefix)
        };

        if !target_dir.exists() {
            return Ok(results);
        }

        let mut stack = vec![target_dir];
        while let Some(current_dir) = stack.pop() {
            let mut entries = match fs::read_dir(&current_dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let file_name = entry.file_name().to_string_lossy().to_string();

                if file_name.starts_with("__") {
                    continue;
                }

                if let Ok(file_type) = entry.file_type().await {
                    if file_type.is_dir() {
                        stack.push(path);
                    } else if file_type.is_file() {
                        if let Ok(rel) = path.strip_prefix(&self.save_path) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            if rel_str.starts_with(prefix) {
                                results.push(rel_str);
                            }
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    pub async fn exists(&self, hex_or_path: &str) -> std::io::Result<bool> {
        let (_, full_path) = self.resolve_path(hex_or_path);
        Ok(full_path.exists())
    }
}
