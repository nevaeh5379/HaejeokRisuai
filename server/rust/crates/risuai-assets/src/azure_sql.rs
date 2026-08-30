use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tiberius::{AuthMethod, Client, Config};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::fs::AssetReadResult;
use crate::mime::{get_content_type, hex_to_key, is_hex, is_image_key, key_to_hex};
use crate::thumbnails::create_thumbnail_buffer;

pub const AZURE_ASSET_SCHEMA_DDL: &str = r#"
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'asset_files')
BEGIN
    CREATE TABLE asset_files (
        asset_key NVARCHAR(512) PRIMARY KEY,
        content VARBINARY(MAX),
        content_type NVARCHAR(128),
        size BIGINT,
        updated_at DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET()
    );
END;
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'asset_thumbnails')
BEGIN
    CREATE TABLE asset_thumbnails (
        thumbnail_key NVARCHAR(512) PRIMARY KEY,
        asset_key NVARCHAR(512),
        content VARBINARY(MAX),
        width INT,
        height INT,
        updated_at DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET()
    );
END;
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AzureSqlAssetConfig {
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub enabled: bool,
}

fn default_port() -> u16 {
    1433
}

impl Default for AzureSqlAssetConfig {
    fn default() -> Self {
        Self {
            server: String::new(),
            database: String::new(),
            user: String::new(),
            password: None,
            port: 1433,
            enabled: false,
        }
    }
}

#[derive(Clone)]
pub struct AzureSqlAssetStorage {
    config: AzureSqlAssetConfig,
    #[allow(dead_code)]
    save_path: PathBuf,
}

impl AzureSqlAssetStorage {
    pub fn new(config: AzureSqlAssetConfig, save_path: impl AsRef<Path>) -> Self {
        Self {
            config,
            save_path: save_path.as_ref().to_path_buf(),
        }
    }

    pub fn config(&self) -> &AzureSqlAssetConfig {
        &self.config
    }

    async fn create_connection(&self) -> Result<Client<Compat<TcpStream>>, String> {
        let mut tiberius_config = Config::new();
        tiberius_config.host(&self.config.server);
        tiberius_config.port(self.config.port);
        tiberius_config.database(&self.config.database);
        tiberius_config.authentication(AuthMethod::sql_server(
            &self.config.user,
            self.config.password.as_deref().unwrap_or(""),
        ));
        tiberius_config.trust_cert();

        let tcp = TcpStream::connect(tiberius_config.get_addr())
            .await
            .map_err(|e| format!("TCP connection failed: {}", e))?;
        tcp.set_nodelay(true).map_err(|e| e.to_string())?;

        let client = Client::connect(tiberius_config, tcp.compat_write())
            .await
            .map_err(|e| format!("Tiberius connect failed: {}", e))?;

        Ok(client)
    }

    pub async fn init(&self) -> Result<(), String> {
        if self.config.server.is_empty() || self.config.database.is_empty() {
            return Err("Azure SQL server and database are required".to_string());
        }

        let mut client = self.create_connection().await?;
        client
            .simple_query(AZURE_ASSET_SCHEMA_DDL)
            .await
            .map_err(|e| format!("Schema initialization failed: {}", e))?;

        Ok(())
    }

