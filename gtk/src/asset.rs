use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use thiserror::Error;
use uuid::Uuid;

pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_IMAGES_PER_MESSAGE: usize = 8;
pub const MAX_REQUEST_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 1024 * 1024;
const SUPPORTED_EXTENSIONS: [&str; 4] = ["png", "jpg", "gif", "webp"];
static INLAY_TOKEN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"\{\{(inlay|inlayed|inlayeddata)::(.+?)\}\}")
        .expect("the inlay token regex is valid")
});

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InlayToken {
    pub kind: String,
    pub id: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageAsset {
    pub id: String,
    pub path: PathBuf,
    pub mime_type: &'static str,
    pub base64: String,
    pub byte_len: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CleanupReport {
    pub removed_files: usize,
    pub reclaimed_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct AssetStore {
    root: PathBuf,
}

#[derive(Debug, Error)]
pub enum AssetError {
    #[error("이미지 파일을 읽거나 저장하지 못했습니다: {0}")]
    Io(#[from] std::io::Error),
    #[error("첨부 파일은 일반 파일이어야 합니다: {0}")]
    NotRegularFile(PathBuf),
    #[error("첨부 이미지 저장소가 안전한 일반 디렉터리가 아닙니다: {0}")]
    InvalidStoreRoot(PathBuf),
    #[error("빈 이미지는 첨부할 수 없습니다.")]
    EmptyImage,
    #[error("이미지는 최대 {limit_mib} MiB까지 첨부할 수 있습니다: {actual} 바이트")]
    ImageTooLarge { actual: u64, limit_mib: u64 },
    #[error("PNG, JPEG, GIF 또는 WebP 이미지만 첨부할 수 있습니다.")]
    UnsupportedImage,
    #[error("이미지를 디코딩하거나 PNG로 변환하지 못했습니다: {0}")]
    ImageDecode(String),
    #[error("첨부 이미지 ID가 올바르지 않습니다: {0}")]
    InvalidId(String),
    #[error("한 메시지에는 이미지를 최대 {limit}장까지 첨부할 수 있습니다.")]
    TooManyImages { limit: usize },
    #[error("한 요청의 전체 이미지 크기는 최대 {limit_mib} MiB까지 지원합니다.")]
    RequestImagesTooLarge { limit_mib: usize },
    #[error("메시지가 참조하는 첨부 이미지를 찾을 수 없습니다: {0}")]
    Missing(String),
}

impl AssetStore {
    pub fn default_root() -> PathBuf {
        gtk::glib::user_data_dir()
            .join("risuai-native")
            .join("inlays")
    }

    pub fn open_default() -> Result<Self, AssetError> {
        Self::open(Self::default_root())
    }

    pub fn open(root: impl AsRef<Path>) -> Result<Self, AssetError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        let metadata = fs::symlink_metadata(&root)?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(AssetError::InvalidStoreRoot(root));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { root })
    }

    pub fn import_image(&self, source: impl AsRef<Path>) -> Result<ImageAsset, AssetError> {
        self.ensure_safe_root()?;
        let source = source.as_ref();
        let metadata = fs::metadata(source)?;
        if !metadata.is_file() {
            return Err(AssetError::NotRegularFile(source.to_path_buf()));
        }
        validate_size(metadata.len())?;

        let mut file = File::open(source)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes)?;
        validate_size(bytes.len() as u64)?;
        identify_image(&bytes)?;
        let mut decode_source = tempfile::Builder::new()
            .prefix(".inlay-source-")
            .tempfile_in(&self.root)?;
        decode_source.write_all(&bytes)?;
        decode_source.as_file().sync_all()?;
        let (_, width, height) = gtk::gdk_pixbuf::Pixbuf::file_info(decode_source.path())
            .filter(|(_, width, height)| *width > 0 && *height > 0)
            .ok_or(AssetError::UnsupportedImage)?;
        let (target_width, target_height) = bounded_dimensions(width, height);
        let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_file_at_scale(
            decode_source.path(),
            target_width,
            target_height,
            true,
        )
        .map_err(|error| AssetError::ImageDecode(error.to_string()))?;
        let normalized = pixbuf
            .save_to_bufferv("png", &[])
            .map_err(|error| AssetError::ImageDecode(error.to_string()))?;
        validate_size(normalized.len() as u64)?;

        for _ in 0..4 {
            let id = Uuid::new_v4().to_string();
            let destination = self.root.join(format!("{id}.png"));
            let mut staged = tempfile::Builder::new()
                .prefix(".inlay-")
                .tempfile_in(&self.root)?;
            staged.write_all(&normalized)?;
            staged.as_file().sync_all()?;
            match staged.persist_noclobber(&destination) {
                Ok(_) => {
                    return Ok(ImageAsset {
                        id,
                        path: destination,
                        mime_type: "image/png",
                        base64: BASE64.encode(&normalized),
                        byte_len: normalized.len(),
                    });
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(AssetError::Io(error.error)),
            }
        }
        Err(AssetError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "고유한 첨부 이미지 ID를 만들지 못했습니다.",
        )))
    }

    pub fn load_image(&self, id: &str) -> Result<ImageAsset, AssetError> {
        self.ensure_safe_root()?;
        validate_id(id)?;
        let Some(path) = SUPPORTED_EXTENSIONS
            .iter()
            .map(|extension| self.root.join(format!("{id}.{extension}")))
            .find(|path| path.exists())
        else {
            return Err(AssetError::Missing(id.to_owned()));
        };
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(AssetError::NotRegularFile(path));
        }
        validate_size(metadata.len())?;
        let bytes = fs::read(&path)?;
        validate_size(bytes.len() as u64)?;
        let (_, mime_type) = identify_image(&bytes)?;
        Ok(ImageAsset {
            id: id.to_owned(),
            path,
            mime_type,
            base64: BASE64.encode(bytes),
            byte_len: metadata.len() as usize,
        })
    }

    pub fn find_path(&self, id: &str) -> Result<PathBuf, AssetError> {
        self.ensure_safe_root()?;
        validate_id(id)?;
        let Some(path) = SUPPORTED_EXTENSIONS
            .iter()
            .map(|extension| self.root.join(format!("{id}.{extension}")))
            .find(|path| path.exists())
        else {
            return Err(AssetError::Missing(id.to_owned()));
        };
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(AssetError::NotRegularFile(path));
        }
        validate_size(metadata.len())?;
        Ok(path)
    }

    pub fn remove(&self, id: &str) -> Result<(), AssetError> {
        self.ensure_safe_root()?;
        validate_id(id)?;
        for extension in SUPPORTED_EXTENSIONS {
            let path = self.root.join(format!("{id}.{extension}"));
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(AssetError::Io(error)),
            }
        }
        Ok(())
    }

    pub fn cleanup_orphans(
        &self,
        referenced: &HashSet<String>,
        protected: &HashSet<String>,
    ) -> Result<CleanupReport, AssetError> {
        self.ensure_safe_root()?;
        let mut candidates = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
                continue;
            };
            if !SUPPORTED_EXTENSIONS.contains(&extension) {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if validate_id(id).is_err() || referenced.contains(id) || protected.contains(id) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(AssetError::NotRegularFile(path));
            }
            candidates.push((path, metadata.len()));
        }
        let mut report = CleanupReport::default();
        for (path, size) in candidates {
            fs::remove_file(path)?;
            report.removed_files += 1;
            report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(size);
        }
        Ok(report)
    }

    fn ensure_safe_root(&self) -> Result<(), AssetError> {
        let metadata = fs::symlink_metadata(&self.root)?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(AssetError::InvalidStoreRoot(self.root.clone()));
        }
        Ok(())
    }
}

