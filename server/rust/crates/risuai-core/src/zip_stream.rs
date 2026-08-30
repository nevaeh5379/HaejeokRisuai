use std::io::Write;
use zip::write::{SimpleFileOptions, ZipWriter};

pub struct InMemoryZip {
    writer: ZipWriter<std::io::Cursor<Vec<u8>>>,
}

impl InMemoryZip {
    pub fn new() -> Self {
        Self {
            writer: ZipWriter::new(std::io::Cursor::new(Vec::new())),
        }
    }

    pub fn add_file(&mut self, name: &str, data: &[u8]) -> std::io::Result<()> {
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        self.writer.start_file(name, options)?;
        self.writer.write_all(data)?;
        Ok(())
    }

    pub fn finish(self) -> std::io::Result<Vec<u8>> {
        let cursor = self.writer.finish()?;
        Ok(cursor.into_inner())
    }
}

impl Default for InMemoryZip {
    fn default() -> Self {
        Self::new()
    }
}
