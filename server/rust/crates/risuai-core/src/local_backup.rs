use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use std::io::{Read, Write};

pub const RAW_HEADER: &[u8] = &[0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7];
pub const COMPRESSED_HEADER: &[u8] = &[0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8];

pub fn create_entry_header(name: &str, size: u32) -> Result<Vec<u8>, String> {
    let normalized = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name);
    let name_bytes = normalized.as_bytes();
    if name_bytes.is_empty() || name_bytes.len() > 1024 * 1024 {
        return Err(format!("Invalid local backup entry name: {}", name));
    }

    let mut header = Vec::with_capacity(8 + name_bytes.len());
    header.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
    header.extend_from_slice(name_bytes);
    header.extend_from_slice(&size.to_le_bytes());
    Ok(header)
}

pub fn compress_deflate(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)?;
    encoder.finish()
}

pub fn decompress_deflate(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut decoder = DeflateDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}