pub fn inlay_tokens(content: &str) -> Vec<InlayToken> {
    INLAY_TOKEN
        .captures_iter(content)
        .map(|capture| {
            let token = capture.get(0).expect("capture zero always exists");
            InlayToken {
                kind: capture.get(1).expect("inlay kind exists").as_str().into(),
                id: capture.get(2).expect("inlay ID exists").as_str().into(),
                start: token.start(),
                end: token.end(),
            }
        })
        .collect()
}

pub fn without_inlay_tokens(content: &str) -> String {
    INLAY_TOKEN.replace_all(content, "").trim().to_owned()
}

pub fn inlay_tokens_as_placeholder(content: &str) -> String {
    INLAY_TOKEN.replace_all(content, "[Image]").into_owned()
}

fn validate_id(id: &str) -> Result<(), AssetError> {
    match Uuid::parse_str(id) {
        Ok(uuid) if uuid.get_version_num() == 4 => Ok(()),
        _ => Err(AssetError::InvalidId(id.to_owned())),
    }
}

fn validate_size(size: u64) -> Result<(), AssetError> {
    if size == 0 {
        return Err(AssetError::EmptyImage);
    }
    if size > MAX_IMAGE_BYTES {
        return Err(AssetError::ImageTooLarge {
            actual: size,
            limit_mib: MAX_IMAGE_BYTES / 1024 / 1024,
        });
    }
    Ok(())
}

fn identify_image(bytes: &[u8]) -> Result<(&'static str, &'static str), AssetError> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(("gif", "image/gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Ok(("webp", "image/webp"))
    } else {
        Err(AssetError::UnsupportedImage)
    }
}