    pub async fn read(&self, hex_or_key: &str) -> std::io::Result<Option<AssetReadResult>> {
        let key = hex_to_key(hex_or_key);
        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        let stream = client
            .query(
                "SELECT content, content_type, size FROM asset_files WHERE asset_key = @P1",
                &[&key],
            )
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let row_opt = stream
            .into_row()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        if let Some(row) = row_opt {
            let content: Option<&[u8]> = row.get(0);
            let content_type: Option<&str> = row.get(1);
            let size: Option<i64> = row.get(2);

            let data = content.unwrap_or(&[]).to_vec();
            let ct = content_type
                .unwrap_or_else(|| get_content_type(&key))
                .to_string();
            let cl = size.unwrap_or(data.len() as i64) as u64;

            Ok(Some(AssetReadResult {
                content_type: ct,
                content_length: cl,
                data,
                file_path: None,
            }))
        } else {
            Ok(None)
        }
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

        let thumb_key = format!("{}_{}x{}.webp", key_to_hex(&key), width, height);

        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        let stream = client
            .query(
                "SELECT content FROM asset_thumbnails WHERE thumbnail_key = @P1",
                &[&thumb_key],
            )
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?
        {
            let content: Option<&[u8]> = row.get(0);
            let data = content.unwrap_or(&[]).to_vec();
            return Ok(Some(AssetReadResult {
                content_type: "image/webp".to_string(),
                content_length: data.len() as u64,
                data,
                file_path: None,
            }));
        }

        let original = self.read(hex_or_key).await?;
        let orig = match original {
            Some(o) => o,
            None => return Ok(None),
        };

        if let Some(thumb_data) = create_thumbnail_buffer(&orig.data, width, height) {
            let mut write_client = self
                .create_connection()
                .await
                .map_err(std::io::Error::other)?;

            let w_i32 = width as i32;
            let h_i32 = height as i32;
            let _ = write_client
                .execute(
                    "MERGE asset_thumbnails AS target \
                     USING (SELECT @P1 AS thumbnail_key, @P2 AS asset_key, @P3 AS content, @P4 AS width, @P5 AS height) AS source \
                     ON target.thumbnail_key = source.thumbnail_key \
                     WHEN MATCHED THEN UPDATE SET content = source.content, updated_at = SYSDATETIMEOFFSET() \
                     WHEN NOT MATCHED THEN INSERT (thumbnail_key, asset_key, content, width, height) \
                     VALUES (source.thumbnail_key, source.asset_key, source.content, source.width, source.height);",
                    &[&thumb_key, &key, &thumb_data.as_slice(), &w_i32, &h_i32],
                )
                .await;

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
        let ct = get_content_type(&key);
        let size = content.len() as i64;

        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        client
            .execute(
                "MERGE asset_files AS target \
                 USING (SELECT @P1 AS asset_key, @P2 AS content, @P3 AS content_type, @P4 AS size) AS source \
                 ON target.asset_key = source.asset_key \
                 WHEN MATCHED THEN UPDATE SET content = source.content, content_type = source.content_type, size = source.size, updated_at = SYSDATETIMEOFFSET() \
                 WHEN NOT MATCHED THEN INSERT (asset_key, content, content_type, size) \
                 VALUES (source.asset_key, source.content, source.content_type, source.size);",
                &[&key, &content, &ct, &size],
            )
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        if is_image_key(&key) {
            let hex_name = if is_hex(hex_or_key) {
                hex_or_key.to_string()
            } else {
                key_to_hex(&key)
            };
            let thumb_key = format!("{}_128x128.webp", hex_name);
            if let Some(thumb) = create_thumbnail_buffer(content, 128, 128) {
                let w = 128i32;
                let h = 128i32;
                let _ = client
                    .execute(
                        "MERGE asset_thumbnails AS target \
                         USING (SELECT @P1 AS thumbnail_key, @P2 AS asset_key, @P3 AS content, @P4 AS width, @P5 AS height) AS source \
                         ON target.thumbnail_key = source.thumbnail_key \
                         WHEN MATCHED THEN UPDATE SET content = source.content, updated_at = SYSDATETIMEOFFSET() \
                         WHEN NOT MATCHED THEN INSERT (thumbnail_key, asset_key, content, width, height) \
                         VALUES (source.thumbnail_key, source.asset_key, source.content, source.width, source.height);",
                        &[&thumb_key, &key, &thumb.as_slice(), &w, &h],
                    )
                    .await;
            }
        }

        Ok(())
    }

    pub async fn delete(&self, hex_or_key: &str) -> std::io::Result<()> {
        let key = hex_to_key(hex_or_key);
        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        let _ = client
            .execute("DELETE FROM asset_files WHERE asset_key = @P1", &[&key])
            .await;
        let _ = client
            .execute(
                "DELETE FROM asset_thumbnails WHERE asset_key = @P1",
                &[&key],
            )
            .await;

        Ok(())
    }

    pub async fn list(&self, prefix: &str) -> std::io::Result<Vec<String>> {
        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        let pattern = format!("{}%", prefix);
        let stream = client
            .query(
                "SELECT asset_key FROM asset_files WHERE asset_key LIKE @P1 ORDER BY asset_key ASC",
                &[&pattern],
            )
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let mut keys = Vec::new();
        for row in rows {
            if let Some(k) = row.get::<&str, _>(0) {
                keys.push(k.to_string());
            }
        }

        Ok(keys)
    }

    pub async fn exists(&self, hex_or_key: &str) -> std::io::Result<bool> {
        let key = hex_to_key(hex_or_key);
        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        let stream = client
            .query("SELECT 1 FROM asset_files WHERE asset_key = @P1", &[&key])
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let row_opt = stream
            .into_row()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        Ok(row_opt.is_some())
    }

    pub async fn get_stats(&self) -> std::io::Result<(usize, u64)> {
        let mut client = self
            .create_connection()
            .await
            .map_err(std::io::Error::other)?;

        let stream = client
            .query(
                "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM asset_files",
                &[],
            )
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        if let Some(row) = stream
            .into_row()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?
        {
            let count: i32 = row.get(0).unwrap_or(0);
            let size: i64 = row.get(1).unwrap_or(0);
            Ok((count as usize, size as u64))
        } else {
            Ok((0, 0))
        }
    }
}
