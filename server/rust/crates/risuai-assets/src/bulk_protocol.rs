use bytes::{Buf, Bytes, BytesMut};

pub fn create_header_packet(file_id: u32, name: &str, file_size: u64) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    let mut packet = Vec::with_capacity(1 + 4 + 4 + name_bytes.len() + 8);
    packet.push(0x01);
    packet.extend_from_slice(&file_id.to_be_bytes());
    packet.extend_from_slice(&(name_bytes.len() as u32).to_be_bytes());
    packet.extend_from_slice(name_bytes);
    packet.extend_from_slice(&file_size.to_be_bytes());
    packet
}

pub fn create_chunk_packet(file_id: u32, data: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(1 + 4 + 4 + data.len());
    packet.push(0x02);
    packet.extend_from_slice(&file_id.to_be_bytes());
    packet.extend_from_slice(&(data.len() as u32).to_be_bytes());
    packet.extend_from_slice(data);
    packet
}

pub fn create_end_packet(file_id: u32) -> Vec<u8> {
    let mut packet = Vec::with_capacity(1 + 4);
    packet.push(0x03);
    packet.extend_from_slice(&file_id.to_be_bytes());
    packet
}

pub enum BulkPacket {
    Header {
        file_id: u32,
        name: String,
        total_size: u64,
    },
    Chunk {
        file_id: u32,
        data: Bytes,
    },
    End {
        file_id: u32,
    },
}

pub struct BulkPacketParser {
    buffer: BytesMut,
}

impl BulkPacketParser {
    pub fn new() -> Self {
        Self {
            buffer: BytesMut::with_capacity(64 * 1024),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    pub fn next_packet(&mut self) -> Result<Option<BulkPacket>, &'static str> {
        if self.buffer.is_empty() {
            return Ok(None);
        }

        let packet_type = self.buffer[0];
        match packet_type {
            0x01 => {
                // Header packet: 1 + 4 + 4 + name_len + 8
                if self.buffer.len() < 1 + 4 + 4 {
                    return Ok(None);
                }
                let file_id = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap());
                let name_len = u32::from_be_bytes(self.buffer[5..9].try_into().unwrap()) as usize;
                let required = 1 + 4 + 4 + name_len + 8;
                if self.buffer.len() < required {
                    return Ok(None);
                }
                let name_bytes = &self.buffer[9..9 + name_len];
                let name =
                    String::from_utf8(name_bytes.to_vec()).map_err(|_| "Invalid UTF-8 name")?;
                let size_offset = 9 + name_len;
                let total_size = u64::from_be_bytes(
                    self.buffer[size_offset..size_offset + 8]
                        .try_into()
                        .unwrap(),
                );
                self.buffer.advance(required);
                Ok(Some(BulkPacket::Header {
                    file_id,
                    name,
                    total_size,
                }))
            }
            0x02 => {
                // Chunk packet: 1 + 4 + 4 + chunk_len
                if self.buffer.len() < 1 + 4 + 4 {
                    return Ok(None);
                }
                let file_id = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap());
                let chunk_len = u32::from_be_bytes(self.buffer[5..9].try_into().unwrap()) as usize;
                let required = 1 + 4 + 4 + chunk_len;
                if self.buffer.len() < required {
                    return Ok(None);
                }
                self.buffer.advance(1 + 4 + 4);
                let data = self.buffer.split_to(chunk_len).freeze();
                Ok(Some(BulkPacket::Chunk { file_id, data }))
            }
            0x03 => {
                // End packet: 1 + 4
                if self.buffer.len() < 1 + 4 {
                    return Ok(None);
                }
                let file_id = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap());
                self.buffer.advance(1 + 4);
                Ok(Some(BulkPacket::End { file_id }))
            }
            _ => Err("Invalid packet type"),
        }
    }
}

impl Default for BulkPacketParser {
    fn default() -> Self {
        Self::new()
    }
}