fn bounded_dimensions(width: i32, height: i32) -> (i32, i32) {
    let pixels = (width as u64).saturating_mul(height as u64);
    if pixels <= MAX_IMAGE_PIXELS {
        return (width, height);
    }
    let scale = (MAX_IMAGE_PIXELS as f64 / pixels as f64).sqrt();
    (
        ((width as f64 * scale).floor() as i32).max(1),
        ((height as f64 * scale).floor() as i32).max(1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        BASE64
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap()
    }

    #[test]
    fn image_import_round_trips_by_compatible_uuid_and_sniffed_mime() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("misleading.txt");
        fs::write(&source, png()).unwrap();
        let store = AssetStore::open(directory.path().join("assets")).unwrap();

        let imported = store.import_image(&source).unwrap();
        assert_eq!(imported.mime_type, "image/png");
        assert!(Uuid::parse_str(&imported.id).is_ok());
        assert!(!imported.base64.is_empty());
        assert_eq!(store.load_image(&imported.id).unwrap(), imported);
        store.remove(&imported.id).unwrap();
        assert!(matches!(
            store.load_image(&imported.id),
            Err(AssetError::Missing(_))
        ));
    }

    #[test]
    fn oversized_dimensions_are_scaled_to_the_original_one_megapixel_boundary() {
        assert_eq!(bounded_dimensions(1024, 1024), (1024, 1024));
        let (width, height) = bounded_dimensions(4096, 2048);
        assert!(width > height);
        assert!((width as u64) * (height as u64) <= MAX_IMAGE_PIXELS);
    }

    #[test]
    fn unsupported_empty_oversized_and_invalid_ids_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = AssetStore::open(directory.path().join("assets")).unwrap();
        let unsupported = directory.path().join("not-image.png");
        fs::write(&unsupported, b"plain text").unwrap();
        assert!(matches!(
            store.import_image(&unsupported),
            Err(AssetError::UnsupportedImage)
        ));
        let empty = directory.path().join("empty.png");
        fs::write(&empty, []).unwrap();
        assert!(matches!(
            store.import_image(&empty),
            Err(AssetError::EmptyImage)
        ));
        assert!(matches!(
            store.load_image("../../escape"),
            Err(AssetError::InvalidId(_))
        ));
        assert!(matches!(
            validate_size(MAX_IMAGE_BYTES + 1),
            Err(AssetError::ImageTooLarge { .. })
        ));
    }

    #[test]
    fn compatible_inlay_tokens_are_found_and_removed_without_touching_other_templates() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let content = format!("before {{{{inlayed::{id}}}}} after {{{{char}}}}");
        let tokens = inlay_tokens(&content);
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, "inlayed");
        assert_eq!(tokens[0].id, id);
        assert_eq!(without_inlay_tokens(&content), "before  after {{char}}");
        assert_eq!(
            inlay_tokens_as_placeholder(&content),
            "before [Image] after {{char}}"
        );
    }

    #[test]
    fn cleanup_removes_only_unreferenced_and_unprotected_native_assets() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.png");
        fs::write(&source, png()).unwrap();
        let store = AssetStore::open(directory.path().join("assets")).unwrap();
        let referenced = store.import_image(&source).unwrap();
        let protected = store.import_image(&source).unwrap();
        let orphan = store.import_image(&source).unwrap();
        let referenced_ids = HashSet::from([referenced.id.clone()]);
        let protected_ids = HashSet::from([protected.id.clone()]);

        let report = store
            .cleanup_orphans(&referenced_ids, &protected_ids)
            .unwrap();
        assert_eq!(report.removed_files, 1);
        assert!(report.reclaimed_bytes > 0);
        assert!(store.find_path(&referenced.id).is_ok());
        assert!(store.find_path(&protected.id).is_ok());
        assert!(matches!(
            store.find_path(&orphan.id),
            Err(AssetError::Missing(_))
        ));
    }

    #[test]
    fn remove_deletes_every_supported_file_with_the_same_asset_id() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.png");
        fs::write(&source, png()).unwrap();
        let store = AssetStore::open(directory.path().join("assets")).unwrap();
        let image = store.import_image(&source).unwrap();
        let duplicate = store.root.join(format!("{}.jpg", image.id));
        fs::copy(&image.path, &duplicate).unwrap();

        store.remove(&image.id).unwrap();
        assert!(!image.path.exists());
        assert!(!duplicate.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_redirect_the_asset_store_root() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = directory.path().join("link");
        symlink(&real, &link).unwrap();
        assert!(matches!(
            AssetStore::open(link),
            Err(AssetError::InvalidStoreRoot(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn replacing_an_open_store_root_with_a_symlink_is_detected_before_access() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("assets");
        let store = AssetStore::open(&root).unwrap();
        let moved = directory.path().join("moved-assets");
        fs::rename(&root, &moved).unwrap();
        symlink(&moved, &root).unwrap();

        assert!(matches!(
            store.cleanup_orphans(&HashSet::new(), &HashSet::new()),
            Err(AssetError::InvalidStoreRoot(_))
        ));
    }
}
