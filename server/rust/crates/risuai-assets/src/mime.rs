pub fn get_content_type(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "apng" => "image/apng",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",

        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "m4v" => "video/x-m4v",
        "ogv" => "video/ogg",

        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "weba" => "audio/webm",

        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",

        "json" => "application/json",
        "txt" => "text/plain",
        "css" => "text/css",
        "bin" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

pub fn is_image_key(key: &str) -> bool {
    let ext = key.rsplit('.').next().unwrap_or("").to_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "apng" | "bmp" | "ico" | "tiff" | "tif"
    )
}

pub fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len().is_multiple_of(2) && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn hex_to_key(hex_str: &str) -> String {
    if is_hex(hex_str) {
        if let Ok(bytes) = hex::decode(hex_str) {
            if let Ok(s) = String::from_utf8(bytes) {
                return s;
            }
        }
    }
    hex_str.to_string()
}

pub fn key_to_hex(key: &str) -> String {
    hex::encode(key.as_bytes())
}
